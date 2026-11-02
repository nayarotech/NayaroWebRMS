import { createLegacyInvoiceFixture, createLegacyRestaurant } from './legacyInvoiceFixture';
/** Customer ledger: real HTTP routes, migrations, money and concurrency invariants. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CustomerListResponse,
  CustomerStatementResponse,
  DailyReportResponse,
  InvoiceDto,
  LoginResponse,
  OrderResponse,
  ShiftResponse,
  UnassignedCreditResponse,
} from '@nayaro/shared';
import {
  createPrismaClient,
  ensureDataLayout,
  resolveDataLayout,
  toDatabaseFileUrl,
} from '@nayaro/database';
import { createClient } from '@libsql/client';
import { BUNDLED_MIGRATIONS } from '../../database/src/migrations.generated';
import { startNayaroServer, stopNayaroServer } from '../src/server';
import { hashPassword } from '../src/modules/auth/password';

const root = mkdtempSync(join(tmpdir(), 'nayaro-credit-'));
const layout = ensureDataLayout(resolveDataLayout(root));
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
  const result: unknown = await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`);
  checks++;
  return result as T;
}
async function verifyUpgrade(): Promise<void> {
  const path = join(root, 'before-credit.db');
  const sqlite = createClient({ url: toDatabaseFileUrl(path) });
  const migration = BUNDLED_MIGRATIONS.find(
    (row) => row.name === '20261028130000_customer_credit',
  )!;
  let prisma: ReturnType<typeof createPrismaClient> | undefined;
  try {
    for (const old of BUNDLED_MIGRATIONS.filter((row) => row.name < migration.name))
      await sqlite.executeMultiple(old.sql);
    prisma = createPrismaClient({ databaseFilePath: path });
    const restaurant = await createLegacyRestaurant(sqlite);
    const staff = await prisma.staff.create({
      data: {
        restaurantId: restaurant.id,
        name: 'Owner',
        username: 'upgrade-owner',
        passwordHash: 'unused',
        role: 'OWNER',
      },
    });
    const { order, invoice } = await createLegacyInvoiceFixture(sqlite, restaurant.id, staff.id);
    await sqlite.execute({
      sql: 'INSERT INTO "Payment" ("id", "restaurantId", "orderId", "invoiceId", "method", "amountPaisa", "creditAccountName", "receivedByStaffId") VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      args: [
        'legacy-credit',
        restaurant.id,
        order.id,
        invoice.id,
        'CREDIT',
        10000,
        'Existing name',
        staff.id,
      ],
    });
    await sqlite.executeMultiple(migration.sql);
    const retained = await prisma.payment.findUniqueOrThrow({ where: { id: 'legacy-credit' } });
    assert.equal(retained.creditAccountName, 'Existing name');
    assert.equal(retained.customerId, null);
    assert.equal(retained.amountPaisa, 10000);
    assert.equal(
      await prisma.customer.count(),
      0,
      'Migration must not guess a customer from a name',
    );
    assert.equal(await prisma.invoice.count(), 1);
    const account = await prisma.customer.create({
      data: { restaurantId: restaurant.id, name: 'Constraint check' },
    });
    const repayment = {
      restaurantId: restaurant.id,
      customerId: account.id,
      amountPaisa: 100,
      method: 'CASH' as const,
      businessDate: '2026-10-27',
      receivedByStaffId: staff.id,
    };
    // All foreign keys are valid: each rejection must come from a monetary invariant.
    await assert.rejects(() =>
      prisma!.creditRepayment.create({ data: { ...repayment, amountPaisa: 0 } }),
    );
    await assert.rejects(() =>
      prisma!.creditRepayment.create({ data: { ...repayment, method: 'CREDIT' } }),
    );
    await assert.rejects(() =>
      prisma!.creditRepayment.create({ data: { ...repayment, reversedAt: new Date() } }),
    );
    assert.equal(await prisma.creditRepayment.count(), 0);
  } finally {
    await prisma?.$disconnect();
    sqlite.close();
  }
}

try {
  await verifyUpgrade();
  const start = () =>
    startNayaroServer({
      host: '127.0.0.1',
      port: 4343,
      databaseFilePath: layout.databaseFilePath,
      silent: true,
    });
  handle = await start();
  await call('POST', '/tenants/register', 201, undefined, {
    restaurant: { slug: 'verify-restaurant', name: 'Credit test' },
    owner: { name: 'Owner', username: 'owner', password: 'credit-owner-password' },
  });
  const owner = (
    await call<LoginResponse>('POST', '/auth/login', 200, undefined, {
      workspace: 'verify-restaurant', username: 'owner',
      password: 'credit-owner-password',
    })
  ).token;
  const restaurant = await handle.prisma.restaurant.findFirstOrThrow();
  const ownerStaff = await handle.prisma.staff.findFirstOrThrow({ where: { role: 'OWNER' } });
  const password = 'credit-staff-password';
  for (const role of ['CASHIER', 'WAITER', 'KITCHEN', 'MANAGER'] as const)
    await call('POST', '/management/staff', 201, owner, {
      name: role,
      username: role.toLowerCase(),
      password,
      role,
    });
  const tokenFor = async (username: string, workspace = 'verify-restaurant') =>
    (await call<LoginResponse>('POST', '/auth/login', 200, undefined, { workspace, username, password }))
      .token;
  const cashier = await tokenFor('cashier');
  const manager = await tokenFor('manager');
  const waiter = await tokenFor('waiter');
  const kitchen = await tokenFor('kitchen');
  const category = await handle.prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: 'Food' },
  });
  const item = await handle.prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: 'Momo', pricePaisa: 10000 },
  });
  const createBody = { name: 'Sita', phone: '9800000001' };
  let account = await call<CustomerStatementResponse>(
    'POST',
    '/customers',
    201,
    cashier,
    createBody,
    'credit-create-customer-01',
  );
  const customerId = account.customer.id;
  assert.deepEqual(
    await call('POST', '/customers', 201, cashier, createBody, 'credit-create-customer-01'),
    account,
  );
  await call('POST', '/customers', 201, cashier, { name: 'Sita', phone: '9800000002' });
  const search = await call<CustomerListResponse>(
    'GET',
    '/customers?search=9800000001',
    200,
    cashier,
  );
  assert.equal(search.customers.length, 1);
  assert.equal(search.customers[0]!.id, customerId);
  await call('POST', '/customers', 400, cashier, { name: '   ' });
  for (const token of [waiter, kitchen]) {
    await call('GET', '/customers', 403, token);
    await call('GET', `/customers/${customerId}/statement`, 403, token);
    await call('POST', '/customers', 403, token, createBody);
    await call('POST', `/customers/${customerId}/repayments`, 403, token, {});
  }
  await call('GET', '/customers', 401);
  const other = await handle.prisma.restaurant.create({
    data: { slug: 'other-restaurant', name: 'Other', address: '', phone: '', panNumber: '' },
  });
  const otherCustomer = await handle.prisma.customer.create({
    data: { restaurantId: other.id, name: 'Other customer' },
  });
  const otherStaff = await handle.prisma.staff.create({
    data: {
      restaurantId: other.id,
      name: 'Other owner',
      username: 'other-owner',
      passwordHash: await hashPassword(password),
      role: 'OWNER',
    },
  });
  const otherToken = await tokenFor(otherStaff.username, 'other-restaurant');
  await call('GET', `/customers/${customerId}/statement`, 404, otherToken);
  await call('GET', `/customers/${otherCustomer.id}/statement`, 404, owner);
  await call('POST', `/customers/${otherCustomer.id}/repayments`, 404, owner, {
    expectedVersion: 0,
    amountPaisa: 1,
    method: 'CASH',
  });

  const statement = () =>
    call<CustomerStatementResponse>('GET', `/customers/${customerId}/statement`, 200, cashier);
  const newBill = async (quantity = 1) => {
    let { order } = await call<OrderResponse>('POST', '/orders/items', 201, cashier, {
      target: { kind: 'TAKEAWAY' },
      menuItemId: item.id,
      quantity,
    });
    ({ order } = await call<OrderResponse>('POST', `/orders/${order.id}/send-kot`, 201, cashier, {
      expectedVersion: order.version,
    }));
    const { invoice } = await call<{ invoice: InvoiceDto }>(
      'POST',
      `/orders/${order.id}/invoice`,
      201,
      cashier,
      { expectedVersion: order.version },
    );
    return invoice;
  };
  const creditSale = async (invoice: InvoiceDto, amountPaisa = invoice.grandTotalPaisa) =>
    call<{ invoice: InvoiceDto }>('POST', `/invoices/${invoice.id}/payments`, 201, cashier, {
      expectedOrderVersion: invoice.orderVersion,
      method: 'CREDIT',
      amountPaisa,
      customerId,
    });
  const pay = async (amountPaisa: number, method = 'CASH', token = cashier, key?: string) => {
    const before = await statement();
    return call<CustomerStatementResponse>(
      'POST',
      `/customers/${customerId}/repayments`,
      201,
      token,
      {
        expectedVersion: before.customer.version,
        amountPaisa,
        method,
        reference: 'receipt-123',
        note: 'Collected at till',
      },
      key,
    );
  };
  const reverse = async (id: string, token = manager, key?: string) => {
    const before = await statement();
    return call<CustomerStatementResponse>(
      'POST',
      `/credit-repayments/${id}/reverse`,
      200,
      token,
      { expectedVersion: before.customer.version, reason: 'Recorded against wrong receipt' },
      key,
    );
  };
  const edit = async (isActive: boolean, name = 'Sita') => {
    const before = await statement();
    return call<CustomerStatementResponse>('PATCH', `/customers/${customerId}`, 200, manager, {
      name,
      phone: '9800000001',
      isActive,
      expectedVersion: before.customer.version,
    });
  };
  const invoice = await newBill();
  await call('POST', `/invoices/${invoice.id}/payments`, 400, cashier, {
    expectedOrderVersion: invoice.orderVersion,
    method: 'CREDIT',
    amountPaisa: 10000,
    creditAccountName: 'Sita',
  });
  await call('POST', `/invoices/${invoice.id}/payments`, 404, cashier, {
    expectedOrderVersion: invoice.orderVersion,
    method: 'CREDIT',
    amountPaisa: 10000,
    customerId: otherCustomer.id,
  });
  assert.equal(await handle.prisma.payment.count(), 0);
  const credited = await creditSale(invoice);
  assert.equal(credited.invoice.settlement.status, 'PAID');
  assert.equal(credited.invoice.settlement.payments[0]!.customerId, customerId);
  assert.equal((await statement()).customer.balancePaisa, 10000);
  const shift = (
    await call<ShiftResponse>('POST', '/shifts', 201, cashier, { openingFloatPaisa: 5000 })
  ).shift;
  const currentDrawer = () => call<ShiftResponse>('GET', '/shifts/current', 200, cashier);
  assert.equal((await currentDrawer()).shift.expectedCashPaisa, 5000);
  account = await pay(3000, 'CASH', cashier, 'credit-repay-cash-0001');
  assert.equal(account.customer.balancePaisa, 7000);
  assert.equal((await currentDrawer()).shift.cashCreditCollectionsPaisa, 3000);
  assert.equal((await currentDrawer()).shift.expectedCashPaisa, 8000);
  account = await pay(2000, 'QR');
  assert.equal(account.customer.balancePaisa, 5000);
  const qrRepayment = account.entries.find(
    (entry) => entry.kind === 'REPAYMENT' && entry.method === 'QR',
  )!;
  await call('POST', `/credit-repayments/${qrRepayment.repaymentId}/reverse`, 403, cashier, {
    expectedVersion: account.customer.version,
    reason: 'Wrong receipt',
  });
  await call('POST', `/credit-repayments/${qrRepayment.repaymentId}/reverse`, 400, manager, {
    expectedVersion: account.customer.version,
    reason: ' ',
  });
  account = await reverse(qrRepayment.repaymentId!);
  assert.equal(account.customer.balancePaisa, 7000);
  assert.equal(account.entries.filter((entry) => entry.kind === 'REVERSAL').length, 1);
  await call('POST', `/credit-repayments/${qrRepayment.repaymentId}/reverse`, 409, manager, {
    expectedVersion: account.customer.version,
    reason: 'Wrong receipt',
  });
  await call('POST', `/customers/${customerId}/repayments`, 409, cashier, {
    expectedVersion: account.customer.version,
    amountPaisa: 7001,
    method: 'CASH',
  });
  await call('POST', `/customers/${customerId}/repayments`, 409, cashier, {
    expectedVersion: 0,
    amountPaisa: 1,
    method: 'CASH',
  });
  for (const body of [
    { amountPaisa: 0, method: 'CASH' },
    { amountPaisa: -1, method: 'CASH' },
    { amountPaisa: 1.5, method: 'CASH' },
    { amountPaisa: 1, method: 'CREDIT' },
  ])
    await call('POST', `/customers/${customerId}/repayments`, 400, cashier, {
      expectedVersion: account.customer.version,
      ...body,
    });
  account = await edit(false);
  const inactiveBill = await newBill();
  await call('POST', `/invoices/${inactiveBill.id}/payments`, 409, cashier, {
    expectedOrderVersion: inactiveBill.orderVersion,
    method: 'CREDIT',
    amountPaisa: 10000,
    customerId,
  });
  account = await pay(1000, 'CARD'); // Inactive accounts can still pay their debt.
  assert.equal(account.customer.balancePaisa, 6000);
  account = await edit(true, 'Sita Renamed');
  const oldPayment = await handle.prisma.payment.findFirstOrThrow({ where: { customerId } });
  assert.equal(oldPayment.creditAccountName, 'Sita', 'Rename must not rewrite the historical sale');
  await call('PATCH', `/customers/${customerId}`, 403, cashier, {
    name: 'x',
    isActive: true,
    expectedVersion: account.customer.version,
  });
  await call('PATCH', `/customers/${customerId}`, 409, owner, {
    name: 'Stale',
    isActive: true,
    expectedVersion: 0,
  });

  // Valid pre-upgrade credit remains outside account balances until explicitly assigned.
  const legacyInvoice = await newBill(2);
  const legacy = await handle.prisma.payment.create({
    data: {
      restaurantId: restaurant.id,
      orderId: legacyInvoice.orderId,
      invoiceId: legacyInvoice.id,
      amountPaisa: 20000,
      method: 'CREDIT',
      creditAccountName: 'Old handwritten name',
      receivedByStaffId: ownerStaff.id,
    },
  });
  await handle.prisma.order.update({
    where: { id: legacyInvoice.orderId },
    data: { status: 'PAID', closedAt: new Date() },
  });
  assert.equal((await statement()).customer.balancePaisa, 6000);
  assert.equal(
    (await call<UnassignedCreditResponse>('GET', '/credit/unassigned', 200, cashier)).payments
      .length,
    1,
  );
  await call('POST', `/credit/${legacy.id}/customer`, 403, cashier, {
    customerId,
    expectedVersion: account.customer.version,
  });
  await call('POST', `/credit/${legacy.id}/customer`, 409, manager, {
    customerId,
    expectedVersion: 0,
  });
  account = await call<CustomerStatementResponse>(
    'POST',
    `/credit/${legacy.id}/customer`,
    200,
    manager,
    { customerId, expectedVersion: account.customer.version },
    'credit-link-legacy-001',
  );
  assert.equal(account.customer.balancePaisa, 26000);
  const assigned = await handle.prisma.payment.findUniqueOrThrow({ where: { id: legacy.id } });
  assert.equal(assigned.creditAccountName, 'Old handwritten name');
  assert.ok(assigned.creditAssignedAt && assigned.creditAssignedByStaffId);
  assert.equal(
    (await call<UnassignedCreditResponse>('GET', '/credit/unassigned', 200, cashier)).payments
      .length,
    0,
  );
  await call('POST', `/credit/${legacy.id}/customer`, 409, manager, {
    customerId,
    expectedVersion: account.customer.version,
  });

  // Do not allow a sale correction to produce negative customer debt.
  const partialBill = await newBill();
  const partialCredit = await creditSale(partialBill, 4000);
  const partialPaymentId = partialCredit.invoice.settlement.payments[0]!.id;
  account = await pay(28000);
  assert.equal(account.customer.balancePaisa, 2000);
  await call('POST', `/payments/${partialPaymentId}/void`, 409, manager, {
    reason: 'Wrong account',
  });
  const lastRepayment = account.entries.find(
    (entry) => entry.kind === 'REPAYMENT' && entry.amountPaisa === -28000,
  )!;
  account = await reverse(lastRepayment.repaymentId!);
  await call('POST', `/payments/${partialPaymentId}/void`, 200, manager, {
    reason: 'Wrong account',
  });
  account = await statement();
  assert.equal(account.customer.balancePaisa, 26000);
  assert.ok(account.entries.some((entry) => entry.kind === 'CREDIT_VOID'));

  // Different requests using one stale balance cannot both collect it.
  const concurrentBody = {
    expectedVersion: account.customer.version,
    amountPaisa: 19000,
    method: 'CASH',
  };
  const results = await Promise.all(
    ['credit-race-one-0001', 'credit-race-two-0001'].map(async (key) => {
      const response = await fetch(`${handle!.baseUrl}/customers/${customerId}/repayments`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cashier}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
        },
        body: JSON.stringify(concurrentBody),
      });
      return response.status;
    }),
  );
  assert.deepEqual(results.sort(), [201, 409]);
  account = await statement();
  assert.equal(account.customer.balancePaisa, 7000);
  const duplicateBody = {
    expectedVersion: account.customer.version,
    amountPaisa: 1000,
    method: 'CASH',
  };
  const duplicates = await Promise.all(
    [1, 2].map(() =>
      call<CustomerStatementResponse>(
        'POST',
        `/customers/${customerId}/repayments`,
        201,
        cashier,
        duplicateBody,
        'credit-duplicate-repay-001',
      ),
    ),
  );
  assert.deepEqual(duplicates[0], duplicates[1]);
  account = duplicates[0]!;
  assert.equal(account.customer.balancePaisa, 6000);
  assert.equal(account.entries.at(-1)!.balancePaisa, account.customer.balancePaisa);

  const report = await call<DailyReportResponse>('GET', '/reports/daily', 200, owner);
  assert.equal(
    report.sales.grandTotalPaisa,
    50000,
    'Repayments must never count as additional sales',
  );
  assert.equal(report.creditCollections.netPaisa, 24000); // 3000 cash + 1000 card + 19000 cash + 1000 cash.
  assert.equal(
    report.creditCollections.byMethod.find((row) => row.method === 'CASH')!.netPaisa,
    23000,
  );
  assert.equal((await currentDrawer()).shift.expectedCashPaisa, 28000);
  const closed = await call<ShiftResponse>('POST', `/shifts/${shift.id}/close`, 200, cashier, {
    countedCashPaisa: 28000,
  });
  assert.equal(closed.shift.close!.variancePaisa, 0);

  // A reversal after close affects the new drawer; the closed drawer stays frozen.
  const nextShift = (
    await call<ShiftResponse>('POST', '/shifts', 201, cashier, { openingFloatPaisa: 5000 })
  ).shift;
  const cashEntry = account.entries.find(
    (entry) => entry.kind === 'REPAYMENT' && entry.amountPaisa === -3000,
  )!;
  account = await reverse(cashEntry.repaymentId!, owner, 'credit-reverse-cash-001');
  assert.equal(account.customer.balancePaisa, 9000);
  assert.equal((await currentDrawer()).shift.expectedCashPaisa, 2000);
  assert.equal((await currentDrawer()).shift.id, nextShift.id);
  const closedRow = await handle.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
  assert.equal(closedRow.expectedCashPaisa, 28000);

  // A repayment from another business day is collected/reversed on its own date.
  const cardEntry = account.entries.find(
    (entry) => entry.kind === 'REPAYMENT' && entry.method === 'CARD',
  )!;
  await handle.prisma.creditRepayment.update({
    where: { id: cardEntry.repaymentId! },
    data: { businessDate: '2000-01-01' },
  });
  await reverse(cardEntry.repaymentId!);
  const historical = await call<DailyReportResponse>(
    'GET',
    '/reports/daily?date=2000-01-01',
    200,
    owner,
  );
  assert.equal(historical.sales.grandTotalPaisa, 0);
  assert.equal(historical.creditCollections.receivedPaisa, 1000);
  assert.equal(historical.creditCollections.reversedPaisa, 0);
  const today = await call<DailyReportResponse>('GET', '/reports/daily', 200, owner);
  assert.equal(
    today.creditCollections.byMethod.find((row) => row.method === 'CARD')!.netPaisa,
    -1000,
  );

  // The account and original request response survive a server restart.
  const beforeRestart = await statement();
  await stopNayaroServer(handle);
  handle = await start();
  assert.deepEqual(await statement(), beforeRestart);
  assert.deepEqual(
    await call(
      'POST',
      `/customers/${customerId}/repayments`,
      201,
      cashier,
      duplicateBody,
      'credit-duplicate-repay-001',
    ),
    duplicates[0],
  );
  assert.deepEqual(await statement(), beforeRestart);
  const otherList = await call<CustomerListResponse>('GET', '/customers', 200, otherToken);
  assert.equal(otherList.customers.length, 1);
  console.log(
    `PASS: ${checks} HTTP checks; balances, collections, permissions, legacy assignment, corrections, concurrency and restart recovery.`,
  );
} finally {
  if (handle) await stopNayaroServer(handle);
  rmSync(root, { recursive: true, force: true });
}
