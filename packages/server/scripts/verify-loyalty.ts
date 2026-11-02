/** Loyalty uses the real billing/payment/refund transactions against disposable SQLite. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BillingResponse,
  InvoiceDto,
  LoginResponse,
  LoyaltyProgram,
  LoyaltyStatement,
  OrderLoyaltyResponse,
  OrderResponse,
  SendToKitchenResponse,
} from '@nayaro/shared';
import { startNayaroServer, stopNayaroServer } from '../src/server';
import { registerTenant } from '../src/modules/tenant/tenant.service';
import { hashPassword } from '../src/modules/auth/password';
const root = mkdtempSync(join(tmpdir(), 'nayaro-loyalty-'));
let handle: Awaited<ReturnType<typeof startNayaroServer>> | undefined;
let checks = 0;
async function call<T>(
  method: string,
  path: string,
  status: number,
  token?: string,
  body?: unknown,
  key?: string,
): Promise<T> {
  const response = await fetch(`${handle!.baseUrl}${path}`, {
    method,
    headers: {
      Connection: 'close',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.equal(response.status, status, `${method} ${path}: ${text}`);
  checks++;
  return (text ? JSON.parse(text) : null) as T;
}
try {
  const start = () =>
    startNayaroServer({
      host: '127.0.0.1',
      port: 4357,
      databaseFilePath: join(root, 'data.db'),
      silent: true,
    });
  handle = await start();
  const { prisma } = handle;
  const { restaurantId } = await registerTenant(prisma, {
    restaurant: { slug: 'verify-restaurant', name: 'Loyalty restaurant' },
    owner: { name: 'Owner', username: 'owner', password: 'loyalty-test-password' },
  });
  const login = async (username: string) =>
    (
      await call<LoginResponse>('POST', '/auth/login', 200, undefined, {
        workspace: 'verify-restaurant', username,
        password: 'loyalty-test-password',
      })
    ).token;
  const owner = await login('owner');
  const tokens: Record<string, string> = {};
  for (const role of ['MANAGER', 'CASHIER', 'WAITER', 'KITCHEN'] as const) {
    await prisma.staff.create({
      data: {
        restaurantId,
        name: role,
        username: role.toLowerCase(),
        role,
        passwordHash: await hashPassword('loyalty-test-password'),
      },
    });
    tokens[role] = await login(role.toLowerCase());
  }
  const customer = await prisma.customer.create({
    data: { restaurantId, name: 'Member', phone: '9800000001' },
  });
  const category = await prisma.menuCategory.create({ data: { restaurantId, name: 'Meals' } });
  const dish = await prisma.menuItem.create({
    data: { restaurantId, categoryId: category.id, name: 'Meal', pricePaisa: 100000 },
  });
  const settings = {
    enabled: true,
    earnEveryPaisa: 10000,
    pointValuePaisa: 100,
    expectedVersion: 0,
  };
  assert.equal((await call<LoyaltyProgram>('GET', '/loyalty/settings', 200, owner)).enabled, false);
  await call('GET', '/loyalty/settings', 401);
  for (const role of ['MANAGER', 'CASHIER', 'WAITER', 'KITCHEN'])
    await call('PATCH', '/loyalty/settings', 403, tokens[role], settings);
  for (const role of ['WAITER', 'KITCHEN'])
    await call('GET', `/customers/${customer.id}/loyalty`, 403, tokens[role]);
  await call('PATCH', '/loyalty/settings', 400, owner, { ...settings, earnEveryPaisa: 0 });
  await call('PATCH', '/loyalty/settings', 200, owner, settings);
  await call('PATCH', '/loyalty/settings', 409, owner, settings);
  const statement = () =>
    call<LoyaltyStatement>('GET', `/customers/${customer.id}/loyalty`, 200, tokens['CASHIER']);
  const fresh = async (points = 0) => {
    let { order } = await call<OrderResponse>('POST', '/orders/items', 201, tokens['WAITER'], {
      target: { kind: 'TAKEAWAY' },
      menuItemId: dish.id,
    });
    const selected = await call<OrderLoyaltyResponse>(
      'POST',
      `/orders/${order.id}/loyalty`,
      200,
      tokens['CASHIER'],
      { expectedOrderVersion: order.version, customerId: customer.id, points },
    );
    ({ order } = await call<OrderResponse>('GET', `/orders/${order.id}`, 200, owner));
    const sent = await call<SendToKitchenResponse>(
      'POST',
      `/orders/${order.id}/send-kot`,
      201,
      tokens['WAITER'],
      { expectedVersion: order.version },
    );
    return { order: sent.order, selected };
  };
  const issue = async (order: OrderResponse['order']) =>
    (
      await call<{ invoice: InvoiceDto }>(
        'POST',
        `/orders/${order.id}/invoice`,
        201,
        tokens['CASHIER'],
        { expectedVersion: order.version },
      )
    ).invoice;
  const pay = async (invoice: InvoiceDto, amountPaisa: number, method = 'QR', key?: string) =>
    (
      await call<{ invoice: InvoiceDto }>(
        'POST',
        `/invoices/${invoice.id}/payments`,
        201,
        tokens['CASHIER'],
        {
          expectedOrderVersion: invoice.orderVersion,
          method,
          amountPaisa,
          ...(method === 'CREDIT' ? { customerId: customer.id } : {}),
        },
        key,
      )
    ).invoice;
  const first = await fresh();
  const firstBill = await issue(first.order);
  let paid = await pay(firstBill, 40000);
  assert.equal((await statement()).balancePoints, 0); // No earn on a partial payment.
  await call('POST', `/payments/${paid.settlement.payments[0]!.id}/void`, 200, owner, {
    reason: 'Wrong payment method',
  });
  paid = (await call<BillingResponse>('GET', `/orders/${first.order.id}/billing`, 200, owner))
    .invoice!;
  assert.equal((await statement()).balancePoints, 0);
  const finalKey = 'loyalty-settlement-0001';
  const finalInput = { expectedOrderVersion: paid.orderVersion, method: 'QR', amountPaisa: 100000 };
  paid = (
    await call<{ invoice: InvoiceDto }>(
      'POST',
      `/invoices/${paid.id}/payments`,
      201,
      tokens['CASHIER'],
      finalInput,
      finalKey,
    )
  ).invoice;
  await call('POST', `/invoices/${paid.id}/payments`, 201, tokens['CASHIER'], finalInput, finalKey);
  assert.equal((await statement()).balancePoints, 10);
  assert.equal(paid.loyalty!.pointsEarned, 10);
  assert.equal(await prisma.loyaltyEntry.count(), 1);

  // Selecting is a quote. Two bills may quote the same balance; issue must prevent double-spending.
  const rewardA = await fresh(8),
    rewardB = await fresh(8);
  assert.equal((await statement()).balancePoints, 10);
  const rewardBill = await issue(rewardA.order);
  assert.equal(rewardBill.discount.amountPaisa, 800);
  assert.equal(rewardBill.loyalty!.pointsRedeemed, 8);
  assert.equal((await statement()).balancePoints, 2);
  await call('POST', `/orders/${rewardB.order.id}/invoice`, 409, tokens['CASHIER'], {
    expectedVersion: rewardB.order.version,
  });
  assert.equal(await prisma.invoice.count(), 2);
  await call('POST', `/invoices/${rewardBill.id}/void`, 200, owner, {
    reason: 'Bill needs correction',
  });
  assert.equal((await statement()).balancePoints, 10);
  const reopened = (await call<OrderResponse>('GET', `/orders/${rewardA.order.id}`, 200, owner))
    .order;
  const reissued = await issue(reopened);
  assert.equal((await statement()).balancePoints, 2);
  const rewardPaid = await pay(reissued, reissued.grandTotalPaisa);
  assert.equal(rewardPaid.grandTotalPaisa, 99200);
  assert.equal(rewardPaid.loyalty!.pointsEarned, 9);
  assert.equal((await statement()).balancePoints, 11);

  // Spend earned points elsewhere, then refund their source: debt is permitted and refunds still work.
  const spent = await fresh(10);
  const spentInvoice = await issue(spent.order);
  assert.equal((await statement()).balancePoints, 1);
  const sourcePayment = paid.settlement.payments.find((row) => row.void === null)!;
  const refundInput = {
    amountPaisa: sourcePayment.amountPaisa,
    expectedRefundedPaisa: 0,
    reason: 'Refund source purchase after rewards were spent',
  };
  await call(
    'POST',
    `/payments/${sourcePayment.id}/refunds`,
    201,
    owner,
    refundInput,
    'loyalty-source-refund-0001',
  );
  await call(
    'POST',
    `/payments/${sourcePayment.id}/refunds`,
    201,
    owner,
    refundInput,
    'loyalty-source-refund-0001',
  );
  assert.equal((await statement()).balancePoints, -9);
  const debtOrder = (
    await call<OrderResponse>('POST', '/orders/items', 201, tokens['WAITER'], {
      target: { kind: 'TAKEAWAY' },
      menuItemId: dish.id,
    })
  ).order;
  await call('POST', `/orders/${debtOrder.id}/loyalty`, 200, tokens['CASHIER'], {
    expectedOrderVersion: debtOrder.version,
    customerId: customer.id,
    points: 0,
  });
  await call('POST', `/orders/${rewardB.order.id}/invoice`, 409, tokens['CASHIER'], {
    expectedVersion: rewardB.order.version,
  });

  // Partial refunds of a redeemed bill reverse earned points and restore redeemed points cumulatively.
  const rewardPayment = rewardPaid.settlement.payments[0]!;
  await call('PATCH', '/loyalty/settings', 200, owner, {
    enabled: false,
    earnEveryPaisa: 50000,
    pointValuePaisa: 500,
    expectedVersion: 1,
  });
  await call(
    'POST',
    `/payments/${rewardPayment.id}/refunds`,
    201,
    owner,
    { amountPaisa: 49600, expectedRefundedPaisa: 0, reason: 'Half purchase returned' },
    'loyalty-reward-refund-0001',
  );
  let refundBill = (
    await call<BillingResponse>('GET', `/orders/${rewardA.order.id}/billing`, 200, owner)
  ).invoice!;
  assert.equal(refundBill.loyalty!.pointsEarned, 4);
  assert.equal(refundBill.loyalty!.pointsReturned, 4);
  await call(
    'POST',
    `/payments/${rewardPayment.id}/refunds`,
    201,
    owner,
    { amountPaisa: 49600, expectedRefundedPaisa: 49600, reason: 'Remaining purchase returned' },
    'loyalty-reward-refund-0002',
  );
  refundBill = (
    await call<BillingResponse>('GET', `/orders/${rewardA.order.id}/billing`, 200, owner)
  ).invoice!;
  assert.equal(refundBill.loyalty!.pointsEarned, 0);
  assert.equal(refundBill.loyalty!.pointsReturned, 8);
  assert.equal((await statement()).balancePoints, -10);
  // A void returns points even with loyalty disabled; a new reward is blocked until re-enabled.
  await call('POST', `/invoices/${spentInvoice.id}/void`, 200, owner, {
    reason: 'Return unused reward',
  });
  assert.equal((await statement()).balancePoints, 0);
  await call('POST', `/orders/${rewardB.order.id}/invoice`, 409, tokens['CASHIER'], {
    expectedVersion: rewardB.order.version,
  });
  await call('POST', `/orders/${rewardB.order.id}/loyalty`, 200, tokens['CASHIER'], {
    expectedOrderVersion: rewardB.order.version,
    customerId: null,
    points: 0,
  });
  await call('PATCH', '/loyalty/settings', 200, owner, { ...settings, expectedVersion: 2 });
  const creditOrder = await fresh();
  const creditBill = await issue(creditOrder.order);
  const creditPaid = await pay(creditBill, creditBill.grandTotalPaisa, 'CREDIT');
  assert.equal(creditPaid.loyalty!.pointsEarned, 0);
  assert.equal((await statement()).balancePoints, 0);
  const mixed = await fresh();
  let mixedBill = await issue(mixed.order);
  mixedBill = await pay(mixedBill, 45000, 'QR');
  mixedBill = await pay(mixedBill, 55000, 'CREDIT');
  assert.equal(mixedBill.loyalty!.pointsEarned, 4);
  assert.equal((await statement()).balancePoints, 4);

  // Manual discounts and points are mutually exclusive; inactive/cross-restaurant accounts cannot be selected.
  const manual = await fresh();
  const { preBill } = await call<BillingResponse>(
    'PATCH',
    `/orders/${manual.order.id}/discount`,
    200,
    owner,
    { expectedVersion: manual.order.version, discountType: 'PERCENT', discountValue: 1000 },
  );
  await call('POST', `/orders/${manual.order.id}/loyalty`, 409, tokens['CASHIER'], {
    expectedOrderVersion: preBill!.orderVersion,
    customerId: customer.id,
    points: 1,
  });
  const reward = await fresh(1);
  await call('PATCH', `/orders/${reward.order.id}/discount`, 409, owner, {
    expectedVersion: reward.order.version,
    discountType: 'NONE',
  });
  const other = await prisma.restaurant.create({
    data: { name: 'Other', address: '', phone: '', panNumber: '' },
  });
  const foreign = await prisma.customer.create({
    data: { restaurantId: other.id, name: 'Foreign' },
  });
  await call('GET', `/customers/${foreign.id}/loyalty`, 404, owner);
  await call('POST', `/orders/${reward.order.id}/loyalty`, 404, tokens['CASHIER'], {
    expectedOrderVersion: reward.order.version,
    customerId: foreign.id,
    points: 0,
  });
  await call('POST', `/orders/${reward.order.id}/loyalty`, 409, tokens['CASHIER'], {
    expectedOrderVersion: reward.order.version,
    customerId: customer.id,
    points: 100,
  });
  await call('GET', `/customers/${customer.id}/loyalty`, 401);
  // Reward-only sales have no monetary payment. Managers return points through an audited correction.
  await call('PATCH', '/loyalty/settings', 200, owner, {
    enabled: true,
    earnEveryPaisa: 10000,
    pointValuePaisa: 50000,
    expectedVersion: 3,
  });
  const allReward = await fresh(2);
  const zeroBill = await issue(allReward.order);
  assert.equal(zeroBill.grandTotalPaisa, 0);
  const settledZero = (
    await call<{ invoice: InvoiceDto }>(
      'POST',
      `/invoices/${zeroBill.id}/settle`,
      201,
      tokens['CASHIER'],
      { expectedOrderVersion: zeroBill.orderVersion },
    )
  ).invoice;
  assert.equal(settledZero.loyalty!.pointsEarned, 0);
  assert.equal(settledZero.settlement.status, 'PAID');
  assert.equal(await prisma.payment.count({ where: { invoiceId: zeroBill.id } }), 0);
  assert.equal(
    (await call<OrderLoyaltyResponse>('GET', `/orders/${allReward.order.id}/loyalty`, 200, owner))
      .rewardOnlyInvoiceId,
    zeroBill.id,
  );
  const returnInput = {
    expectedOrderVersion: settledZero.orderVersion,
    reason: 'Reward-only meal returned',
  };
  await call(
    'POST',
    `/invoices/${zeroBill.id}/loyalty-return`,
    403,
    tokens['CASHIER'],
    returnInput,
    'loyalty-only-return-0001',
  );
  await call(
    'POST',
    `/invoices/${zeroBill.id}/loyalty-return`,
    200,
    tokens['MANAGER'],
    returnInput,
    'loyalty-only-return-0001',
  );
  await call(
    'POST',
    `/invoices/${zeroBill.id}/loyalty-return`,
    200,
    tokens['MANAGER'],
    returnInput,
    'loyalty-only-return-0001',
  );
  await call(
    'POST',
    `/invoices/${zeroBill.id}/loyalty-return`,
    409,
    tokens['MANAGER'],
    returnInput,
    'loyalty-only-return-0002',
  );
  assert.equal((await statement()).balancePoints, 4);
  assert((await statement()).entries.some((row) => row.reason === 'Reward-only meal returned'));
  assert.equal(
    (await call<OrderLoyaltyResponse>('GET', `/orders/${allReward.order.id}/loyalty`, 200, owner))
      .rewardOnlyInvoiceId,
    null,
  );
  await call(
    'POST',
    `/invoices/${firstBill.id}/loyalty-return`,
    409,
    owner,
    { expectedOrderVersion: paid.orderVersion, reason: 'Wrong bill type' },
    'loyalty-only-return-0003',
  );

  // Two terminals trying to spend three of four available points produce one issued bill.
  await call('PATCH', '/loyalty/settings', 200, owner, {
    enabled: true,
    earnEveryPaisa: 10000,
    pointValuePaisa: 10000,
    expectedVersion: 4,
  });
  const raceA = await fresh(3),
    raceB = await fresh(3);
  const attempts = await Promise.all(
    [raceA, raceB].map(async (candidate) => {
      const response = await fetch(`${handle!.baseUrl}/orders/${candidate.order.id}/invoice`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${tokens['CASHIER']}`,
          'Content-Type': 'application/json',
          Connection: 'close',
        },
        body: JSON.stringify({ expectedVersion: candidate.order.version }),
      });
      return { status: response.status, body: (await response.json()) as { invoice?: InvoiceDto } };
    }),
  );
  assert.deepEqual(attempts.map((row) => row.status).sort(), [201, 409]);
  assert.equal((await statement()).balancePoints, 1);
  await call(
    'POST',
    `/invoices/${attempts.find((row) => row.status === 201)!.body.invoice!.id}/void`,
    200,
    owner,
    { reason: 'Release race-test reward' },
  );
  assert.equal((await statement()).balancePoints, 4);
  const beforeRestart = await statement();
  await stopNayaroServer(handle);
  handle = await start();
  assert.deepEqual(await statement(), beforeRestart);
  assert.equal(
    (await call<BillingResponse>('GET', `/orders/${first.order.id}/billing`, 200, owner)).invoice!
      .loyalty!.pointsEarned,
    0,
  );
  if (process.argv.includes('--ui')) {
    const snack = await handle.prisma.menuItem.create({
      data: { restaurantId, categoryId: category.id, name: 'Reward snack', pricePaisa: 100 },
    });
    let { order: uiOrder } = await call<OrderResponse>(
      'POST',
      '/orders/items',
      201,
      tokens['WAITER'],
      { target: { kind: 'TAKEAWAY' }, menuItemId: snack.id },
    );
    const uiChoice = await call<OrderLoyaltyResponse>(
      'POST',
      `/orders/${uiOrder.id}/loyalty`,
      200,
      owner,
      { expectedOrderVersion: uiOrder.version, customerId: customer.id, points: 0 },
    );
    ({ order: uiOrder } = await call<SendToKitchenResponse>(
      'POST',
      `/orders/${uiOrder.id}/send-kot`,
      201,
      tokens['WAITER'],
      { expectedVersion: uiChoice.orderVersion },
    ));
    const require = createRequire(import.meta.url);
    const executable = require('electron') as string;
    const script = fileURLToPath(
      new URL('../../../apps/desktop/scripts/verifyLoyalty.cjs', import.meta.url),
    );
    const env = { ...process.env };
    delete env['ELECTRON_RUN_AS_NODE'];
    await new Promise<void>((resolve, reject) => {
      const browser = spawn(executable, [script, handle!.baseUrl, root, uiOrder.id], {
        env,
        stdio: 'inherit',
      });
      const timer = setTimeout(() => {
        browser.kill();
        reject(new Error('Loyalty browser check timed out.'));
      }, 55_000);
      browser.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      browser.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Loyalty browser exited with ${code}`));
      });
    });
    assert.equal((await statement()).balancePoints, beforeRestart.balancePoints);
    assert.equal(
      (await call<LoyaltyProgram>('GET', '/loyalty/settings', 200, owner)).earnEveryPaisa,
      5000,
    );
    assert.equal(await handle.prisma.payment.count({ where: { orderId: uiOrder.id } }), 0);
  }
  console.log(
    `PASS: loyalty (${checks} HTTP checks), settings/roles, settlement-only earnings, credit exclusion, redemption quotes, issue-time overspend protection, void/reissue, refund rounding, negative balances, retry safety and restart history.`,
  );
} finally {
  if (handle) await stopNayaroServer(handle);
  rmSync(root, { recursive: true, force: true });
}
