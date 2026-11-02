/**
 * Phase 4F backend verification - pure calculation, then the real HTTP API.
 *
 *   npm run verify:billing --workspace @nayaro/server
 *
 * Disposable temp data root, non-default port. Never touches the dev database.
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import type { BillingResponse, InvoiceDto, OrderDto, PreBillDto } from '@nayaro/shared';
import { ensureDataLayout, resolveDataLayout } from '@nayaro/database';
import { createLogger } from '../src/utils/logger';
import { startNayaroServer, stopNayaroServer, type NayaroServerHandle } from '../src/server';
import { hashPassword } from '../src/modules/auth/password';
import { applyRateBp, roundToRupee } from '../src/utils/money';
import { calculateBill, type BillingConfig } from '../src/modules/billing/billing.calc';

const ROOT = resolve(tmpdir(), 'nayaro-4f-verify');
const PORT = 4331;

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
const preBillOf = (body: unknown): PreBillDto => (body as { preBill: PreBillDto }).preBill;
const invoiceOf = (body: unknown): InvoiceDto => (body as { invoice: InvoiceDto }).invoice;

const OFF: BillingConfig = {
  vatEnabled: false,
  vatRateBp: 1300,
  serviceChargeEnabled: false,
  serviceChargeRateBp: 1000,
  serviceChargeAppliesToTakeaway: false,
  roundGrandTotalToRupee: false,
};
const line = (qty: number, price: number, cancelled = 0) => ({
  orderItemId: `i${String(qty)}-${String(price)}`,
  name: 'Chicken Momo',
  nameNp: null,
  quantity: qty,
  cancelledQuantity: cancelled,
  unitPricePaisa: price,
});

async function main(): Promise<void> {
  // =========================================================================
  // Part 1 - the arithmetic, tested directly. No server, no database.
  // =========================================================================
  console.log('[money] round-half-up on a rate');
  check('68000 x 10% = 6800', applyRateBp(68000, 1000) === 6800, applyRateBp(68000, 1000));
  check('74800 x 13% = 9724', applyRateBp(74800, 1300) === 9724, applyRateBp(74800, 1300));
  check('rate 0 gives 0', applyRateBp(99999, 0) === 0);
  check('base 0 gives 0', applyRateBp(0, 1300) === 0);
  check(
    'exact midpoint rounds UP (1 x 50% = 0.5 -> 1)',
    applyRateBp(1, 5000) === 1,
    applyRateBp(1, 5000),
  );
  check(
    'just below midpoint rounds down (3 x 16% = 0.48 -> 0)',
    applyRateBp(3, 1600) === 0,
    applyRateBp(3, 1600),
  );
  check(
    'just above midpoint rounds up (7 x 8% = 0.56 -> 1)',
    applyRateBp(7, 800) === 1,
    applyRateBp(7, 800),
  );
  check('100% is identity', applyRateBp(12345, 10000) === 12345);
  check('a huge but plausible bill still exact', applyRateBp(100_000_000, 1300) === 13_000_000);

  console.log('\n[money] whole-rupee rounding');
  check(
    '84524 -> 84500, adjustment -24',
    roundToRupee(84524).totalPaisa === 84500 && roundToRupee(84524).adjustmentPaisa === -24,
    JSON.stringify(roundToRupee(84524)),
  );
  check(
    '84560 -> 84600, adjustment +40',
    roundToRupee(84560).totalPaisa === 84600 && roundToRupee(84560).adjustmentPaisa === 40,
    JSON.stringify(roundToRupee(84560)),
  );
  check(
    'exact midpoint 84550 -> 84600 (half up)',
    roundToRupee(84550).totalPaisa === 84600 && roundToRupee(84550).adjustmentPaisa === 50,
    JSON.stringify(roundToRupee(84550)),
  );
  check('84549 -> 84500 (just below midpoint)', roundToRupee(84549).totalPaisa === 84500);
  check(
    'already whole leaves adjustment 0',
    roundToRupee(84500).totalPaisa === 84500 && roundToRupee(84500).adjustmentPaisa === 0,
  );
  check(
    'zero stays zero',
    roundToRupee(0).totalPaisa === 0 && roundToRupee(0).adjustmentPaisa === 0,
  );
  check(
    'negative input is refused',
    (() => {
      try {
        roundToRupee(-1);
        return false;
      } catch {
        return true;
      }
    })(),
  );

  console.log('\n[calc] THE PHASE 3 EXAMPLE');
  const phase3 = calculateBill({
    lines: [line(1, 68000)],
    orderType: 'DINE_IN',
    discount: { type: 'NONE', value: 0 },
    config: {
      vatEnabled: true,
      vatRateBp: 1300,
      serviceChargeEnabled: true,
      serviceChargeRateBp: 1000,
      serviceChargeAppliesToTakeaway: false,
      roundGrandTotalToRupee: true,
    },
  });
  check('subtotal 68000', phase3.subtotalPaisa === 68000, phase3.subtotalPaisa);
  check('discount 0', phase3.discountPaisa === 0);
  check('service charge 6800', phase3.serviceChargePaisa === 6800, phase3.serviceChargePaisa);
  check('VAT 9724', phase3.vatPaisa === 9724, phase3.vatPaisa);
  check('rounding -24', phase3.roundingAdjustmentPaisa === -24, phase3.roundingAdjustmentPaisa);
  check('grand total 84500', phase3.grandTotalPaisa === 84500, phase3.grandTotalPaisa);
  check(
    'the database identity holds',
    phase3.subtotalPaisa -
      phase3.discountPaisa +
      phase3.serviceChargePaisa +
      phase3.vatPaisa +
      phase3.roundingAdjustmentPaisa ===
      phase3.grandTotalPaisa,
  );

  console.log('\n[calc] charges on and off');
  const plain = calculateBill({
    lines: [line(2, 22000), line(1, 9000)],
    orderType: 'DINE_IN',
    discount: { type: 'NONE', value: 0 },
    config: OFF,
  });
  check(
    'no charges: grand total = subtotal',
    plain.grandTotalPaisa === 53000,
    plain.grandTotalPaisa,
  );
  check('disabled service charge snapshots rate 0', plain.serviceChargeRateBp === 0);
  check('disabled VAT snapshots rate 0', plain.vatRateBp === 0);

  const vatOnly = calculateBill({
    lines: [line(1, 10000)],
    orderType: 'DINE_IN',
    discount: { type: 'NONE', value: 0 },
    config: { ...OFF, vatEnabled: true },
  });
  check(
    'VAT only: 10000 + 1300 = 11300',
    vatOnly.grandTotalPaisa === 11300,
    vatOnly.grandTotalPaisa,
  );
  check('and no service charge', vatOnly.serviceChargePaisa === 0);

  const scOnly = calculateBill({
    lines: [line(1, 10000)],
    orderType: 'DINE_IN',
    discount: { type: 'NONE', value: 0 },
    config: { ...OFF, serviceChargeEnabled: true },
  });
  check(
    'service charge only: 10000 + 1000 = 11000',
    scOnly.grandTotalPaisa === 11000,
    scOnly.grandTotalPaisa,
  );
  check('and no VAT', scOnly.vatPaisa === 0);

  const both = calculateBill({
    lines: [line(1, 10000)],
    orderType: 'DINE_IN',
    discount: { type: 'NONE', value: 0 },
    config: { ...OFF, vatEnabled: true, serviceChargeEnabled: true },
  });
  check(
    'VAT is charged on top of the service charge (11000 x 13% = 1430)',
    both.vatPaisa === 1430,
    both.vatPaisa,
  );
  check('both: 10000 + 1000 + 1430 = 12430', both.grandTotalPaisa === 12430, both.grandTotalPaisa);

  console.log('\n[calc] takeaway service charge rule');
  const takeawayOff = calculateBill({
    lines: [line(1, 10000)],
    orderType: 'TAKEAWAY',
    discount: { type: 'NONE', value: 0 },
    config: { ...OFF, serviceChargeEnabled: true },
  });
  check('takeaway: charge NOT applied by default', takeawayOff.serviceChargePaisa === 0);
  check('and its snapshot rate is 0', takeawayOff.serviceChargeRateBp === 0);
  const takeawayOn = calculateBill({
    lines: [line(1, 10000)],
    orderType: 'TAKEAWAY',
    discount: { type: 'NONE', value: 0 },
    config: { ...OFF, serviceChargeEnabled: true, serviceChargeAppliesToTakeaway: true },
  });
  check('takeaway: applied when the setting says so', takeawayOn.serviceChargePaisa === 1000);
  const dineIn = calculateBill({
    lines: [line(1, 10000)],
    orderType: 'DINE_IN',
    discount: { type: 'NONE', value: 0 },
    config: { ...OFF, serviceChargeEnabled: true },
  });
  check('dine-in is unaffected by the takeaway setting', dineIn.serviceChargePaisa === 1000);

  console.log('\n[calc] discounts');
  const percent = calculateBill({
    lines: [line(1, 50000)],
    orderType: 'DINE_IN',
    discount: { type: 'PERCENT', value: 1000 },
    config: OFF,
  });
  check('10% of 50000 = 5000', percent.discountPaisa === 5000, percent.discountPaisa);
  check('base becomes 45000', percent.grandTotalPaisa === 45000);
  const fixed = calculateBill({
    lines: [line(1, 50000)],
    orderType: 'DINE_IN',
    discount: { type: 'FIXED', value: 12345 },
    config: OFF,
  });
  check('fixed discount is paisa', fixed.discountPaisa === 12345, fixed.discountPaisa);
  const full = calculateBill({
    lines: [line(1, 50000)],
    orderType: 'DINE_IN',
    discount: { type: 'PERCENT', value: 10000 },
    config: { ...OFF, vatEnabled: true, serviceChargeEnabled: true },
  });
  check('100% discount: total 0', full.grandTotalPaisa === 0, full.grandTotalPaisa);
  check('and no charges on nothing', full.serviceChargePaisa === 0 && full.vatPaisa === 0);
  check('but the lines survive for the document', full.lines.length === 1);
  const over = calculateBill({
    lines: [line(1, 50000)],
    orderType: 'DINE_IN',
    discount: { type: 'FIXED', value: 99999 },
    config: OFF,
  });
  check(
    'a discount larger than the bill is clamped, never negative',
    over.discountPaisa === 50000 && over.grandTotalPaisa === 0,
    over.grandTotalPaisa,
  );
  check(
    'discounts are applied BEFORE the charges',
    calculateBill({
      lines: [line(1, 20000)],
      orderType: 'DINE_IN',
      discount: { type: 'FIXED', value: 10000 },
      config: { ...OFF, serviceChargeEnabled: true },
    }).serviceChargePaisa === 1000,
  );

  console.log('\n[calc] billable quantity');
  const cancelled = calculateBill({
    lines: [line(3, 10000, 1)],
    orderType: 'DINE_IN',
    discount: { type: 'NONE', value: 0 },
    config: OFF,
  });
  check('3 ordered - 1 cancelled bills 2', cancelled.lines[0]?.billableQuantity === 2);
  check('and the money follows', cancelled.subtotalPaisa === 20000, cancelled.subtotalPaisa);
  const allCancelled = calculateBill({
    lines: [line(2, 10000, 2), line(1, 5000)],
    orderType: 'DINE_IN',
    discount: { type: 'NONE', value: 0 },
    config: OFF,
  });
  check(
    'a fully cancelled line is dropped',
    allCancelled.lines.length === 1,
    allCancelled.lines.length,
  );
  check('leaving only what is billable', allCancelled.subtotalPaisa === 5000);
  const nothing = calculateBill({
    lines: [line(1, 10000, 1)],
    orderType: 'DINE_IN',
    discount: { type: 'NONE', value: 0 },
    config: OFF,
  });
  check('everything cancelled gives no lines at all', nothing.lines.length === 0);
  check('and a zero total', nothing.grandTotalPaisa === 0);

  console.log('\n[calc] rounding in all three directions');
  const roundDown = calculateBill({
    lines: [line(1, 10024)],
    orderType: 'DINE_IN',
    discount: { type: 'NONE', value: 0 },
    config: { ...OFF, roundGrandTotalToRupee: true },
  });
  check(
    'down: 10024 -> 10000 (-24)',
    roundDown.grandTotalPaisa === 10000 && roundDown.roundingAdjustmentPaisa === -24,
  );
  const roundUp = calculateBill({
    lines: [line(1, 10060)],
    orderType: 'DINE_IN',
    discount: { type: 'NONE', value: 0 },
    config: { ...OFF, roundGrandTotalToRupee: true },
  });
  check(
    'up: 10060 -> 10100 (+40)',
    roundUp.grandTotalPaisa === 10100 && roundUp.roundingAdjustmentPaisa === 40,
  );
  const exact = calculateBill({
    lines: [line(1, 10000)],
    orderType: 'DINE_IN',
    discount: { type: 'NONE', value: 0 },
    config: { ...OFF, roundGrandTotalToRupee: true },
  });
  check('exact: no adjustment', exact.roundingAdjustmentPaisa === 0);
  const noRounding = calculateBill({
    lines: [line(1, 10024)],
    orderType: 'DINE_IN',
    discount: { type: 'NONE', value: 0 },
    config: { ...OFF, roundGrandTotalToRupee: false },
  });
  check(
    'rounding off: paisa are kept',
    noRounding.grandTotalPaisa === 10024 && noRounding.roundingAdjustmentPaisa === 0,
  );

  // =========================================================================
  // Part 2 - the API
  // =========================================================================
  rmSync(ROOT, { recursive: true, force: true });
  const layout = ensureDataLayout(resolveDataLayout(ROOT));
  const handle: NayaroServerHandle = await startNayaroServer({
    port: PORT,
    databaseFilePath: layout.databaseFilePath,
    logger: createLogger({ scope: 'verify-billing', silent: true }),
  });
  const { prisma } = handle;

  try {
    console.log('\n[setup]');
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
      ['Sunita Rai', 'sunita.r', 'WAITER'],
      ['Maya Gurung', 'maya.g', 'KITCHEN'],
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
    const waiterToken = await tokenFor('sunita.r', 'staff1234');
    const kitchen = await tokenFor('maya.g', 'staff1234');

    // Charges ON for this restaurant, so the pipeline is exercised end to end.
    await prisma.restaurantSettings.update({
      where: { restaurantId: restaurant.id },
      data: { vatEnabled: true, serviceChargeEnabled: true, roundGrandTotalToRupee: true },
    });

    const area = await prisma.restaurantArea.create({
      data: { restaurantId: restaurant.id, name: 'Ground Floor' },
    });
    const category = await prisma.menuCategory.create({
      data: { restaurantId: restaurant.id, name: 'Momo' },
    });
    const momo = await prisma.menuItem.create({
      data: {
        restaurantId: restaurant.id,
        categoryId: category.id,
        name: 'Chicken Momo',
        nameNp: 'चिकन मम',
        pricePaisa: 22000,
      },
    });
    const coke = await prisma.menuItem.create({
      data: {
        restaurantId: restaurant.id,
        categoryId: category.id,
        name: 'Coke',
        pricePaisa: 9000,
        sortOrder: 1,
      },
    });

    let tableSeq = 0;
    const newTable = async (): Promise<{ id: string; name: string }> => {
      tableSeq += 1;
      return prisma.restaurantTable.create({
        data: { restaurantId: restaurant.id, areaId: area.id, name: `Table ${String(tableSeq)}` },
        select: { id: true, name: true },
      });
    };

    /** An OPEN order (one KOT sent), ready to bill. */
    const openOrder = async (
      items: { id: string; quantity?: number }[] = [{ id: momo.id, quantity: 2 }, { id: coke.id }],
    ): Promise<OrderDto> => {
      const table = await newTable();
      let order = orderOf(
        (
          await call('POST', '/orders/items', {
            token: cashier,
            body: {
              target: { kind: 'TABLE', tableId: table.id },
              menuItemId: items[0]!.id,
              quantity: items[0]!.quantity ?? 1,
            },
          })
        ).body,
      );
      for (const item of items.slice(1)) {
        order = orderOf(
          (
            await call('POST', '/orders/items', {
              token: cashier,
              body: {
                target: { kind: 'ORDER', orderId: order.id, expectedVersion: order.version },
                menuItemId: item.id,
                quantity: item.quantity ?? 1,
              },
            })
          ).body,
        );
      }
      const sent = await call('POST', `/orders/${order.id}/send-kot`, {
        token: cashier,
        body: { expectedVersion: order.version },
      });
      return orderOf(sent.body);
    };
    check('fixtures created', true);

    console.log('\n[pre-bill] reading one writes nothing');
    const order = await openOrder();
    const invoicesBefore = await prisma.invoice.count();
    let r = await call('GET', `/orders/${order.id}/billing`, { token: cashier });
    check('GET billing -> 200', r.status === 200, r.status);
    let billing = r.body as BillingResponse;
    check('a pre-bill came back', billing.preBill !== null);
    check('and no invoice', billing.invoice === null);
    check('NO Invoice row was created', (await prisma.invoice.count()) === invoicesBefore);
    check(
      'reading it again still creates nothing',
      (await (async () => {
        await call('GET', `/orders/${order.id}/billing`, { token: cashier });
        return prisma.invoice.count();
      })()) === invoicesBefore,
    );

    let pre = billing.preBill as PreBillDto;
    check('the pre-bill has no invoice number', !('invoiceNumber' in pre));
    check('two lines', pre.lines.length === 2, pre.lines.length);
    check('subtotal 2x220 + 90 = 530.00', pre.subtotalPaisa === 53000, pre.subtotalPaisa);
    check(
      'service charge 10% = 5300',
      pre.serviceCharge.amountPaisa === 5300,
      pre.serviceCharge.amountPaisa,
    );
    check('VAT 13% of 58300 = 7579', pre.vat.amountPaisa === 7579, pre.vat.amountPaisa);
    // 53000 + 5300 + 7579 = 65879, snapped up to the rupee.
    check(
      'grand total rounds 65879 -> 65900 (+21)',
      pre.grandTotalPaisa === 65900 && pre.roundingAdjustmentPaisa === 21,
      `${String(pre.grandTotalPaisa)} adj ${String(pre.roundingAdjustmentPaisa)}`,
    );
    check(
      'billable equals ordered when nothing is cancelled',
      pre.lines.every((l) => l.billableQuantity === l.quantity && l.cancelledQuantity === 0),
    );
    check('it carries the order version for the next request', pre.orderVersion === order.version);
    check(
      'a kitchen warning is present but advisory',
      pre.kitchenWarning !== null && /still open/.test(pre.kitchenWarning),
      pre.kitchenWarning,
    );

    console.log('\n[discount] manager only');
    r = await call('PATCH', `/orders/${order.id}/discount`, {
      token: cashier,
      body: { expectedVersion: pre.orderVersion, discountType: 'PERCENT', discountValue: 1000 },
    });
    check('CASHIER cannot apply a discount -> 403', r.status === 403, r.status);
    check(
      'and nothing changed',
      (await prisma.order.findFirstOrThrow({ where: { id: order.id } })).discountType === 'NONE',
    );
    r = await call('PATCH', `/orders/${order.id}/discount`, {
      token: kitchen,
      body: { expectedVersion: pre.orderVersion, discountType: 'PERCENT', discountValue: 1000 },
    });
    check('KITCHEN cannot either -> 403', r.status === 403, r.status);

    r = await call('PATCH', `/orders/${order.id}/discount`, {
      token: manager,
      body: { expectedVersion: pre.orderVersion, discountType: 'PERCENT', discountValue: 1000 },
    });
    check('MANAGER can -> 200', r.status === 200, r.status);
    pre = preBillOf(r.body);
    check('10% off 53000 = 5300', pre.discount.amountPaisa === 5300, pre.discount.amountPaisa);
    // base 47700, service charge 4770, VAT 13% of 52470 = 6821 -> 59291 -> 59300.
    check('the total dropped', pre.grandTotalPaisa === 59300, pre.grandTotalPaisa);
    check('the version advanced', pre.orderVersion === order.version + 1, pre.orderVersion);
    check(
      'who approved it was recorded',
      (await prisma.order.findFirstOrThrow({ where: { id: order.id } }))
        .discountApprovedByStaffId !== null,
    );

    r = await call('PATCH', `/orders/${order.id}/discount`, {
      token: manager,
      body: { expectedVersion: pre.orderVersion, discountType: 'PERCENT', discountValue: 12000 },
    });
    check('over 100% is refused -> 400', r.status === 400, r.status);
    r = await call('PATCH', `/orders/${order.id}/discount`, {
      token: manager,
      body: { expectedVersion: pre.orderVersion, discountType: 'FIXED', discountValue: -1 },
    });
    check('a negative discount is refused -> 400', r.status === 400, r.status);
    r = await call('PATCH', `/orders/${order.id}/discount`, {
      token: manager,
      body: { expectedVersion: pre.orderVersion - 1, discountType: 'NONE' },
    });
    check(
      'a stale version -> 409 ORDER_CHANGED',
      r.status === 409 && errorCode(r.body) === 'ORDER_CHANGED',
      errorCode(r.body),
    );

    r = await call('PATCH', `/orders/${order.id}/discount`, {
      token: manager,
      body: { expectedVersion: pre.orderVersion, discountType: 'NONE' },
    });
    pre = preBillOf(r.body);
    check(
      'clearing the discount restores the total',
      pre.discount.amountPaisa === 0 && pre.grandTotalPaisa === 65900,
      pre.grandTotalPaisa,
    );
    check(
      'and clears who approved it',
      (await prisma.order.findFirstOrThrow({ where: { id: order.id } }))
        .discountApprovedByStaffId === null,
    );

    console.log('\n[issue] the invoice');
    r = await call('POST', `/orders/${order.id}/invoice`, {
      token: cashier,
      body: { expectedVersion: pre.orderVersion, buyerName: 'Ram Bahadur', buyerPan: '601234567' },
    });
    check('issue -> 201', r.status === 201, r.status);
    const invoice = invoiceOf(r.body);
    check('it has a number, starting at 1', invoice.invoiceNumber === 1, invoice.invoiceNumber);
    check('type STANDARD by default', invoice.invoiceType === 'STANDARD');
    check('status ACTIVE', invoice.status === 'ACTIVE');
    check(
      'fiscal year resolved',
      invoice.fiscalYearStartBsYear > 2080,
      invoice.fiscalYearStartBsYear,
    );
    check(
      'with a display label',
      /^\d{4}\/\d{2}$/.test(invoice.fiscalYearLabel),
      invoice.fiscalYearLabel,
    );
    check(
      'buyer frozen',
      invoice.buyer.name === 'Ram Bahadur' && invoice.buyer.pan === '601234567',
    );
    check('two lines snapshotted', invoice.lines.length === 2);
    check(
      'line numbers from 1',
      invoice.lines[0]?.lineNumber === 1 && invoice.lines[1]?.lineNumber === 2,
    );

    check(
      'totals match the pre-bill exactly',
      invoice.subtotalPaisa === pre.subtotalPaisa &&
        invoice.serviceCharge.amountPaisa === pre.serviceCharge.amountPaisa &&
        invoice.vat.amountPaisa === pre.vat.amountPaisa &&
        invoice.roundingAdjustmentPaisa === pre.roundingAdjustmentPaisa &&
        invoice.grandTotalPaisa === pre.grandTotalPaisa,
      `${String(invoice.grandTotalPaisa)} vs ${String(pre.grandTotalPaisa)}`,
    );
    check(
      'the stored row satisfies the totals CHECK',
      (await prisma.invoice.findFirstOrThrow({ where: { id: invoice.id } })).grandTotalPaisa ===
        65900,
    );

    const billedOrder = await prisma.order.findFirstOrThrow({ where: { id: order.id } });
    check('order OPEN -> BILLED', billedOrder.status === 'BILLED', billedOrder.status);
    check('but NOT closed - payment has not happened', billedOrder.closedAt === null);
    check('and the version advanced', billedOrder.version === pre.orderVersion + 1);

    r = await call('GET', '/floor', { token: cashier });
    const tableName = pre.tableName ?? '';
    const floorStatus = (body: unknown, name: string): string | undefined =>
      (body as { areas: { tables: { name: string; status: string }[] }[] }).areas
        .flatMap((a) => a.tables)
        .find((t) => t.name === name)?.status;
    check(
      'the table turned AWAITING_PAYMENT',
      floorStatus(r.body, tableName) === 'AWAITING_PAYMENT',
      floorStatus(r.body, tableName),
    );

    console.log('\n[issued] the billing screen now shows the document');
    billing = (await call('GET', `/orders/${order.id}/billing`, { token: cashier }))
      .body as BillingResponse;
    check('an invoice comes back', billing.invoice !== null);
    check('and NO pre-bill', billing.preBill === null);
    check('same invoice number', billing.invoice?.invoiceNumber === 1);

    console.log('\n[immutability] the document does not follow the world');
    await prisma.menuItem.update({
      where: { id: momo.id },
      data: { name: 'Chicken Momo (Half)', pricePaisa: 99000 },
    });
    await prisma.restaurantSettings.update({
      where: { restaurantId: restaurant.id },
      data: { vatRateBp: 2000, serviceChargeRateBp: 2500 },
    });
    const reread = (
      (await call('GET', `/orders/${order.id}/billing`, { token: cashier })).body as BillingResponse
    ).invoice as InvoiceDto;
    check(
      'a renamed dish does not rewrite the line',
      reread.lines.some((l) => l.description === 'Chicken Momo'),
      reread.lines.map((l) => l.description).join(','),
    );
    check(
      'a repriced dish does not rewrite the line',
      reread.lines.find((l) => l.description === 'Chicken Momo')?.unitPricePaisa === 22000,
    );
    check(
      'a changed VAT rate does not rewrite the invoice',
      reread.vat.rateBp === 1300 && reread.vat.amountPaisa === 7579,
      `${String(reread.vat.rateBp)} / ${String(reread.vat.amountPaisa)}`,
    );
    check(
      'a changed service charge rate does not either',
      reread.serviceCharge.rateBp === 1000 && reread.serviceCharge.amountPaisa === 5300,
    );
    check('the grand total is unchanged', reread.grandTotalPaisa === 65900);
    // Put the settings back for the remaining tests.
    await prisma.restaurantSettings.update({
      where: { restaurantId: restaurant.id },
      data: { vatRateBp: 1300, serviceChargeRateBp: 1000 },
    });

    console.log('\n[billed] the order is closed to editing');
    r = await call('POST', '/orders/items', {
      token: cashier,
      body: {
        target: { kind: 'ORDER', orderId: order.id, expectedVersion: billedOrder.version },
        menuItemId: coke.id,
      },
    });
    check('no more items -> 409', r.status === 409, r.status);
    check('code ORDER_NOT_EDITABLE', errorCode(r.body) === 'ORDER_NOT_EDITABLE');
    r = await call('PATCH', `/orders/${order.id}/discount`, {
      token: manager,
      body: { expectedVersion: billedOrder.version, discountType: 'PERCENT', discountValue: 500 },
    });
    check('no more discount -> 409', r.status === 409, r.status);
    check('code ORDER_ALREADY_BILLED', errorCode(r.body) === 'ORDER_ALREADY_BILLED');
    r = await call('POST', `/orders/${order.id}/send-kot`, {
      token: cashier,
      body: { expectedVersion: billedOrder.version },
    });
    check('nothing more to the kitchen -> 409', r.status === 409, r.status);
    r = await call('POST', `/orders/${order.id}/invoice`, {
      token: cashier,
      body: { expectedVersion: billedOrder.version },
    });
    check('and it cannot be billed twice -> 409', r.status === 409, r.status);
    check('code ORDER_ALREADY_BILLED', errorCode(r.body) === 'ORDER_ALREADY_BILLED');
    check(
      'still exactly one invoice',
      (await prisma.invoice.count({ where: { orderId: order.id } })) === 1,
    );

    console.log('\n[numbering]');
    const second = await openOrder([{ id: coke.id }]);
    const secondInvoice = invoiceOf(
      (
        await call('POST', `/orders/${second.id}/invoice`, {
          token: cashier,
          body: { expectedVersion: second.version },
        })
      ).body,
    );
    check(
      'the next invoice takes number 2',
      secondInvoice.invoiceNumber === 2,
      secondInvoice.invoiceNumber,
    );
    check(
      'same fiscal year series',
      secondInvoice.fiscalYearStartBsYear === invoice.fiscalYearStartBsYear,
    );
    const counterName = `INVOICE:STANDARD:${String(invoice.fiscalYearStartBsYear)}`;
    check(
      'and the counter is keyed per type and year',
      (await prisma.restaurantCounter.findFirst({
        where: { restaurantId: restaurant.id, name: counterName },
      })) !== null,
      counterName,
    );

    console.log('\n[numbering] a failed issue consumes no number');
    const doomed = await openOrder([{ id: coke.id }]);
    const counterBefore = await prisma.restaurantCounter.findFirstOrThrow({
      where: { restaurantId: restaurant.id, name: counterName },
    });
    r = await call('POST', `/orders/${doomed.id}/invoice`, {
      token: cashier,
      body: { expectedVersion: doomed.version, invoiceType: 'ABBREVIATED' },
    });
    check('unauthorized ABBREVIATED -> 409', r.status === 409, r.status);
    check('code ABBREVIATED_NOT_AUTHORIZED', errorCode(r.body) === 'ABBREVIATED_NOT_AUTHORIZED');
    const counterAfter = await prisma.restaurantCounter.findFirstOrThrow({
      where: { restaurantId: restaurant.id, name: counterName },
    });
    check(
      'the invoice number was NOT consumed',
      counterAfter.nextValue === counterBefore.nextValue,
      `${String(counterBefore.nextValue)} -> ${String(counterAfter.nextValue)}`,
    );
    check(
      'and no invoice row was written',
      (await prisma.invoice.count({ where: { orderId: doomed.id } })) === 0,
    );
    check(
      'the order is still OPEN',
      (await prisma.order.findFirstOrThrow({ where: { id: doomed.id } })).status === 'OPEN',
    );

    console.log('\n[abbreviated] both conditions must hold');
    await prisma.restaurantSettings.update({
      where: { restaurantId: restaurant.id },
      data: { abbreviatedInvoiceAuthorized: true, abbreviatedInvoiceCeilingPaisa: 50000 },
    });
    const bigOrder = await openOrder([{ id: momo.id, quantity: 3 }]);
    r = await call('POST', `/orders/${bigOrder.id}/invoice`, {
      token: cashier,
      body: { expectedVersion: bigOrder.version, invoiceType: 'ABBREVIATED' },
    });
    check('above the ceiling -> 409', r.status === 409, r.status);
    check('code ABBREVIATED_ABOVE_CEILING', errorCode(r.body) === 'ABBREVIATED_ABOVE_CEILING');
    check(
      'STANDARD still works for the same order',
      (
        await call('POST', `/orders/${bigOrder.id}/invoice`, {
          token: cashier,
          body: { expectedVersion: bigOrder.version, invoiceType: 'STANDARD' },
        })
      ).status === 201,
    );

    const smallOrder = await openOrder([{ id: coke.id }]);
    const abbreviated = invoiceOf(
      (
        await call('POST', `/orders/${smallOrder.id}/invoice`, {
          token: cashier,
          body: { expectedVersion: smallOrder.version, invoiceType: 'ABBREVIATED' },
        })
      ).body,
    );
    check('within the ceiling and authorized -> issued', abbreviated.invoiceType === 'ABBREVIATED');
    check(
      'ABBREVIATED has its OWN number series starting at 1',
      abbreviated.invoiceNumber === 1,
      abbreviated.invoiceNumber,
    );
    check(
      'the amount never selects the type on its own',
      invoice.invoiceType === 'STANDARD' && invoice.grandTotalPaisa < 1000000,
    );
    await prisma.restaurantSettings.update({
      where: { restaurantId: restaurant.id },
      data: { abbreviatedInvoiceAuthorized: false, abbreviatedInvoiceCeilingPaisa: 1000000 },
    });

    console.log('\n[concurrency] two terminals press Issue together');
    const raceOrder = await openOrder([{ id: momo.id }]);
    const [a, b] = await Promise.all([
      call('POST', `/orders/${raceOrder.id}/invoice`, {
        token: cashier,
        body: { expectedVersion: raceOrder.version },
      }),
      call('POST', `/orders/${raceOrder.id}/invoice`, {
        token: owner,
        body: { expectedVersion: raceOrder.version },
      }),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    check('exactly one wins', statuses[0] === 201 && statuses[1] === 409, statuses.join('/'));
    check(
      'the loser gets a safe domain conflict',
      ['ORDER_CHANGED', 'ORDER_ALREADY_BILLED'].includes(
        errorCode(a.status === 409 ? a.body : b.body) ?? '',
      ),
      errorCode(a.status === 409 ? a.body : b.body),
    );
    check(
      'exactly ONE invoice exists for that order',
      (await prisma.invoice.count({ where: { orderId: raceOrder.id } })) === 1,
    );
    check(
      'no SQL detail leaked',
      !/UNIQUE|constraint|prisma/i.test(JSON.stringify(a.status === 409 ? a.body : b.body)),
    );

    const allNumbers = await prisma.invoice.findMany({
      where: { restaurantId: restaurant.id, invoiceType: 'STANDARD' },
      select: { invoiceNumber: true },
    });
    const numbers = allNumbers.map((x) => x.invoiceNumber).sort((x, y) => x - y);
    check(
      'standard invoice numbers are unique',
      new Set(numbers).size === numbers.length,
      numbers.join(','),
    );
    check(
      'and have no gaps',
      numbers.every((n, i) => n === i + 1),
      numbers.join(','),
    );

    console.log('\n[edge cases]');
    const draftTable = await newTable();
    const draft = orderOf(
      (
        await call('POST', '/orders/items', {
          token: cashier,
          body: { target: { kind: 'TABLE', tableId: draftTable.id }, menuItemId: coke.id },
        })
      ).body,
    );
    r = await call('POST', `/orders/${draft.id}/invoice`, {
      token: cashier,
      body: { expectedVersion: draft.version },
    });
    check('a DRAFT order cannot be billed -> 409', r.status === 409, r.status);
    check('code ORDER_NOT_OPEN', errorCode(r.body) === 'ORDER_NOT_OPEN');
    check(
      'with advice to send it first',
      /send this order to the kitchen/i.test(JSON.stringify(r.body)),
    );

    console.log('\n[edge] a 100% discount still produces a real document');
    const freeOrder = await openOrder([{ id: coke.id }]);
    const freePre = preBillOf(
      (
        await call('PATCH', `/orders/${freeOrder.id}/discount`, {
          token: manager,
          body: {
            expectedVersion: freeOrder.version,
            discountType: 'PERCENT',
            discountValue: 10000,
          },
        })
      ).body,
    );
    check('the total is zero', freePre.grandTotalPaisa === 0, freePre.grandTotalPaisa);
    const freeInvoice = invoiceOf(
      (
        await call('POST', `/orders/${freeOrder.id}/invoice`, {
          token: cashier,
          body: { expectedVersion: freePre.orderVersion },
        })
      ).body,
    );
    check(
      'a zero-total invoice with real lines is allowed',
      freeInvoice.grandTotalPaisa === 0 && freeInvoice.lines.length === 1,
    );
    check(
      'and the discount is frozen on it',
      freeInvoice.discount.type === 'PERCENT' && freeInvoice.discount.value === 10000,
    );

    console.log('\n[edge] nothing to bill');
    const emptyTable = await newTable();
    const emptyOrder = await prisma.order.create({
      data: {
        restaurantId: restaurant.id,
        orderNumber: 9000,
        type: 'DINE_IN',
        status: 'OPEN',
        tableId: emptyTable.id,
        openedByStaffId: (await prisma.staff.findFirstOrThrow({ where: { username: 'bikash.t' } }))
          .id,
        businessDate: '2026-09-05',
        version: 1,
      },
    });
    r = await call('POST', `/orders/${emptyOrder.id}/invoice`, {
      token: cashier,
      body: { expectedVersion: 1 },
    });
    check('an order with no lines cannot be invoiced -> 409', r.status === 409, r.status);
    check('code NOTHING_TO_BILL', errorCode(r.body) === 'NOTHING_TO_BILL');
    check(
      'and no invoice was created',
      (await prisma.invoice.count({ where: { orderId: emptyOrder.id } })) === 0,
    );

    console.log('\n[edge] malformed buyer input');
    const buyerOrder = await openOrder([{ id: coke.id }]);
    r = await call('POST', `/orders/${buyerOrder.id}/invoice`, {
      token: cashier,
      body: { expectedVersion: buyerOrder.version, buyerPan: 'not-a-pan' },
    });
    check('a malformed PAN -> 400', r.status === 400, r.status);
    check(
      'and nothing was issued',
      (await prisma.invoice.count({ where: { orderId: buyerOrder.id } })) === 0,
    );
    r = await call('POST', `/orders/${buyerOrder.id}/invoice`, {
      token: cashier,
      body: { expectedVersion: buyerOrder.version, buyerName: 'x'.repeat(500) },
    });
    check('an absurd buyer name -> 400', r.status === 400, r.status);
    check(
      'an omitted buyer is fine',
      (
        await call('POST', `/orders/${buyerOrder.id}/invoice`, {
          token: cashier,
          body: { expectedVersion: buyerOrder.version },
        })
      ).status === 201,
    );

    console.log('\n[isolation + authorization]');
    const other = await prisma.restaurant.create({
      data: { name: 'Other Restaurant', address: '', phone: '', panNumber: '' },
    });
    const otherStaff = await prisma.staff.create({
      data: {
        restaurantId: other.id,
        name: 'Other Owner',
        username: 'other.o',
        passwordHash: await hashPassword('staff1234'),
        role: 'OWNER',
      },
    });
    const otherArea = await prisma.restaurantArea.create({
      data: { restaurantId: other.id, name: 'Other Area' },
    });
    const otherTable = await prisma.restaurantTable.create({
      data: { restaurantId: other.id, areaId: otherArea.id, name: 'Other Table' },
    });
    const otherOrder = await prisma.order.create({
      data: {
        restaurantId: other.id,
        orderNumber: 1,
        type: 'DINE_IN',
        status: 'OPEN',
        tableId: otherTable.id,
        openedByStaffId: otherStaff.id,
        businessDate: '2026-09-05',
        version: 1,
      },
    });
    check(
      "another restaurant's billing -> 404",
      (await call('GET', `/orders/${otherOrder.id}/billing`, { token: cashier })).status === 404,
    );
    r = await call('POST', `/orders/${otherOrder.id}/invoice`, {
      token: cashier,
      body: { expectedVersion: 1 },
    });
    check("cannot invoice another restaurant's order -> 404", r.status === 404, r.status);
    check(
      'and nothing was written there',
      (await prisma.invoice.count({ where: { restaurantId: other.id } })) === 0,
    );

    const lastOrder = await openOrder([{ id: coke.id }]);
    check(
      'KITCHEN cannot read a bill -> 403',
      (await call('GET', `/orders/${lastOrder.id}/billing`, { token: kitchen })).status === 403,
    );
    check(
      'KITCHEN cannot issue -> 403',
      (
        await call('POST', `/orders/${lastOrder.id}/invoice`, {
          token: kitchen,
          body: { expectedVersion: lastOrder.version },
        })
      ).status === 403,
    );
    check(
      'CASHIER can issue - billing customers is the job',
      (
        await call('POST', `/orders/${lastOrder.id}/invoice`, {
          token: cashier,
          body: { expectedVersion: lastOrder.version },
        })
      ).status === 201,
    );
    check(
      'unauthenticated -> 401',
      (await call('GET', `/orders/${order.id}/billing`)).status === 401,
    );

    console.log('\n[no generic invoice mutation exists]');
    for (const method of ['PATCH', 'PUT'] as const) {
      const res = await call(method, `/invoices/${invoice.id}`, {
        token: owner,
        body: { grandTotalPaisa: 1 },
      });
      check(`${method} /invoices/:id is not a route`, res.status === 404, res.status);
    }
    // DELETE is probed without a body: this server answers 400 to a bodied
    // GET or DELETE before routing happens, which would mask the 404 that
    // actually proves no such route exists.
    check(
      'DELETE /invoices/:id is not a route',
      (await call('DELETE', `/invoices/${invoice.id}`, { token: owner })).status === 404,
    );
    check(
      'nor is DELETE /invoices',
      (await call('DELETE', '/invoices', { token: owner })).status === 404,
    );
    check(
      'the invoice is untouched',
      (await prisma.invoice.findFirstOrThrow({ where: { id: invoice.id } })).grandTotalPaisa ===
        65900,
    );

    /*
     * ------------------------------------------------------------- printing
     *
     * The InvoicePrint table shipped with the Phase 3 schema and had no code
     * behind it until now, which meant the schema described a control the
     * software did not apply. These checks are what make it real: the first
     * print is the document, every later one is a numbered copy, and a
     * withdrawn bill cannot be put on paper at all.
     */
    console.log('\n[print] the bill goes on paper');

    const printOf = (body: unknown): { copySequence: number; isReprint: boolean } =>
      (body as { print: { copySequence: number; isReprint: boolean } }).print;

    check(
      'a fresh invoice reports it has never been printed',
      invoice.printCount === 0,
      invoice.printCount,
    );

    r = await call('POST', `/invoices/${invoice.id}/prints`, { token: cashier });
    check('first print -> 201', r.status === 201, r.status);
    check('it is copy 1', printOf(r.body).copySequence === 1, printOf(r.body).copySequence);
    check('and is not marked a reprint', !printOf(r.body).isReprint);

    r = await call('POST', `/invoices/${invoice.id}/prints`, { token: cashier });
    check('printing again -> 201', r.status === 201, r.status);
    check('it is copy 2', printOf(r.body).copySequence === 2, printOf(r.body).copySequence);
    check('and IS marked a reprint, so the paper can say so', printOf(r.body).isReprint);

    r = await call('GET', `/orders/${invoice.orderId}/billing`, { token: cashier });
    check(
      'the invoice now reports both prints',
      (r.body as { invoice: InvoiceDto }).invoice.printCount === 2,
      (r.body as { invoice: InvoiceDto }).invoice.printCount,
    );

    check(
      'a waiter cannot print a bill',
      (await call('POST', `/invoices/${invoice.id}/prints`, { token: waiterToken })).status === 403,
    );
    check(
      'printing an invoice that does not exist -> 404',
      (await call('POST', '/invoices/does-not-exist/prints', { token: cashier })).status === 404,
    );

    /*
     * A withdrawn bill stays readable forever and printable never: a piece of
     * paper that looks like a valid invoice for an undone sale outlives every
     * explanation attached to it.
     */
    // A throwaway order of its own, so voiding its bill disturbs nothing above.
    const doomedCreate = await call('POST', '/orders/items', {
      token: cashier,
      body: { target: { kind: 'TAKEAWAY' }, menuItemId: momo.id, quantity: 1 },
    });
    check(
      'a throwaway order for the void case was created',
      doomedCreate.status === 201,
      JSON.stringify(doomedCreate.body).slice(0, 160),
    );
    const doomedDraft = orderOf(doomedCreate.body);
    // A bill can only be issued against an OPEN order, so the food has to go
    // to the kitchen first - the same path a real takeaway takes.
    const doomedOrder = orderOf(
      (
        await call('POST', `/orders/${doomedDraft.id}/send-kot`, {
          token: cashier,
          body: { expectedVersion: doomedDraft.version },
        })
      ).body,
    );
    const issued = await call('POST', `/orders/${doomedOrder.id}/invoice`, {
      token: cashier,
      body: { expectedVersion: doomedOrder.version },
    });
    check(
      'and billed, so there is something to withdraw',
      issued.status === 201,
      JSON.stringify(issued.body).slice(0, 120),
    );
    const withdrawnBill = invoiceOf(issued.body);
    await call('POST', `/invoices/${withdrawnBill.id}/void`, {
      token: owner,
      body: { reason: 'verifying that a withdrawn bill cannot be printed' },
    });
    r = await call('POST', `/invoices/${withdrawnBill.id}/prints`, { token: cashier });
    check('a voided bill cannot be printed -> 409', r.status === 409, r.status);
    check('with a code that says why', errorCode(r.body) === 'INVOICE_VOID', errorCode(r.body));
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
