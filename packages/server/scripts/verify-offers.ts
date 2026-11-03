/** Real offer routes and frozen prices through stock, billing, split settlement and refunds. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  BillingResponse,
  CustomerMenuResponse,
  InvoiceDto,
  LoginResponse,
  MenuResponse,
  OffersResponse,
  OrderResponse,
  SendToKitchenResponse,
} from '@nayaro/shared';
import { itemPaymentShares } from '@nayaro/shared';
import { startNayaroServer, stopNayaroServer } from '../src/server';
import { registerTenant } from '../src/modules/tenant/tenant.service';
import { hashPassword } from '../src/modules/auth/password';
import { activeOffers, offerPrice } from '../src/modules/offers/offers.service';

const root = mkdtempSync(join(tmpdir(), 'nayaro-offers-'));
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
      allowDirectRegistration: true,
      host: '127.0.0.1',
      port: 4356,
      databaseFilePath: join(root, 'data.db'),
      silent: true,
    });
  handle = await start();
  const { prisma } = handle;
  const { restaurantId } = await registerTenant(prisma, {
    restaurant: { slug: 'verify-restaurant', name: 'Offer restaurant' },
    owner: { name: 'Owner', username: 'owner', password: 'offers-test-password' },
  });
  const login = async (username: string) =>
    (
      await call<LoginResponse>('POST', '/auth/login', 200, undefined, {
        workspace: 'verify-restaurant', username,
        password: 'offers-test-password',
      })
    ).token;
  const owner = await login('owner');
  const roles: Record<string, string> = {};
  for (const role of ['MANAGER', 'CASHIER', 'WAITER', 'KITCHEN'] as const) {
    await prisma.staff.create({
      data: {
        restaurantId,
        name: role,
        username: role.toLowerCase(),
        role,
        passwordHash: await hashPassword('offers-test-password'),
      },
    });
    roles[role] = await login(role.toLowerCase());
  }
  const category = await prisma.menuCategory.create({ data: { restaurantId, name: 'Meals' } });
  const main = await prisma.menuItem.create({
    data: { restaurantId, categoryId: category.id, name: 'Main', pricePaisa: 22001 },
  });
  const bundle = await prisma.menuItem.create({
    data: {
      restaurantId,
      categoryId: category.id,
      name: 'Set',
      pricePaisa: 35000,
      comboComponents: JSON.stringify([{ menuItemId: main.id, quantity: 2 }]),
    },
  });
  const ingredient = await prisma.ingredient.create({
    data: { restaurantId, name: 'Rice', unit: 'g', onHandMilli: 10000 },
  });
  await prisma.recipeIngredient.create({
    data: { menuItemId: main.id, ingredientId: ingredient.id, quantityMilli: 100 },
  });
  await prisma.restaurantSettings.update({
    where: { restaurantId },
    data: {
      customerMenuEnabled: true,
      vatEnabled: true,
      serviceChargeEnabled: true,
      serviceChargeAppliesToTakeaway: true,
      roundGrandTotalToRupee: false,
    },
  });
  const now = Date.now();
  const definition = {
    name: 'Menu offer',
    rateBp: 1000,
    scope: 'ALL',
    targetIds: [],
    startsAt: new Date(now - 3600000).toISOString(),
    endsAt: new Date(now + 3600000).toISOString(),
    isActive: true,
  };
  await call('GET', '/management/offers', 401);
  for (const role of ['CASHIER', 'WAITER', 'KITCHEN']) {
    await call('GET', '/management/offers', 403, roles[role]);
    await call('POST', '/management/offers', 403, roles[role], definition);
  }
  for (const patch of [
    { rateBp: 0 },
    { rateBp: 10001 },
    { endsAt: definition.startsAt },
    { scope: 'ITEMS' },
    { targetIds: [main.id] },
    { startsAt: 'tomorrow' },
  ])
    await call('POST', '/management/offers', 400, owner, { ...definition, ...patch });
  const other = await prisma.restaurant.create({
    data: { name: 'Other', address: '', phone: '', panNumber: '' },
  });
  const otherCategory = await prisma.menuCategory.create({
    data: { restaurantId: other.id, name: 'Other' },
  });
  const otherItem = await prisma.menuItem.create({
    data: {
      restaurantId: other.id,
      categoryId: otherCategory.id,
      name: 'Other dish',
      pricePaisa: 100,
    },
  });
  await call('POST', '/management/offers', 409, owner, {
    ...definition,
    scope: 'ITEMS',
    targetIds: [otherItem.id],
  });
  const general = (
    await call<OffersResponse>('POST', '/management/offers', 201, roles['MANAGER'], definition)
  ).offers.find((row) => row.name === 'Menu offer')!;
  const categoryOffer = (
    await call<OffersResponse>('POST', '/management/offers', 201, owner, {
      ...definition,
      name: 'Category offer',
      scope: 'CATEGORIES',
      targetIds: [category.id],
      rateBp: 2000,
    })
  ).offers.find((row) => row.name === 'Category offer')!;
  const itemOffer = (
    await call<OffersResponse>('POST', '/management/offers', 201, owner, {
      ...definition,
      name: 'Item offer',
      scope: 'ITEMS',
      targetIds: [main.id],
      rateBp: 2500,
    })
  ).offers.find((row) => row.name === 'Item offer')!;
  const foreign = await prisma.offer.create({
    data: {
      restaurantId: other.id,
      name: 'Foreign',
      rateBp: 9900,
      scope: 'ALL',
      targetIdsJson: '[]',
      startsAt: new Date(definition.startsAt),
      endsAt: new Date(definition.endsAt),
      createdByStaffId: (await prisma.staff.findFirstOrThrow()).id,
      updatedByStaffId: (await prisma.staff.findFirstOrThrow()).id,
    },
  });
  await call('PATCH', `/management/offers/${foreign.id}`, 404, owner, {
    expectedVersion: 0,
    isActive: false,
  });
  assert(
    !(await call<OffersResponse>('GET', '/management/offers', 200, owner)).offers.some(
      (row) => row.id === foreign.id,
    ),
  );
  const boundary = (
    await call<OffersResponse>('POST', '/management/offers', 201, owner, {
      ...definition,
      name: 'Boundary',
      startsAt: '2099-01-01T12:00:00+05:45',
      endsAt: '2099-01-01T13:00:00+05:45',
    })
  ).offers.find((row) => row.name === 'Boundary')!;
  assert(
    !(await activeOffers(prisma, restaurantId, new Date('2099-01-01T06:14:59.999Z'))).some(
      (row) => row.id === boundary.id,
    ),
  );
  assert(
    (await activeOffers(prisma, restaurantId, new Date('2099-01-01T06:15:00Z'))).some(
      (row) => row.id === boundary.id,
    ),
  );
  assert(
    !(await activeOffers(prisma, restaurantId, new Date('2099-01-01T07:15:00Z'))).some(
      (row) => row.id === boundary.id,
    ),
  );
  const current = await activeOffers(prisma, restaurantId);
  assert.equal(offerPrice(current, main).pricePaisa, 16501);
  const menu = (await call<MenuResponse>('GET', '/menu', 200, roles['WAITER'])).categories.flatMap(
    (row) => row.items,
  );
  assert.equal(menu.find((row) => row.id === main.id)!.pricePaisa, 16501);
  assert.equal(menu.find((row) => row.id === bundle.id)!.pricePaisa, 28000); // 20% on set price, no component stacking.
  const guest = await call<CustomerMenuResponse>(
    'GET',
    `/public/menu?workspace=verify-restaurant`,
    200,
  );
  assert.deepEqual(guest.categories[0]!.items.find((row) => row.id === main.id)!.promotion, {
    name: 'Item offer',
    rateBp: 2500,
    regularUnitPricePaisa: 22001,
  });
  const add = {
    target: { kind: 'TAKEAWAY' },
    menuItemId: main.id,
    quantity: 2,
    unitPricePaisa: 1,
    promotionSnapshot: 'forged',
  };
  let { order } = await call<OrderResponse>(
    'POST',
    '/orders/items',
    201,
    roles['WAITER'],
    add,
    'offers-add-retry-0001',
  );
  assert.equal(order.items[0]!.unitPricePaisa, 16501);
  assert.equal(
    (
      await call<OrderResponse>(
        'POST',
        '/orders/items',
        201,
        roles['WAITER'],
        add,
        'offers-add-retry-0001',
      )
    ).order.id,
    order.id,
  );
  assert.equal(await prisma.order.count(), 1);
  ({ order } = await call<OrderResponse>('POST', '/orders/items', 201, roles['WAITER'], {
    target: { kind: 'ORDER', orderId: order.id, expectedVersion: order.version },
    menuItemId: main.id,
  }));
  assert.equal(order.items.length, 1);
  assert.equal(order.items[0]!.quantity, 3);
  await call('PATCH', `/management/offers/${itemOffer.id}`, 200, owner, {
    expectedVersion: itemOffer.version,
    isActive: false,
  });
  await call('PATCH', `/management/offers/${itemOffer.id}`, 409, owner, {
    expectedVersion: itemOffer.version,
    name: 'Stale edit',
  });
  ({ order } = await call<OrderResponse>('POST', '/orders/items', 201, roles['WAITER'], {
    target: { kind: 'ORDER', orderId: order.id, expectedVersion: order.version },
    menuItemId: main.id,
  }));
  assert.equal(order.items.length, 2);
  assert.equal(order.items[1]!.unitPricePaisa, 17601);
  ({ order } = await call<OrderResponse>(
    'PATCH',
    `/orders/${order.id}/items/${order.items[0]!.id}`,
    200,
    roles['WAITER'],
    { expectedVersion: order.version, quantity: 4 },
  ));
  assert.equal(order.items[0]!.unitPricePaisa, 16501);
  const sent = await call<SendToKitchenResponse>(
    'POST',
    `/orders/${order.id}/send-kot`,
    201,
    roles['WAITER'],
    { expectedVersion: order.version },
  );
  assert.equal(
    (await prisma.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } })).onHandMilli,
    9500,
  );
  await call('POST', `/orders/${order.id}/items/${order.items[0]!.id}/cancellations`, 201, owner, {
    quantity: 1,
    reason: 'Guest cancelled one dish',
  });
  const latest = (await call<OrderResponse>('GET', `/orders/${order.id}`, 200, owner)).order;
  const { preBill: discounted } = await call<Pick<BillingResponse, 'preBill'>>(
    'PATCH',
    `/orders/${order.id}/discount`,
    200,
    owner,
    { expectedVersion: latest.version, discountType: 'PERCENT', discountValue: 1000 },
  );
  assert.equal(discounted!.subtotalPaisa, 67104);
  assert.equal(discounted!.discount.amountPaisa, 6710);
  assert.equal(discounted!.serviceCharge.amountPaisa, 6039);
  assert.equal(discounted!.vat.amountPaisa, 8636);
  assert.equal(discounted!.grandTotalPaisa, 75069);
  const { invoice } = await call<{ invoice: InvoiceDto }>(
    'POST',
    `/orders/${order.id}/invoice`,
    201,
    roles['CASHIER'],
    { expectedVersion: discounted!.orderVersion },
  );
  assert.equal(invoice.grandTotalPaisa, 75069);
  assert.equal(invoice.lines[0]!.promotion!.name, 'Item offer');
  // Offer expiry and definition/name changes cannot rewrite invoice or original order lines.
  await call('PATCH', `/management/offers/${categoryOffer.id}`, 200, owner, {
    expectedVersion: categoryOffer.version,
    name: 'Renamed',
    endsAt: new Date(now - 1000).toISOString(),
  });
  await call('PATCH', `/management/offers/${general.id}`, 200, owner, {
    expectedVersion: general.version,
    isActive: false,
  });
  const shares = itemPaymentShares(invoice);
  const first = shares[0]!;
  let { invoice: paid } = await call<{ invoice: InvoiceDto }>(
    'POST',
    `/invoices/${invoice.id}/payments`,
    201,
    roles['CASHIER'],
    {
      expectedOrderVersion: invoice.orderVersion,
      method: 'QR',
      amountPaisa: first.remainingPaisa,
      items: [{ invoiceLineId: first.invoiceLineId, quantity: first.remainingQuantity }],
    },
  );
  ({ invoice: paid } = await call<{ invoice: InvoiceDto }>(
    'POST',
    `/invoices/${invoice.id}/payments`,
    201,
    roles['CASHIER'],
    {
      expectedOrderVersion: paid.orderVersion,
      method: 'QR',
      amountPaisa: paid.settlement.remainingPaisa,
    },
  ));
  const payment = paid.settlement.payments[0]!;
  await call(
    'POST',
    `/payments/${payment.id}/refunds`,
    409,
    owner,
    { amountPaisa: payment.amountPaisa + 1, expectedRefundedPaisa: 0, reason: 'Over refund' },
    'offers-over-refund-0001',
  );
  await call(
    'POST',
    `/payments/${payment.id}/refunds`,
    201,
    owner,
    {
      amountPaisa: payment.amountPaisa,
      expectedRefundedPaisa: 0,
      reason: 'Refund actual promotional payment',
    },
    'offers-refund-00000001',
  );
  await stopNayaroServer(handle);
  handle = await start();
  const persisted = (await call<BillingResponse>('GET', `/orders/${order.id}/billing`, 200, owner))
    .invoice!;
  assert.deepEqual(persisted.lines, invoice.lines);
  assert.equal(persisted.grandTotalPaisa, 75069);
  assert.equal(
    (await handle.prisma.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } }))
      .onHandMilli,
    9500,
  );
  assert.equal(
    sent.kot.items.reduce((sum, row) => sum + row.quantity, 0),
    5,
  );
  if (process.argv.includes('--ui')) {
    const require = createRequire(import.meta.url);
    const executable = require('electron') as string;
    const script = fileURLToPath(
      new URL('../../../apps/desktop/scripts/verifyOffers.cjs', import.meta.url),
    );
    const env = { ...process.env };
    delete env['ELECTRON_RUN_AS_NODE'];
    await new Promise<void>((resolve, reject) => {
      const browser = spawn(executable, [script, handle!.baseUrl, root, order.id], {
        env,
        stdio: 'inherit',
      });
      const timer = setTimeout(() => {
        browser.kill();
        reject(new Error('Offer browser check timed out.'));
      }, 55_000);
      browser.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      browser.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Offer browser exited with ${code}`));
      });
    });
  }
  console.log(
    `PASS: offers (${checks} HTTP checks), schedules, best-price selection, scope/roles/isolation, price snapshots, retries, stock, cancellations, manual discounts, tax, item splits, refund caps and restart history.`,
  );
} finally {
  if (handle) await stopNayaroServer(handle);
  rmSync(root, { recursive: true, force: true });
}
