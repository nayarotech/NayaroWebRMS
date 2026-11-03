import { createLegacyInvoiceFixture, createLegacyRestaurant } from './legacyInvoiceFixture';
/** Refund, expense and inventory integration checks using disposable data. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  InvoiceDto,
  LoginResponse,
  RefundDto,
  DailyReportResponse,
  ShiftResponse,
  CustomerStatementResponse,
  ExpenseDto,
  ExpenseSummaryDto,
  ReceiptAttachment,
  InventoryResponse,
  IngredientDto,
  OrderResponse,
  SendToKitchenResponse,
  MenuResponse,
  AvailabilityResponse,
} from '@nayaro/shared';
import { startNayaroServer, stopNayaroServer } from '../src/server';
import { hashPassword } from '../src/modules/auth/password';
import { createClient } from '@libsql/client';
import { createPrismaClient, toDatabaseFileUrl, assertDatabaseIntegrity } from '@nayaro/database';
import { BUNDLED_MIGRATIONS } from '../../database/src/migrations.generated';

const root = mkdtempSync(join(tmpdir(), 'nayaro-operations-'));
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
      ...(key ? { 'Idempotency-Key': key.padEnd(16, '0') } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result: unknown = await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`);
  checks++;
  return result as T;
}
async function verifyUpgrade() {
  const databaseFilePath = join(root, 'upgrade.db');
  const sqlite = createClient({ url: toDatabaseFileUrl(databaseFilePath) });
  const prisma = createPrismaClient({ databaseFilePath });
  try {
    const old = BUNDLED_MIGRATIONS.filter((row) => row.name < '20261028160000');
    for (const migration of old) await sqlite.executeMultiple(migration.sql);
    const restaurant = await createLegacyRestaurant(sqlite);
    const staff = await prisma.staff.create({
      data: {
        restaurantId: restaurant.id,
        name: 'Owner',
        username: 'existing-owner',
        passwordHash: 'unused',
        role: 'OWNER',
      },
      // Only the id: on this pre-upgrade schema, later Staff columns (email)
      // do not exist yet, and a full read-back would ask for them.
      select: { id: true },
    });
    const { order, invoice } = await createLegacyInvoiceFixture(
      sqlite,
      restaurant.id,
      staff.id,
      false,
    );
    const payment = await prisma.payment.create({
      data: {
        restaurantId: restaurant.id,
        orderId: order.id,
        invoiceId: invoice.id,
        method: 'CASH',
        amountPaisa: 10000,
        receivedByStaffId: staff.id,
      },
    });
    const receipt = await prisma.requestReceipt.create({
      data: {
        restaurantId: restaurant.id,
        staffId: staff.id,
        key: 'old-request-receipt',
        requestHash: 'existing-hash',
        responseJson: '{"saved":true}',
      },
    });
    for (const migration of BUNDLED_MIGRATIONS.filter((row) => !old.includes(row)))
      await sqlite.executeMultiple(migration.sql);
    assert.equal(
      (
        await prisma.payment.findUniqueOrThrow({
          where: { id: payment.id },
          include: { refunds: true },
        })
      ).amountPaisa,
      10000,
    );
    assert.equal(
      (await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).grandTotalPaisa,
      10000,
    );
    assert.deepEqual(
      await prisma.requestReceipt.findUniqueOrThrow({
        where: {
          restaurantId_staffId_key: {
            restaurantId: restaurant.id,
            staffId: staff.id,
            key: receipt.key,
          },
        },
      }),
      receipt,
    );
    assert.equal(await prisma.expense.count(), 0);
    assert.equal(await prisma.ingredient.count(), 0);
    assert.equal(await prisma.loyaltyEntry.count(), 0);
    assert.equal(
      (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).loyaltyPointsToRedeem,
      0,
    );
    assert.equal(
      (await prisma.invoice.findUniqueOrThrow({ where: { id: invoice.id } })).loyaltySnapshot,
      null,
    );
    await assertDatabaseIntegrity(prisma);
    assert.equal((await sqlite.execute('PRAGMA foreign_key_check')).rows.length, 0);
  } finally {
    await prisma.$disconnect();
    sqlite.close();
  }
}
try {
  await verifyUpgrade();
  const start = () =>
    startNayaroServer({
      allowDirectRegistration: true,
      host: '127.0.0.1',
      port: 4354,
      databaseFilePath: join(root, 'data.db'),
      silent: true,
    });
  handle = await start();
  await call('POST', '/tenants/register', 201, undefined, {
    restaurant: { slug: 'verify-restaurant', name: 'Operations' },
    owner: { name: 'Owner', username: 'owner', password: 'operations-password' },
  });
  const owner = (
    await call<LoginResponse>('POST', '/auth/login', 200, undefined, {
      workspace: 'verify-restaurant', username: 'owner',
      password: 'operations-password',
    })
  ).token;
  const restaurant = await handle.prisma.restaurant.findFirstOrThrow();
  const staff = await handle.prisma.staff.findFirstOrThrow();
  const tokens: Record<string, string> = {};
  for (const role of ['MANAGER', 'CASHIER', 'WAITER', 'KITCHEN'] as const) {
    await handle.prisma.staff.create({
      data: {
        restaurantId: restaurant.id,
        name: role,
        username: role.toLowerCase(),
        role,
        passwordHash: await hashPassword('operations-password'),
      },
    });
    tokens[role] = (
      await call<LoginResponse>('POST', '/auth/login', 200, undefined, {
        workspace: 'verify-restaurant', username: role.toLowerCase(),
        password: 'operations-password',
      })
    ).token;
  }
  const customer = await handle.prisma.customer.create({
    data: { restaurantId: restaurant.id, name: 'Account' },
  });
  let seq = 0;
  const fixture = async (method: 'CASH' | 'QR' | 'CARD' | 'CREDIT' = 'CASH') => {
    seq++;
    const order = await handle!.prisma.order.create({
      data: {
        restaurantId: restaurant.id,
        orderNumber: seq,
        type: 'TAKEAWAY',
        status: 'PAID',
        openedByStaffId: staff.id,
        businessDate: '2026-10-28',
        closedAt: new Date(),
      },
    });
    const invoice = await handle!.prisma.invoice.create({
      data: {
        restaurantId: restaurant.id,
        orderId: order.id,
        invoiceNumber: seq,
        fiscalYearStartBsYear: 2083,
        issuedByStaffId: staff.id,
        businessDate: '2026-10-28',
        subtotalPaisa: 10000,
        grandTotalPaisa: 10000,
      },
    });
    const payment = await handle!.prisma.payment.create({
      data: {
        restaurantId: restaurant.id,
        orderId: order.id,
        invoiceId: invoice.id,
        method,
        amountPaisa: 10000,
        receivedByStaffId: staff.id,
        ...(method === 'CREDIT' ? { customerId: customer.id } : {}),
      },
    });
    return { order, invoice, payment, path: `/payments/${payment.id}/refunds` };
  };
  const f = await fixture();
  const body = { amountPaisa: 3000, expectedRefundedPaisa: 0, reason: 'Returned meal' };
  for (const role of ['CASHIER', 'WAITER', 'KITCHEN'])
    await call('POST', f.path, 403, tokens[role], body, `denied-refund-${role}`);
  await call('POST', f.path, 400, owner, body);
  await call('POST', f.path, 409, owner, body, 'refund-without-drawer');
  await call('POST', '/shifts', 201, owner, { openingFloatPaisa: 50000 });
  const first = await call<{ refund: RefundDto }>(
    'POST',
    f.path,
    201,
    owner,
    body,
    'refund-first-request',
  );
  assert.deepEqual(await call('POST', f.path, 201, owner, body, 'refund-first-request'), first);
  assert.equal(await handle.prisma.paymentRefund.count(), 1);
  assert.equal(await handle.prisma.cashMovement.count(), 1);
  await call('POST', f.path, 409, owner, { ...body, amountPaisa: 4000 }, 'refund-first-request');
  await call('POST', f.path, 409, owner, body, 'refund-stale-request');
  await call(
    'POST',
    f.path,
    409,
    owner,
    { ...body, expectedRefundedPaisa: 3000, amountPaisa: 7001 },
    'refund-excess-request',
  );
  const shift = (await call<ShiftResponse>('GET', '/shifts/current', 200, owner)).shift;
  assert.equal(shift.expectedCashPaisa, 47000);
  assert.equal(
    (await handle.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status,
    'PAID',
  );
  assert.equal(
    (await handle.prisma.invoice.findUniqueOrThrow({ where: { id: f.invoice.id } }))
      .grandTotalPaisa,
    10000,
  );
  await stopNayaroServer(handle);
  handle = await start();
  assert.deepEqual(await call('POST', f.path, 201, owner, body, 'refund-first-request'), first);
  const second = { ...body, amountPaisa: 7000, expectedRefundedPaisa: 3000 };
  const race = await Promise.all(
    [0, 1].map((index) =>
      fetch(`${handle!.baseUrl}${f.path}`, {
        method: 'POST',
        headers: {
          Connection: 'close',
          Authorization: `Bearer ${owner}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `refund-race-request-${index}`,
        },
        body: JSON.stringify(second),
      }),
    ),
  );
  assert.deepEqual(race.map((res) => res.status).sort(), [201, 409]);
  await Promise.all(race.map((res) => res.json()));
  assert.equal(
    (await handle.prisma.paymentRefund.aggregate({ _sum: { amountPaisa: true } }))._sum.amountPaisa,
    10000,
  );
  const credit = await fixture('CREDIT');
  await call(
    'POST',
    credit.path,
    201,
    tokens['MANAGER'],
    { ...body, amountPaisa: 4000 },
    'refund-credit-request',
  );
  const statement = await call<CustomerStatementResponse>(
    'GET',
    `/customers/${customer.id}/statement`,
    200,
    owner,
  );
  assert.equal(statement.customer.balancePaisa, 6000);
  assert.ok(
    statement.entries.some((row) => row.kind === 'CREDIT_REFUND' && row.amountPaisa === -4000),
  );
  const settled = await call<{ invoice: InvoiceDto }>(
    'GET',
    `/orders/${f.order.id}/billing`,
    200,
    owner,
  );
  assert.equal(settled.invoice.settlement.remainingPaisa, 0);
  assert.equal(settled.invoice.settlement.payments[0]!.refunds.length, 2);
  const refundDate = first.refund.businessDate;
  const report = await call<DailyReportResponse>(
    'GET',
    `/reports/daily?date=${refundDate}`,
    200,
    owner,
  );
  assert.equal(report.refunds.totalPaisa, 14000);
  await call('POST', `/shifts/${shift.id}/close`, 200, owner, { countedCashPaisa: 40000 });
  const qr = await fixture('QR');
  await call(
    'POST',
    qr.path,
    201,
    owner,
    { ...body, amountPaisa: 10000 },
    'refund-qr-full-request',
  );
  const closed = await handle.prisma.shift.findUniqueOrThrow({ where: { id: shift.id } });
  assert.equal(closed.expectedCashPaisa, 40000);
  // Expenses keep one link to the actual payout, including pre-existing payouts.
  const expenseBody = {
    amountPaisa: 1000,
    method: 'CASH',
    category: 'Ingredients',
    supplier: 'Market',
    note: 'Vegetables bought',
    businessDate: refundDate,
    drawer: 'NEW',
    receipt: {
      name: 'receipt.pdf',
      mime: 'application/pdf',
      base64: Buffer.from('%PDF-1.4\nPilot receipt').toString('base64'),
    },
  };
  for (const role of ['CASHIER', 'WAITER', 'KITCHEN'])
    await call('POST', '/expenses', 403, tokens[role], expenseBody, `expense-denied-${role}`);
  await call('POST', '/expenses', 409, owner, expenseBody, 'expense-drawer-closed');
  const newShift = (
    await call<ShiftResponse>('POST', '/shifts', 201, owner, { openingFloatPaisa: 50000 })
  ).shift;
  const expense = await call<{ expense: ExpenseDto }>(
    'POST',
    '/expenses',
    201,
    owner,
    expenseBody,
    'expense-first-request',
  );
  assert.deepEqual(
    await call('POST', '/expenses', 201, owner, expenseBody, 'expense-first-request'),
    expense,
  );
  assert.equal(
    (await call<ShiftResponse>('GET', '/shifts/current', 200, owner)).shift.expectedCashPaisa,
    49000,
  );
  assert.deepEqual(
    await call<ReceiptAttachment>('GET', `/expenses/${expense.expense.id}/receipt`, 200, owner),
    expenseBody.receipt,
  );
  await call('GET', `/expenses/${expense.expense.id}/receipt`, 403, tokens['CASHIER']);
  await call(
    'POST',
    '/expenses',
    400,
    owner,
    { ...expenseBody, businessDate: '2026-02-30' },
    'expense-bad-date-key',
  );
  await call(
    'POST',
    '/expenses',
    400,
    owner,
    {
      ...expenseBody,
      receipt: { ...expenseBody.receipt, base64: Buffer.from('not a PDF').toString('base64') },
    },
    'expense-bad-file-key',
  );
  await call(
    'POST',
    '/expenses',
    409,
    owner,
    { ...expenseBody, drawer: 'LINK', cashMovementId: first.refund.id },
    'expense-not-payout-key',
  );
  const movementShift = (
    await call<ShiftResponse>('POST', `/shifts/${newShift.id}/movements`, 201, owner, {
      type: 'PAY_OUT',
      amountPaisa: 2500,
      reason: 'Paid electricity',
    })
  ).shift;
  const payout = movementShift.movements.find((row) => row.amountPaisa === 2500)!;
  const linkedBody = {
    ...expenseBody,
    amountPaisa: 2500,
    category: 'Utilities',
    drawer: 'LINK',
    cashMovementId: payout.id,
  };
  await call('POST', '/expenses', 201, tokens['MANAGER'], linkedBody, 'expense-linked-request');
  await call('POST', '/expenses', 409, owner, linkedBody, 'expense-link-twice-key');
  assert.equal(
    (await call<ShiftResponse>('GET', '/shifts/current', 200, owner)).shift.expectedCashPaisa,
    46500,
    'linked payout counted exactly once',
  );
  const expenses = await call<ExpenseSummaryDto>(
    'GET',
    `/expenses?from=${refundDate}&to=${refundDate}`,
    200,
    owner,
  );
  assert.equal(expenses.totalPaisa, 3500);
  assert.equal(expenses.expenses.length, 2);
  assert.equal(
    expenses.salesLessRefundsAndExpensesPaisa,
    expenses.salesPaisa - expenses.refundsPaisa - 3500,
  );
  assert.equal(
    (await call<ExpenseSummaryDto>('GET', '/expenses?from=2025-01-01&to=2025-01-31', 200, owner))
      .totalPaisa,
    0,
  );
  // Manual stock, purchases linked to expenses, recipes and atomic dispatch.
  const inventory = () => call<InventoryResponse>('GET', '/inventory', 200, owner);
  for (const role of ['CASHIER', 'WAITER', 'KITCHEN']) {
    await call('GET', '/inventory', 403, tokens[role]);
    await call(
      'POST',
      '/inventory/ingredients',
      403,
      tokens[role],
      { name: 'Denied', unit: 'g', lowStockMilli: 0 },
      `stock-denied-${role}`,
    );
  }
  const meat = (
    await call<{ ingredient: IngredientDto }>(
      'POST',
      '/inventory/ingredients',
      201,
      owner,
      { name: 'Meat', unit: 'g', lowStockMilli: 100000 },
      'ingredient-meat-key',
    )
  ).ingredient;
  const oil = (
    await call<{ ingredient: IngredientDto }>(
      'POST',
      '/inventory/ingredients',
      201,
      owner,
      { name: 'Oil', unit: 'ml', lowStockMilli: 10000 },
      'ingredient-oil-key',
    )
  ).ingredient;
  await call(
    'POST',
    '/inventory/ingredients',
    409,
    owner,
    { name: 'Meat', unit: 'g', lowStockMilli: 0 },
    'ingredient-duplicate-key',
  );
  const purchase = {
    expectedVersion: 0,
    kind: 'PURCHASE',
    quantityMilli: 1000000,
    costPaisa: 2000,
    method: 'CASH',
    fromDrawer: true,
    supplier: 'Market',
    reason: 'Morning purchase',
  };
  const purchaseResult = await call(
    'POST',
    `/inventory/ingredients/${meat.id}/stock`,
    201,
    owner,
    purchase,
    'stock-purchase-key',
  );
  assert.deepEqual(
    await call(
      'POST',
      `/inventory/ingredients/${meat.id}/stock`,
      201,
      owner,
      purchase,
      'stock-purchase-key',
    ),
    purchaseResult,
  );
  assert.equal(
    (await call<ShiftResponse>('GET', '/shifts/current', 200, owner)).shift.expectedCashPaisa,
    44500,
  );
  assert.equal(
    (
      await call<ExpenseSummaryDto>(
        'GET',
        `/expenses?from=${refundDate}&to=${refundDate}`,
        200,
        owner,
      )
    ).totalPaisa,
    5500,
  );
  await call(
    'POST',
    `/inventory/ingredients/${oil.id}/stock`,
    201,
    owner,
    {
      expectedVersion: 0,
      kind: 'PURCHASE',
      quantityMilli: 50000,
      costPaisa: 1000,
      expenseId: expense.expense.id,
      reason: 'Oil purchase already paid',
    },
    'oil-linked-purchase-key',
  );
  assert.equal(
    (
      await call<ExpenseSummaryDto>(
        'GET',
        `/expenses?from=${refundDate}&to=${refundDate}`,
        200,
        owner,
      )
    ).totalPaisa,
    5500,
    'linking an expense does not duplicate spending',
  );
  await call(
    'POST',
    `/inventory/ingredients/${meat.id}/stock`,
    409,
    owner,
    { ...purchase, quantityMilli: 1 },
    'stale-stock-count-key',
  );
  await call(
    'POST',
    `/inventory/ingredients/${meat.id}/stock`,
    201,
    owner,
    { expectedVersion: 1, kind: 'COUNT', quantityMilli: 800000, reason: 'Physical stock count' },
    'stock-count-key',
  );
  await call(
    'POST',
    `/inventory/ingredients/${meat.id}/stock`,
    201,
    owner,
    { expectedVersion: 2, kind: 'WASTE', quantityMilli: 50000, reason: 'Spoiled ingredients' },
    'stock-waste-key',
  );
  await call(
    'POST',
    `/inventory/ingredients/${meat.id}/stock`,
    409,
    owner,
    { expectedVersion: 3, kind: 'WASTE', quantityMilli: 800000, reason: 'Too much wastage' },
    'stock-waste-excess-key',
  );
  const category = await handle.prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: 'Food' },
  });
  const dish = await handle.prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: 'Momo', pricePaisa: 10000 },
  });
  const otherDish = await handle.prisma.menuItem.create({
    data: {
      restaurantId: restaurant.id,
      categoryId: category.id,
      name: 'Curry',
      pricePaisa: 15000,
    },
  });
  const recipe = {
    expectedVersion: 0,
    reason: 'Standard kitchen recipe',
    ingredients: [
      { ingredientId: meat.id, quantityMilli: 100000 },
      { ingredientId: oil.id, quantityMilli: 10000 },
    ],
  };
  await call('POST', `/inventory/recipes/${dish.id}`, 201, owner, recipe, 'recipe-first-key');
  await call('POST', `/inventory/recipes/${dish.id}`, 409, owner, recipe, 'recipe-stale-key');
  await call(
    'POST',
    `/inventory/recipes/${otherDish.id}`,
    201,
    owner,
    {
      ...recipe,
      ingredients: [
        { ingredientId: meat.id, quantityMilli: 200000 },
        { ingredientId: oil.id, quantityMilli: 5000 },
      ],
    },
    'recipe-other-key',
  );
  assert.equal((await inventory()).recipeChanges.length, 2);
  await handle.prisma.restaurantCounter.upsert({
    where: { restaurantId_name: { restaurantId: restaurant.id, name: 'ORDER' } },
    create: { restaurantId: restaurant.id, name: 'ORDER', nextValue: 1000 },
    update: { nextValue: 1000 },
  });
  const add = async (quantity: number) =>
    (
      await call<OrderResponse>('POST', '/orders/items', 201, tokens['WAITER'], {
        target: { kind: 'TAKEAWAY' },
        menuItemId: dish.id,
        quantity,
      })
    ).order;
  const pending = await add(2);
  let order = await add(3);
  order = (
    await call<OrderResponse>('POST', '/orders/items', 201, tokens['WAITER'], {
      target: { kind: 'ORDER', orderId: order.id, expectedVersion: order.version },
      menuItemId: otherDish.id,
      quantity: 2,
    })
  ).order;
  const dispatchBody = { expectedVersion: order.version };
  const dispatch = await call<SendToKitchenResponse>(
    'POST',
    `/orders/${order.id}/send-kot`,
    201,
    tokens['WAITER'],
    dispatchBody,
    'inventory-kitchen-send',
  );
  assert.deepEqual(
    await call(
      'POST',
      `/orders/${order.id}/send-kot`,
      201,
      tokens['WAITER'],
      dispatchBody,
      'inventory-kitchen-send',
    ),
    dispatch,
  );
  let stock = await inventory();
  assert.equal(stock.ingredients.find((row) => row.id === meat.id)!.onHandMilli, 50000);
  assert.equal(stock.ingredients.find((row) => row.id === oil.id)!.onHandMilli, 10000);
  assert.equal(
    stock.movements.filter((row) => row.kind === 'DISPATCH').length,
    2,
    'one aggregate deduction per ingredient in a ticket',
  );
  const menu = await call<MenuResponse>('GET', '/menu', 200, tokens['WAITER']);
  assert.equal(
    menu.categories.flatMap((row) => row.items).length,
    0,
    'shortage hides dishes from phones and till',
  );
  const ticketsBefore = await handle.prisma.kot.count();
  await call(
    'POST',
    `/orders/${pending.id}/send-kot`,
    409,
    tokens['WAITER'],
    { expectedVersion: pending.version },
    'stock-insufficient-send',
  );
  assert.equal(await handle.prisma.kot.count(), ticketsBefore);
  assert.equal(
    (await handle.prisma.order.findUniqueOrThrow({ where: { id: pending.id } })).version,
    pending.version,
    'failed dispatch rolls back the order claim',
  );
  assert.equal(
    (await inventory()).ingredients.find((row) => row.id === oil.id)!.onHandMilli,
    10000,
    'failed dispatch rolls back all ingredient writes',
  );
  assert.ok(
    (
      await call<{ ingredients: { id: string }[] }>('GET', '/inventory/alerts', 200, owner)
    ).ingredients.some((row) => row.id === meat.id),
  );
  for (const [ingredient, quantityMilli] of [
    [meat, 300000],
    [oil, 20000],
  ] as const) {
    const current = stock.ingredients.find((row) => row.id === ingredient.id)!;
    await call(
      'POST',
      `/inventory/ingredients/${ingredient.id}/stock`,
      201,
      owner,
      {
        expectedVersion: current.version,
        kind: 'COUNT',
        quantityMilli,
        reason: 'Replenished for service',
      },
      `restock-${ingredient.id}`,
    );
  }
  const raceOrders = [await add(2), await add(2)];
  const sendRace = await Promise.all(
    raceOrders.map((order, index) =>
      fetch(`${handle!.baseUrl}/orders/${order.id}/send-kot`, {
        method: 'POST',
        headers: {
          Connection: 'close',
          Authorization: `Bearer ${tokens['WAITER']}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': `stock-concurrent-send-${index}`,
        },
        body: JSON.stringify({ expectedVersion: order.version }),
      }),
    ),
  );
  assert.deepEqual(sendRace.map((row) => row.status).sort(), [201, 409]);
  await Promise.all(sendRace.map((row) => row.json()));
  stock = await inventory();
  assert.equal(stock.ingredients.find((row) => row.id === meat.id)!.onHandMilli, 100000);
  assert.equal(stock.ingredients.find((row) => row.id === oil.id)!.onHandMilli, 0);
  const availabilityBody = {
    expectedIsAvailable: true,
    isAvailable: false,
    reason: 'Kitchen stopped serving',
  };
  await call(
    'POST',
    `/menu/availability/${dish.id}`,
    201,
    tokens['KITCHEN'],
    availabilityBody,
    'kitchen-sold-out-key',
  );
  await call(
    'POST',
    `/menu/availability/${dish.id}`,
    201,
    tokens['KITCHEN'],
    availabilityBody,
    'kitchen-sold-out-key',
  );
  await call(
    'POST',
    `/menu/availability/${dish.id}`,
    409,
    tokens['WAITER'],
    availabilityBody,
    'waiter-stale-availability',
  );
  assert.equal((await inventory()).availabilityChanges.length, 1);
  assert.equal(
    (
      await call<AvailabilityResponse>('GET', '/menu/availability', 200, tokens['KITCHEN'])
    ).items.find((row) => row.id === dish.id)!.isAvailable,
    false,
  );
  const foreignRestaurant = await handle.prisma.restaurant.create({
    data: { name: 'Other', address: '', phone: '', panNumber: '' },
  });
  const foreignIngredient = await handle.prisma.ingredient.create({
    data: { restaurantId: foreignRestaurant.id, name: 'Foreign stock', unit: 'g' },
  });
  await call(
    'POST',
    `/inventory/ingredients/${foreignIngredient.id}/stock`,
    404,
    owner,
    {
      expectedVersion: 0,
      kind: 'COUNT',
      quantityMilli: 1000,
      reason: 'Must not change other restaurant',
    },
    'cross-restaurant-stock',
  );
  await call(
    'POST',
    `/inventory/recipes/${dish.id}`,
    409,
    owner,
    {
      ...recipe,
      expectedVersion: 1,
      ingredients: [{ ingredientId: foreignIngredient.id, quantityMilli: 1000 }],
    },
    'cross-restaurant-recipe',
  );
  assert.ok(!(await inventory()).ingredients.some((row) => row.id === foreignIngredient.id));
  const historyBefore = stock.movements.length;
  await stopNayaroServer(handle);
  handle = await start();
  const recovered = await inventory();
  assert.equal(recovered.movements.length, historyBefore);
  assert.equal(recovered.recipeChanges.length, 2);
  assert.deepEqual(
    await call(
      'POST',
      `/orders/${order.id}/send-kot`,
      201,
      tokens['WAITER'],
      dispatchBody,
      'inventory-kitchen-send',
    ),
    dispatch,
  );
  console.log(
    `Operations: ${checks} HTTP checks plus refunds, expenses, stock, recipes, concurrency, restart, permissions and drawer assertions passed.`,
  );
} finally {
  if (handle) await stopNayaroServer(handle);
  rmSync(root, { recursive: true, force: true });
}
