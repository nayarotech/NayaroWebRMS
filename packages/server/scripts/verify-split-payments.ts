import { createLegacyInvoiceFixture, createLegacyRestaurant } from './legacyInvoiceFixture';
/** Real payment routes against disposable SQLite: allocations, recovery and accounts. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createPrismaClient,
  ensureDataLayout,
  resolveDataLayout,
  toDatabaseFileUrl,
} from '@nayaro/database';
import { createClient } from '@libsql/client';
import { BUNDLED_MIGRATIONS } from '../../database/src/migrations.generated';
import {
  itemPaymentShares,
  selectedItemAmount,
  type BillingResponse,
  type DailyReportResponse,
  type InvoiceDto,
  type LoginResponse,
  type ShiftResponse,
} from '@nayaro/shared';
import { startNayaroServer, stopNayaroServer } from '../src/server';
import { hashPassword } from '../src/modules/auth/password';

const root = mkdtempSync(join(tmpdir(), 'nayaro-split-'));
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

async function main(): Promise<void> {
  // Upgrade an existing paid invoice without changing its money or fabricating allocations.
  const upgradePath = join(root, 'upgrade.db');
  const sqlite = createClient({ url: toDatabaseFileUrl(upgradePath) });
  const migration = BUNDLED_MIGRATIONS.find((row) =>
    row.name.endsWith('_payment_item_allocations'),
  )!;
  const oldClient = createPrismaClient({ databaseFilePath: upgradePath });
  try {
    for (const old of BUNDLED_MIGRATIONS.filter((row) => row.name < migration.name))
      await sqlite.executeMultiple(old.sql);
    const restaurant = await createLegacyRestaurant(sqlite);
    const staff = await oldClient.staff.create({
      data: {
        restaurantId: restaurant.id,
        name: 'Owner',
        username: 'old-owner',
        passwordHash: 'unused',
        role: 'OWNER',
      },
    });
    const { order, invoice } = await createLegacyInvoiceFixture(
      sqlite,
      restaurant.id,
      staff.id,
      true,
    );
    const payment = await oldClient.payment.create({
      data: {
        restaurantId: restaurant.id,
        orderId: order.id,
        invoiceId: invoice.id,
        method: 'CASH',
        amountPaisa: 10000,
        receivedByStaffId: staff.id,
      },
    });
    await sqlite.executeMultiple(migration.sql);
    const retained = await oldClient.payment.findUniqueOrThrow({
      where: { id: payment.id },
      include: { itemAllocations: true },
    });
    assert.equal(retained.amountPaisa, 10000);
    assert.deepEqual(retained.itemAllocations, []);
    assert.equal(
      (
        await oldClient.invoice.findUniqueOrThrow({
          where: { id: invoice.id },
          select: { grandTotalPaisa: true },
        })
      ).grandTotalPaisa,
      10000,
    );
    const line = await oldClient.invoiceLine.findFirstOrThrow({ select: { id: true } });
    for (const invalid of [
      { quantity: 0, amountPaisa: 1 },
      { quantity: 1, amountPaisa: -1 },
    ])
      await assert.rejects(() =>
        oldClient.paymentItemAllocation.create({
          data: { paymentId: payment.id, invoiceLineId: line.id, ...invalid },
        }),
      );
    assert.equal(await oldClient.paymentItemAllocation.count(), 0);
  } finally {
    await oldClient.$disconnect();
    sqlite.close();
  }
  const start = () =>
    startNayaroServer({
      port: 4353,
      host: '127.0.0.1',
      databaseFilePath: layout.databaseFilePath,
      silent: true,
    });
  handle = await start();
  await call('POST', '/tenants/register', 201, undefined, {
    restaurant: { slug: 'verify-restaurant', name: 'Split payment pilot' },
    owner: { name: 'Owner', username: 'owner', password: 'pilot-password-123' },
  });
  const owner = (
    await call<LoginResponse>('POST', '/auth/login', 200, undefined, {
      workspace: 'verify-restaurant', username: 'owner',
      password: 'pilot-password-123',
    })
  ).token;
  const restaurant = await handle.prisma.restaurant.findFirstOrThrow();
  const ownerStaff = await handle.prisma.staff.findFirstOrThrow();
  const tokens: Record<string, string> = {};
  for (const role of ['CASHIER', 'WAITER', 'KITCHEN'] as const) {
    await handle.prisma.staff.create({
      data: {
        restaurantId: restaurant.id,
        name: role,
        username: role.toLowerCase(),
        role,
        passwordHash: await hashPassword('pilot-password-123'),
      },
    });
    tokens[role] = (
      await call<LoginResponse>('POST', '/auth/login', 200, undefined, {
        workspace: 'verify-restaurant', username: role.toLowerCase(),
        password: 'pilot-password-123',
      })
    ).token;
  }
  const cashier = tokens['CASHIER']!;
  const customer = await handle.prisma.customer.create({
    data: { restaurantId: restaurant.id, name: 'Guest account' },
  });
  const area = await handle.prisma.restaurantArea.create({
    data: { restaurantId: restaurant.id, name: 'Pilot' },
  });
  let sequence = 0;
  // Frozen invoice fixtures: 750 - 75 + 67.50 + 96.53 - 0.03 = Rs 839.
  // Momo gets 73832 paisa, Coke 10068. The three momo shares are 24610/24611/24611.
  const fixture = async () => {
    sequence++;
    const table = await handle!.prisma.restaurantTable.create({
      data: { restaurantId: restaurant.id, areaId: area.id, name: `T${sequence}` },
    });
    const order = await handle!.prisma.order.create({
      data: {
        restaurantId: restaurant.id,
        orderNumber: sequence,
        type: 'DINE_IN',
        status: 'BILLED',
        tableId: table.id,
        openedByStaffId: ownerStaff.id,
        businessDate: '2026-10-28',
      },
    });
    const invoice = await handle!.prisma.invoice.create({
      data: {
        restaurantId: restaurant.id,
        orderId: order.id,
        invoiceNumber: sequence,
        fiscalYearStartBsYear: 2083,
        issuedByStaffId: ownerStaff.id,
        businessDate: '2026-10-28',
        subtotalPaisa: 75000,
        discountType: 'PERCENT',
        discountValue: 1000,
        discountPaisa: 7500,
        serviceChargeRateBp: 1000,
        serviceChargePaisa: 6750,
        vatRateBp: 1300,
        vatPaisa: 9653,
        roundingAdjustmentPaisa: -3,
        grandTotalPaisa: 83900,
        lines: {
          create: [
            {
              lineNumber: 1,
              description: 'Momo',
              quantity: 3,
              unitPricePaisa: 22000,
              lineTotalPaisa: 66000,
            },
            {
              lineNumber: 2,
              description: 'Coke',
              quantity: 1,
              unitPricePaisa: 9000,
              lineTotalPaisa: 9000,
            },
          ],
        },
      },
    });
    const bill = (await call<BillingResponse>('GET', `/orders/${order.id}/billing`, 200, cashier))
      .invoice!;
    return { invoice: bill, order, table, path: `/invoices/${invoice.id}/payments` };
  };
  const fresh = async (orderId: string) =>
    (await call<BillingResponse>('GET', `/orders/${orderId}/billing`, 200, cashier)).invoice!;
  const report = () =>
    call<DailyReportResponse>('GET', '/reports/daily?date=2026-10-28', 200, owner);
  await call('POST', '/shifts', 201, cashier, { openingFloatPaisa: 10000 });
  const f = await fixture();
  const momo = f.invoice.lines[0]!;
  const coke = f.invoice.lines[1]!;
  // Exact arithmetic at large prices, ties and a fully discounted bill.
  const tied = {
    ...f.invoice,
    grandTotalPaisa: 1,
    lines: f.invoice.lines.map((line) => ({ ...line, quantity: 1, lineTotalPaisa: 1 })),
  };
  assert.deepEqual(
    itemPaymentShares(tied).map((share) => share.remainingPaisa),
    [1, 0],
  );
  assert.deepEqual(
    itemPaymentShares({ ...tied, lines: [...tied.lines].reverse() }).map(
      (share) => share.remainingPaisa,
    ),
    [1, 0],
    'line order cannot change remainder allocation',
  );
  assert.deepEqual(
    itemPaymentShares({ ...tied, grandTotalPaisa: 0 }).map((share) => share.remainingPaisa),
    [0, 0],
  );
  const large = {
    ...f.invoice,
    grandTotalPaisa: 999999999,
    lines: f.invoice.lines.map((line) => ({ ...line, lineTotalPaisa: 499999999 })),
  };
  assert.deepEqual(
    itemPaymentShares(large).map((share) => share.remainingPaisa),
    [500000000, 499999999],
  );
  assert.deepEqual(
    itemPaymentShares(f.invoice).map((share) => share.remainingPaisa),
    [73832, 10068],
  );
  const body = {
    expectedOrderVersion: f.invoice.orderVersion,
    method: 'CASH',
    amountPaisa: 24610,
    tenderedPaisa: 30000,
    items: [{ invoiceLineId: momo.id, quantity: 1 }],
  };
  for (const [token, status] of [
    [undefined, 401],
    [tokens['WAITER'], 403],
    [tokens['KITCHEN'], 403],
  ] as const)
    await call('POST', f.path, status, token, body);
  for (const items of [
    [],
    [{ invoiceLineId: momo.id, quantity: 0 }],
    [{ invoiceLineId: momo.id, quantity: 1.5 }],
    [body.items[0], body.items[0]],
  ])
    await call('POST', f.path, 400, cashier, { ...body, items });
  await call('POST', f.path, 409, cashier, { ...body, amountPaisa: 24611 });
  await call('POST', f.path, 409, cashier, {
    ...body,
    items: [{ invoiceLineId: momo.id, quantity: 4 }],
  });
  const foreign = await fixture();
  await call('POST', f.path, 409, cashier, {
    ...body,
    items: [{ invoiceLineId: foreign.invoice.lines[0]!.id, quantity: 1 }],
  });
  assert.equal(
    (await fresh(f.order.id)).orderVersion,
    body.expectedOrderVersion,
    'invalid allocations roll back the version claim',
  );
  const before = await report();
  const key = 'split-payment-replay-0001';
  let paid = (await call<{ invoice: InvoiceDto }>('POST', f.path, 201, cashier, body, key)).invoice;
  assert.equal(paid.settlement.status, 'PARTIAL');
  assert.equal(paid.settlement.remainingPaisa, 59290);
  assert.equal(paid.settlement.payments[0]!.changePaisa, 5390);
  assert.deepEqual(paid.settlement.payments[0]!.itemAllocations, [
    { invoiceLineId: momo.id, quantity: 1, amountPaisa: 24610 },
  ]);
  const liveOrder = await handle.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } });
  assert.equal(liveOrder.status, 'BILLED');
  assert.equal(liveOrder.closedAt, null);
  const during = await report();
  assert.equal(
    during.sales.grandTotalPaisa,
    before.sales.grandTotalPaisa,
    'payment is not another sale',
  );
  assert.equal(during.payments.outstandingPaisa, before.payments.outstandingPaisa - 24610);
  assert.equal(
    (await call<ShiftResponse>('GET', '/shifts/current', 200, cashier)).shift.expectedCashPaisa,
    34610,
    'cash applied excludes change',
  );
  const replay = await call<{ invoice: InvoiceDto }>('POST', f.path, 201, cashier, body, key);
  assert.deepEqual(replay.invoice, paid);
  await call(
    'POST',
    f.path,
    409,
    cashier,
    { ...body, items: [{ invoiceLineId: coke.id, quantity: 1 }] },
    key,
  );
  await stopNayaroServer(handle);
  handle = await start();
  assert.deepEqual(
    (await call<{ invoice: InvoiceDto }>('POST', f.path, 201, cashier, body, key)).invoice,
    paid,
    'durable receipt survives restart',
  );
  assert.equal(await handle.prisma.paymentItemAllocation.count(), 1);
  assert.deepEqual((await fresh(f.order.id)).settlement.payments, paid.settlement.payments);
  const paymentId = paid.settlement.payments[0]!.id;
  await call('POST', `/payments/${paymentId}/void`, 403, cashier, {
    reason: 'Wrong payment method',
  });
  paid = (
    await call<{ invoice: InvoiceDto }>('POST', `/payments/${paymentId}/void`, 200, owner, {
      reason: 'Wrong payment method',
    })
  ).invoice;
  assert.equal(paid.settlement.remainingPaisa, 83900);
  assert.equal(itemPaymentShares(paid)[0]!.remainingQuantity, 3);
  assert.equal(itemPaymentShares(paid)[0]!.remainingPaisa, 73832);
  assert.equal(
    paid.settlement.payments[0]!.itemAllocations.length,
    1,
    'reversal keeps allocation history',
  );
  assert.equal(
    (await call<ShiftResponse>('GET', '/shifts/current', 200, cashier)).shift.expectedCashPaisa,
    10000,
  );
  for (const [method, line, amount] of [
    ['CASH', momo, 24610],
    ['QR', momo, 24611],
    ['CARD', momo, 24611],
    ['CREDIT', coke, 10068],
  ] as const) {
    const share = itemPaymentShares(paid).find((row) => row.invoiceLineId === line.id)!;
    assert.equal(selectedItemAmount(share, 1), amount);
    paid = (
      await call<{ invoice: InvoiceDto }>('POST', f.path, 201, cashier, {
        expectedOrderVersion: paid.orderVersion,
        method,
        amountPaisa: amount,
        items: [{ invoiceLineId: line.id, quantity: 1 }],
        ...(method === 'CREDIT' ? { customerId: customer.id } : {}),
      })
    ).invoice;
  }
  assert.equal(paid.settlement.remainingPaisa, 0);
  assert.equal(paid.settlement.totalPaidPaisa, 83900);
  assert.equal(paid.grandTotalPaisa, 83900);
  assert.equal(
    (await handle.prisma.order.findUniqueOrThrow({ where: { id: f.order.id } })).status,
    'PAID',
  );
  const floor = await call<{ areas: { tables: { id: string; status: string }[] }[] }>(
    'GET',
    '/floor',
    200,
    cashier,
  );
  assert.equal(
    floor.areas.flatMap((area) => area.tables).find((table) => table.id === f.table.id)!.status,
    'AVAILABLE',
  );
  assert.equal(
    (await report()).payments.byMethod.reduce((sum, row) => sum + row.amountPaisa, 0),
    83900,
  );
  assert.equal(
    (await report()).payments.byMethod.find((row) => row.method === 'CREDIT')!.amountPaisa,
    10068,
  );
  await call(
    'POST',
    `/payments/${paid.settlement.payments.find((row) => row.void === null)!.id}/void`,
    409,
    owner,
    { reason: 'Cannot reverse a settled sale' },
  );

  // A selected quantity cannot be paid twice, including concurrent attempts.
  const race = await fixture();
  const raceBody = {
    expectedOrderVersion: race.invoice.orderVersion,
    method: 'QR',
    amountPaisa: 10068,
    items: [{ invoiceLineId: race.invoice.lines[1]!.id, quantity: 1 }],
  };
  const responses = await Promise.all(
    [0, 1].map(() =>
      fetch(`${handle!.baseUrl}${race.path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cashier}`,
          'Content-Type': 'application/json',
          Connection: 'close',
        },
        body: JSON.stringify(raceBody),
      }),
    ),
  );
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  await Promise.all(responses.map((response) => response.json()));
  const raceBill = await fresh(race.order.id);
  await call('POST', race.path, 409, cashier, {
    ...raceBody,
    expectedOrderVersion: raceBill.orderVersion,
  });
  assert.equal(await handle.prisma.payment.count({ where: { invoiceId: race.invoice.id } }), 1);

  // Amount payments remain supported; item identity cannot be inferred from money.
  const mixed = await fixture();
  let mixedBill = (
    await call<{ invoice: InvoiceDto }>('POST', mixed.path, 201, cashier, {
      expectedOrderVersion: mixed.invoice.orderVersion,
      method: 'QR',
      amountPaisa: 100,
    })
  ).invoice;
  await call('POST', mixed.path, 409, cashier, {
    ...raceBody,
    expectedOrderVersion: mixedBill.orderVersion,
    items: [{ invoiceLineId: mixed.invoice.lines[1]!.id, quantity: 1 }],
  });
  mixedBill = (
    await call<{ invoice: InvoiceDto }>('POST', mixed.path, 201, cashier, {
      expectedOrderVersion: mixedBill.orderVersion,
      method: 'CARD',
      amountPaisa: mixedBill.settlement.remainingPaisa,
    })
  ).invoice;
  assert.equal(mixedBill.settlement.status, 'PAID');
  assert.equal(mixedBill.settlement.payments.length, 2);
  // A cashier may finish an item-split bill by amount, with no duplicate sale.
  const finish = await fixture();
  const firstItem = finish.invoice.lines[1]!;
  let finishBill = (
    await call<{ invoice: InvoiceDto }>('POST', finish.path, 201, cashier, {
      expectedOrderVersion: finish.invoice.orderVersion,
      method: 'QR',
      amountPaisa: 10068,
      items: [{ invoiceLineId: firstItem.id, quantity: 1 }],
    })
  ).invoice;
  finishBill = (
    await call<{ invoice: InvoiceDto }>('POST', finish.path, 201, cashier, {
      expectedOrderVersion: finishBill.orderVersion,
      method: 'CASH',
      amountPaisa: finishBill.settlement.remainingPaisa,
    })
  ).invoice;
  assert.equal(finishBill.settlement.status, 'PAID');
  console.log(
    `Split payments: ${checks} HTTP checks plus allocation, rounding, reversal, restart, report and drawer assertions passed.`,
  );
}

try {
  await main();
} finally {
  if (handle) await stopNayaroServer(handle);
  rmSync(root, { recursive: true, force: true });
}
