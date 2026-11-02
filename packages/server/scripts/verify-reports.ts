/**
 * Cash drawer and end-of-day report verification - drives the real HTTP API.
 *
 *   npm run verify:reports --workspace @nayaro/server
 *
 * Builds one realistic trading day through the API - cash and QR sales, a
 * discount, a reversed payment, a voided bill, a cancelled item, a voided
 * ticket, petty cash - then checks that the drawer and the Z report both say
 * exactly what happened, to the paisa.
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import type {
  CurrentShiftResponse,
  DailyReportResponse,
  InvoiceDto,
  OrderDto,
  SendToKitchenResponse,
  ShiftDto,
} from '@nayaro/shared';
import { ensureDataLayout, resolveDataLayout } from '@nayaro/database';
import { createLogger } from '../src/utils/logger';
import { startNayaroServer, stopNayaroServer, type NayaroServerHandle } from '../src/server';
import { hashPassword } from '../src/modules/auth/password';

const ROOT = resolve(tmpdir(), 'nayaro-reports-verify');
const PORT = 4337;

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) pass += 1;
  else fail += 1;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  -> ${String(detail)}`}`,
  );
}

interface Res {
  readonly status: number;
  readonly body: unknown;
}

function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<Res> {
  return new Promise((res, rej) => {
    const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method,
        agent: false,
        headers: {
          ...(payload === null ? {} : { 'Content-Type': 'application/json' }),
          ...(opts.token === undefined ? {} : { Authorization: `Bearer ${opts.token}` }),
        },
      },
      (r) => {
        let raw = '';
        r.setEncoding('utf8');
        r.on('data', (c: string) => (raw += c));
        r.on('end', () => {
          let body: unknown = null;
          if (raw.length > 0) {
            try {
              body = JSON.parse(raw) as unknown;
            } catch {
              body = raw;
            }
          }
          res({ status: r.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', rej);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

const errorCode = (body: unknown): string | undefined =>
  (body as { error?: { code?: string } } | null)?.error?.code;
const orderOf = (body: unknown): OrderDto => (body as { order: OrderDto }).order;
const invoiceOf = (body: unknown): InvoiceDto => (body as { invoice: InvoiceDto }).invoice;
const shiftOf = (body: unknown): ShiftDto => (body as { shift: ShiftDto }).shift;

async function main(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true });
  const layout = ensureDataLayout(resolveDataLayout(ROOT));
  const handle: NayaroServerHandle = await startNayaroServer({
    port: PORT,
    databaseFilePath: layout.databaseFilePath,
    logger: createLogger({ scope: 'verify-reports', silent: true }),
  });
  const { prisma } = handle;

  try {
    console.log('[setup]');
    await call('POST', '/tenants/register', {
      body: {
        restaurant: { slug: 'verify-restaurant', name: 'Himali Bhansa Ghar' },
        owner: { name: 'Rajan Shrestha', username: 'rajan.s', password: 'correct-horse-battery' },
      },
    });
    const restaurant = await prisma.restaurant.findFirstOrThrow();
    for (const [name, username, role] of [
      ['Sunita Karki', 'sunita.k', 'MANAGER'],
      ['Bikash Tamang', 'bikash.t', 'CASHIER'],
      ['Hari Thapa', 'hari.t', 'WAITER'],
    ] as const) {
      await prisma.staff.create({
        data: {
          restaurantId: restaurant.id,
          name,
          username,
          passwordHash: await hashPassword('staff1234'),
          role,
        },
      });
    }
    const tokenFor = async (u: string, p: string): Promise<string> =>
      (
        (await call('POST', '/auth/login', { body: { workspace: 'verify-restaurant', username: u, password: p } })).body as {
          token: string;
        }
      ).token;
    const owner = await tokenFor('rajan.s', 'correct-horse-battery');
    const manager = await tokenFor('sunita.k', 'staff1234');
    const cashier = await tokenFor('bikash.t', 'staff1234');
    const waiter = await tokenFor('hari.t', 'staff1234');

    const area = await prisma.restaurantArea.create({
      data: { restaurantId: restaurant.id, name: 'Ground Floor' },
    });
    const momoCat = await prisma.menuCategory.create({
      data: { restaurantId: restaurant.id, name: 'Momo' },
    });
    const drinksCat = await prisma.menuCategory.create({
      data: { restaurantId: restaurant.id, name: 'Drinks', sortOrder: 1 },
    });
    const momo = await prisma.menuItem.create({
      data: {
        restaurantId: restaurant.id,
        categoryId: momoCat.id,
        name: 'Chicken Momo',
        pricePaisa: 22000,
      },
    });
    const coke = await prisma.menuItem.create({
      data: {
        restaurantId: restaurant.id,
        categoryId: drinksCat.id,
        name: 'Coke',
        pricePaisa: 9000,
      },
    });

    let seq = 0;
    const version = async (orderId: string): Promise<number> =>
      (await prisma.order.findFirstOrThrow({ where: { id: orderId } })).version;

    /** Builds an order with the given lines and sends it to the kitchen. */
    const sentOrder = async (
      lines: { id: string; quantity: number }[],
      takeaway = false,
    ): Promise<{ order: OrderDto; kotId: string }> => {
      let target: unknown;
      if (takeaway) {
        target = { kind: 'TAKEAWAY' };
      } else {
        seq += 1;
        const table = await prisma.restaurantTable.create({
          data: { restaurantId: restaurant.id, areaId: area.id, name: `Table ${String(seq)}` },
        });
        target = { kind: 'TABLE', tableId: table.id };
      }
      let order = orderOf(
        (
          await call('POST', '/orders/items', {
            token: cashier,
            body: { target, menuItemId: lines[0]!.id, quantity: lines[0]!.quantity },
          })
        ).body,
      );
      for (const line of lines.slice(1)) {
        order = orderOf(
          (
            await call('POST', '/orders/items', {
              token: cashier,
              body: {
                target: { kind: 'ORDER', orderId: order.id, expectedVersion: order.version },
                menuItemId: line.id,
                quantity: line.quantity,
              },
            })
          ).body,
        );
      }
      const sent = (
        await call('POST', `/orders/${order.id}/send-kot`, {
          token: cashier,
          body: { expectedVersion: order.version },
        })
      ).body as SendToKitchenResponse;
      return { order: sent.order, kotId: sent.kot.id };
    };
    const issue = async (orderId: string): Promise<InvoiceDto> =>
      invoiceOf(
        (
          await call('POST', `/orders/${orderId}/invoice`, {
            token: cashier,
            body: { expectedVersion: await version(orderId) },
          })
        ).body,
      );
    const pay = async (
      invoice: InvoiceDto,
      method: string,
      amountPaisa: number,
      extra: object = {},
    ): Promise<Res> =>
      call('POST', `/invoices/${invoice.id}/payments`, {
        token: cashier,
        body: {
          expectedOrderVersion: await version(invoice.orderId),
          method,
          amountPaisa,
          ...extra,
        },
      });
    check('fixtures created', true);

    // --------------------------------------------------------------- roles
    console.log('\n[roles]');
    let r = await call('GET', '/shifts/current', { token: waiter });
    check('waiter cannot see the drawer -> 403', r.status === 403, r.status);
    r = await call('POST', '/shifts', { token: waiter, body: { openingFloatPaisa: 0 } });
    check('waiter cannot open the drawer -> 403', r.status === 403, r.status);
    r = await call('GET', '/reports/daily', { token: cashier });
    check('cashier cannot read the Z report -> 403', r.status === 403, r.status);
    r = await call('GET', '/reports/daily', { token: waiter });
    check('waiter cannot read the Z report -> 403', r.status === 403, r.status);

    // ---------------------------------------------------------- open drawer
    console.log('\n[open] the drawer');
    r = await call('GET', '/shifts/current', { token: cashier });
    check('no shift yet -> { shift: null }', (r.body as CurrentShiftResponse).shift === null);
    r = await call('POST', '/shifts', { token: cashier, body: { openingFloatPaisa: -1 } });
    check('negative float -> 400', r.status === 400, r.status);

    // Two terminals pressing Open at once: one drawer, one refusal.
    const [a, b] = await Promise.all([
      call('POST', '/shifts', { token: cashier, body: { openingFloatPaisa: 200000 } }),
      call('POST', '/shifts', { token: manager, body: { openingFloatPaisa: 200000 } }),
    ]);
    check(
      'concurrent opens -> exactly one 201',
      [a.status, b.status].sort().join() === '201,409',
      `${String(a.status)},${String(b.status)}`,
    );
    const opened = shiftOf((a.status === 201 ? a : b).body);
    check('opened with a 2000.00 float', opened.openingFloatPaisa === 200000);
    check('status OPEN', opened.status === 'OPEN');
    check('expected cash is the float', opened.expectedCashPaisa === 200000);
    r = await call('POST', '/shifts', { token: cashier, body: { openingFloatPaisa: 0 } });
    check(
      'a second open -> 409 SHIFT_ALREADY_OPEN',
      errorCode(r.body) === 'SHIFT_ALREADY_OPEN',
      r.status,
    );
    check(
      'database holds one open shift',
      (await prisma.shift.count({ where: { closedAt: null } })) === 1,
    );
    const shiftId = opened.id;

    // ------------------------------------------------------------ trade day
    console.log('\n[trade] one evening of service');
    // A: 2 momo + 1 coke = 530.00, cash with change.
    const A = await sentOrder([
      { id: momo.id, quantity: 2 },
      { id: coke.id, quantity: 1 },
    ]);
    const invA = await issue(A.order.id);
    r = await pay(invA, 'CASH', 53000, { tenderedPaisa: 100000 });
    check('A paid 530.00 cash (1000 tendered)', r.status === 201, r.status);

    // B: takeaway, 1 momo = 220.00, QR.
    const B = await sentOrder([{ id: momo.id, quantity: 1 }], true);
    const invB = await issue(B.order.id);
    r = await pay(invB, 'QR', 22000, { reference: 'FP-1' });
    check('B paid 220.00 by QR', r.status === 201, r.status);

    // C: 1 momo + 1 coke = 310.00, manager discounts 50.00 -> 260.00. A wrong
    // 100.00 cash payment is taken and reversed, then the real one.
    const C = await sentOrder([
      { id: momo.id, quantity: 1 },
      { id: coke.id, quantity: 1 },
    ]);
    r = await call('PATCH', `/orders/${C.order.id}/discount`, {
      token: manager,
      body: {
        expectedVersion: await version(C.order.id),
        discountType: 'FIXED',
        discountValue: 5000,
      },
    });
    check('C discounted 50.00 by the manager', r.status === 200, r.status);
    const invC = await issue(C.order.id);
    check('C billed at 260.00', invC.grandTotalPaisa === 26000, invC.grandTotalPaisa);
    r = await pay(invC, 'CASH', 10000);
    const wrongPayment = invoiceOf(r.body).settlement.payments[0]!;
    r = await call('POST', `/payments/${wrongPayment.id}/void`, {
      token: manager,
      body: { reason: 'Keyed the wrong amount' },
    });
    check('the wrong payment was reversed', r.status === 200, r.status);
    r = await pay(invC, 'CASH', 26000);
    check('C then paid 260.00 cash', r.status === 201, r.status);

    // D: 1 momo billed, then the bill is voided. The order stays open.
    const D = await sentOrder([{ id: momo.id, quantity: 1 }]);
    const invD = await issue(D.order.id);
    r = await call('POST', `/invoices/${invD.id}/void`, {
      token: owner,
      body: { reason: 'Billed to the wrong table' },
    });
    check('D bill voided', r.status === 200, r.status);

    // E: 3 momo sent, 1 cancelled after dispatch -> 440.00, left unpaid.
    const E = await sentOrder([{ id: momo.id, quantity: 3 }]);
    r = await call('POST', `/orders/${E.order.id}/items/${E.order.items[0]!.id}/cancellations`, {
      token: manager,
      body: { quantity: 1, reason: 'Customer changed their mind' },
    });
    check('E one momo cancelled', r.status === 201, r.status);
    const invE = await issue(E.order.id);
    check('E billed at 440.00', invE.grandTotalPaisa === 44000, invE.grandTotalPaisa);

    // G: a ticket sent in error and voided. The order is left unbilled.
    const G = await sentOrder([{ id: coke.id, quantity: 1 }]);
    r = await call('POST', `/kitchen/tickets/${G.kotId}/void`, {
      token: manager,
      body: { reason: 'Sent to the wrong table' },
    });
    check('G ticket voided', r.status === 200, r.status);

    // ------------------------------------------------------- drawer movement
    console.log('\n[movements] pay in, pay out');
    r = await call('POST', `/shifts/${shiftId}/movements`, {
      token: cashier,
      body: { type: 'PAY_IN', amountPaisa: 50000, reason: 'Change from the bank' },
    });
    check('pay-in 500.00 -> 201', r.status === 201, r.status);
    r = await call('POST', `/shifts/${shiftId}/movements`, {
      token: cashier,
      body: { type: 'PAY_OUT', amountPaisa: 15000, reason: 'Vegetables from the market' },
    });
    check('pay-out 150.00 -> 201', r.status === 201, r.status);
    r = await call('POST', `/shifts/${shiftId}/movements`, {
      token: cashier,
      body: { type: 'PAY_OUT', amountPaisa: 10_000_000, reason: 'Typo with extra zeros' },
    });
    check(
      'pay-out larger than the drawer -> 409 NOT_ENOUGH_CASH',
      errorCode(r.body) === 'NOT_ENOUGH_CASH',
      r.status,
    );
    r = await call('POST', `/shifts/${shiftId}/movements`, {
      token: cashier,
      body: { type: 'PAY_OUT', amountPaisa: 100, reason: '  ' },
    });
    check('blank reason -> 400', r.status === 400, r.status);

    const live = (
      (await call('GET', '/shifts/current', { token: cashier })).body as CurrentShiftResponse
    ).shift!;
    check(
      'cash sales 790.00 (530 + 260; the reversed 100 is not in the drawer)',
      live.cashSalesPaisa === 79000,
      live.cashSalesPaisa,
    );
    check(
      'QR is a taking, not drawer cash',
      live.takings.find((t) => t.method === 'QR')?.amountPaisa === 22000,
    );
    check('pay-ins 500.00', live.payInsPaisa === 50000);
    check('pay-outs 150.00', live.payOutsPaisa === 15000);
    // 2000 + 790 + 500 - 150
    check('expected cash 3140.00', live.expectedCashPaisa === 314000, live.expectedCashPaisa);
    check(
      'both movements listed, named',
      live.movements.length === 2 && live.movements.every((m) => m.staff.name === 'Bikash Tamang'),
    );

    // ------------------------------------------------------------- the report
    console.log('\n[report] the Z report for today');
    r = await call('GET', '/reports/daily', { token: manager });
    check('manager reads the report -> 200', r.status === 200, r.status);
    const report = r.body as DailyReportResponse;
    check('dated today', report.businessDate === invA.businessDate, report.businessDate);

    const s = report.sales;
    check('4 live bills (the voided one is not a sale)', s.invoiceCount === 4, s.invoiceCount);
    // 530 + 220 + 310 + 440 = 1500 before discount
    check('subtotal 1500.00', s.subtotalPaisa === 150000, s.subtotalPaisa);
    check('discounts 50.00', s.discountPaisa === 5000, s.discountPaisa);
    check('grand total 1450.00', s.grandTotalPaisa === 145000, s.grandTotalPaisa);
    check('average bill 362.50', s.averageBillPaisa === 36250, s.averageBillPaisa);
    check(
      'components add up to the total',
      s.subtotalPaisa - s.discountPaisa + s.serviceChargePaisa + s.vatPaisa + s.roundingPaisa ===
        s.grandTotalPaisa,
    );
    const dineIn = report.byOrderType.find((t) => t.type === 'DINE_IN');
    const takeaway = report.byOrderType.find((t) => t.type === 'TAKEAWAY');
    check(
      'dine-in 3 bills, 1230.00',
      dineIn?.invoiceCount === 3 && dineIn.grandTotalPaisa === 123000,
    );
    check(
      'takeaway 1 bill, 220.00',
      takeaway?.invoiceCount === 1 && takeaway.grandTotalPaisa === 22000,
    );

    const p = report.payments;
    const cash = p.byMethod.find((m) => m.method === 'CASH');
    check(
      'cash 790.00 over 2 payments',
      cash?.amountPaisa === 79000 && cash.count === 2,
      `${String(cash?.amountPaisa)} / ${String(cash?.count)}`,
    );
    check('QR 220.00', p.byMethod.find((m) => m.method === 'QR')?.amountPaisa === 22000);
    check('collected 1010.00', p.totalPaisa === 101000, p.totalPaisa);
    check(
      'outstanding 440.00 on 1 bill',
      p.outstandingPaisa === 44000 && p.unpaidInvoiceCount === 1,
    );

    const momoRow = report.items.find((i) => i.name === 'Chicken Momo');
    const cokeRow = report.items.find((i) => i.name === 'Coke');
    // A2 + B1 + C1 + E2 (3 sent, 1 cancelled). D was voided.
    check(
      '6 momo sold for 1320.00',
      momoRow?.quantity === 6 && momoRow.totalPaisa === 132000,
      `${String(momoRow?.quantity)} / ${String(momoRow?.totalPaisa)}`,
    );
    check('2 coke sold for 180.00', cokeRow?.quantity === 2 && cokeRow.totalPaisa === 18000);
    check('best seller first', report.items[0]?.name === 'Chicken Momo');
    check(
      'items carry their category',
      momoRow?.category === 'Momo' && cokeRow?.category === 'Drinks',
    );
    check(
      'categories total the subtotal',
      report.categories.reduce((t, c) => t + c.totalPaisa, 0) === s.subtotalPaisa,
    );
    check(
      'all sales attributed to the cashier who issued them',
      report.staff.length === 1 &&
        report.staff[0]?.staff.name === 'Bikash Tamang' &&
        report.staff[0].grandTotalPaisa === 145000,
    );

    check(
      'one discount, 50.00',
      report.discounts.rows.length === 1 && report.discounts.totalPaisa === 5000,
    );
    check(
      'discount names its approver',
      report.discounts.rows[0]?.approvedBy?.name === 'Sunita Karki',
    );

    const c = report.corrections;
    check(
      'voided bill listed with reason and who',
      c.voidedInvoices.length === 1 &&
        c.voidedInvoices[0]?.reason === 'Billed to the wrong table' &&
        c.voidedInvoices[0].voidedBy.name === 'Rajan Shrestha',
    );
    check(
      'reversed payment listed',
      c.voidedPayments.length === 1 &&
        c.voidedPayments[0]?.amountPaisa === 10000 &&
        c.voidedPayments[0].method === 'CASH',
    );
    check(
      'cancelled item listed with its value',
      c.cancelledItems.length === 1 &&
        c.cancelledItems[0]?.valuePaisa === 22000 &&
        c.cancelledItems[0].quantity === 1,
    );
    check(
      'voided ticket listed',
      c.voidedTickets.length === 1 && c.voidedTickets[0]?.reason === 'Sent to the wrong table',
    );

    check(
      '2 orders still unbilled (D reopened, G)',
      report.unbilledOrders.length === 2,
      report.unbilledOrders.map((o) => o.orderNumber).join(),
    );
    check(
      'the open drawer is in the report',
      report.shifts.length === 1 && report.shifts[0]?.status === 'OPEN',
    );

    r = await call('GET', '/reports/daily?date=2000-01-01', { token: owner });
    const empty = r.body as DailyReportResponse;
    check(
      'a day with no trade is all zeros',
      r.status === 200 &&
        empty.sales.invoiceCount === 0 &&
        empty.items.length === 0 &&
        empty.shifts.length === 0,
    );
    r = await call('GET', '/reports/daily?date=yesterday', { token: owner });
    check('malformed date -> 400', r.status === 400, r.status);

    // ------------------------------------------------------------- close
    console.log('\n[close] count the drawer');
    r = await call('POST', `/shifts/${shiftId}/close`, {
      token: cashier,
      body: { countedCashPaisa: 310000, note: 'Short by 40, could not find it' },
    });
    check('closed -> 200', r.status === 200, r.status);
    const closed = shiftOf(r.body);
    check('status CLOSED', closed.status === 'CLOSED');
    check('expected frozen at 3140.00', closed.close?.expectedCashPaisa === 314000);
    check('counted 3100.00', closed.close?.countedCashPaisa === 310000);
    check(
      'variance -40.00 (short)',
      closed.close?.variancePaisa === -4000,
      closed.close?.variancePaisa,
    );
    check('closer is named', closed.close?.closedBy.name === 'Bikash Tamang');
    check('note kept', closed.close?.note === 'Short by 40, could not find it');

    r = await call('POST', `/shifts/${shiftId}/close`, {
      token: manager,
      body: { countedCashPaisa: 314000 },
    });
    check('a second close -> 409 SHIFT_CLOSED', errorCode(r.body) === 'SHIFT_CLOSED', r.status);
    r = await call('POST', `/shifts/${shiftId}/movements`, {
      token: cashier,
      body: { type: 'PAY_IN', amountPaisa: 100, reason: 'After close' },
    });
    check('no movements on a closed shift -> 409', errorCode(r.body) === 'SHIFT_CLOSED', r.status);
    r = await call('GET', '/shifts/current', { token: cashier });
    check('no drawer open after close', (r.body as CurrentShiftResponse).shift === null);

    // Cash taken after the close belongs to no shift, and cannot move the count.
    r = await pay(invE, 'CASH', 44000);
    check('E paid after close', r.status === 201, r.status);
    const after = (await call('GET', '/reports/daily', { token: owner }))
      .body as DailyReportResponse;
    check('report now shows nothing outstanding', after.payments.outstandingPaisa === 0);
    check(
      'the closed shift still expected 3140.00',
      after.shifts[0]?.expectedCashPaisa === 314000 &&
        after.shifts[0].close?.variancePaisa === -4000,
    );

    r = await call('POST', '/shifts', { token: cashier, body: { openingFloatPaisa: 100000 } });
    check('a new drawer can open after the close', r.status === 201, r.status);
    check(
      'the new shift does not inherit earlier cash',
      shiftOf(r.body).cashSalesPaisa === 0 && shiftOf(r.body).expectedCashPaisa === 100000,
    );
  } finally {
    await stopNayaroServer(handle).catch(() => undefined);
  }

  console.log(`\n${fail === 0 ? `ALL ${String(pass)} CHECKS PASSED` : `${String(fail)} FAILED`}`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error('VERIFICATION ERROR:', error);
  process.exitCode = 1;
});
