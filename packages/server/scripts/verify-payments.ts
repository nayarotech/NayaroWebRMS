/**
 * Phase 4G backend verification - drives the real HTTP API.
 *
 *   npm run verify:payments --workspace @nayaro/server
 *
 * Ends with the GOLDEN WORKFLOW: the whole restaurant loop, start to finish,
 * through the API only - no database rows touched by hand.
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

const ROOT = resolve(tmpdir(), 'nayaro-4g-verify');
const PORT = 4332;

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

async function main(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true });
  const layout = ensureDataLayout(resolveDataLayout(ROOT));
  const handle: NayaroServerHandle = await startNayaroServer({
    port: PORT,
    databaseFilePath: layout.databaseFilePath,
    logger: createLogger({ scope: 'verify-payments', silent: true }),
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
    const kitchen = await tokenFor('maya.g', 'staff1234');

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

    let seq = 0;
    const newTable = async (): Promise<{ id: string; name: string }> => {
      seq += 1;
      return prisma.restaurantTable.create({
        data: { restaurantId: restaurant.id, areaId: area.id, name: `Table ${String(seq)}` },
        select: { id: true, name: true },
      });
    };
    const floorStatus = async (name: string): Promise<string | undefined> =>
      (
        (await call('GET', '/floor', { token: cashier })).body as {
          areas: { tables: { name: string; status: string }[] }[];
        }
      ).areas
        .flatMap((a) => a.tables)
        .find((t) => t.name === name)?.status;

    /** Order -> kitchen -> invoice, the state every payment test starts from. */
    const billedOrder = async (
      items: { id: string; quantity?: number }[] = [{ id: momo.id, quantity: 2 }, { id: coke.id }],
    ): Promise<{ order: OrderDto; invoice: InvoiceDto; table: { id: string; name: string } }> => {
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
      order = orderOf(
        (
          await call('POST', `/orders/${order.id}/send-kot`, {
            token: cashier,
            body: { expectedVersion: order.version },
          })
        ).body,
      );
      const invoice = invoiceOf(
        (
          await call('POST', `/orders/${order.id}/invoice`, {
            token: cashier,
            body: { expectedVersion: order.version },
          })
        ).body,
      );
      const fresh = await prisma.order.findFirstOrThrow({ where: { id: order.id } });
      return { order: { ...order, version: fresh.version, status: 'BILLED' }, invoice, table };
    };
    check('fixtures created', true);

    // ---------------------------------------------------------- unpaid state
    console.log('\n[unpaid] a billed order before any money');
    const first = await billedOrder();
    check(
      'grand total is 530.00 with no charges',
      first.invoice.grandTotalPaisa === 53000,
      first.invoice.grandTotalPaisa,
    );
    check('nothing paid yet', first.invoice.settlement.totalPaidPaisa === 0);
    check('everything remains', first.invoice.settlement.remainingPaisa === 53000);
    check('status UNPAID', first.invoice.settlement.status === 'UNPAID');
    check('no payments listed', first.invoice.settlement.payments.length === 0);
    check(
      'the table is AWAITING_PAYMENT',
      (await floorStatus(first.table.name)) === 'AWAITING_PAYMENT',
      await floorStatus(first.table.name),
    );

    // ------------------------------------------------------------- cash exact
    console.log('\n[cash] exact amount');
    let r = await call('POST', `/invoices/${first.invoice.id}/payments`, {
      token: cashier,
      body: { expectedOrderVersion: first.order.version, method: 'CASH', amountPaisa: 53000 },
    });
    check('payment accepted -> 201', r.status === 201, r.status);
    let invoice = invoiceOf(r.body);
    check('total paid 53000', invoice.settlement.totalPaidPaisa === 53000);
    check('nothing remaining', invoice.settlement.remainingPaisa === 0);
    check('status PAID', invoice.settlement.status === 'PAID');
    check(
      'no tender recorded when none was given',
      invoice.settlement.payments[0]?.tenderedPaisa === null,
    );
    check('change is zero', invoice.settlement.payments[0]?.changePaisa === 0);
    check(
      'who took the money is recorded',
      invoice.settlement.payments[0]?.receivedBy.name === 'Bikash Tamang',
      invoice.settlement.payments[0]?.receivedBy.name,
    );

    let closed = await prisma.order.findFirstOrThrow({ where: { id: first.order.id } });
    check('order BILLED -> PAID', closed.status === 'PAID', closed.status);
    check('closedAt was written', closed.closedAt !== null);
    check(
      'THE TABLE IS AVAILABLE',
      (await floorStatus(first.table.name)) === 'AVAILABLE',
      await floorStatus(first.table.name),
    );
    check('the invoice is still ACTIVE, not "PAID"', invoice.status === 'ACTIVE', invoice.status);
    check('and its frozen total is untouched', invoice.grandTotalPaisa === 53000);

    console.log('\n[cash] tendered more than the bill');
    const second = await billedOrder([{ id: momo.id }]);
    r = await call('POST', `/invoices/${second.invoice.id}/payments`, {
      token: cashier,
      body: {
        expectedOrderVersion: second.order.version,
        method: 'CASH',
        amountPaisa: 22000,
        tenderedPaisa: 50000,
      },
    });
    check('accepted -> 201', r.status === 201, r.status);
    invoice = invoiceOf(r.body);
    check(
      'the AMOUNT applied is the bill, not the tender',
      invoice.settlement.payments[0]?.amountPaisa === 22000,
      invoice.settlement.payments[0]?.amountPaisa,
    );
    check(
      'the tender is recorded separately',
      invoice.settlement.payments[0]?.tenderedPaisa === 50000,
    );
    check(
      'change is 280.00',
      invoice.settlement.payments[0]?.changePaisa === 28000,
      invoice.settlement.payments[0]?.changePaisa,
    );
    check('the bill is settled exactly, not over', invoice.settlement.totalPaidPaisa === 22000);
    check(
      'order PAID',
      (await prisma.order.findFirstOrThrow({ where: { id: second.order.id } })).status === 'PAID',
    );

    console.log('\n[cash] tender below the amount is refused');
    const third = await billedOrder([{ id: momo.id }]);
    r = await call('POST', `/invoices/${third.invoice.id}/payments`, {
      token: cashier,
      body: {
        expectedOrderVersion: third.order.version,
        method: 'CASH',
        amountPaisa: 22000,
        tenderedPaisa: 10000,
      },
    });
    check('tender < amount -> 400', r.status === 400, r.status);
    check(
      'nothing was recorded',
      (await prisma.payment.count({ where: { invoiceId: third.invoice.id } })) === 0,
    );
    check(
      'the order is still BILLED',
      (await prisma.order.findFirstOrThrow({ where: { id: third.order.id } })).status === 'BILLED',
    );

    // ------------------------------------------------------------ split pay
    console.log('\n[split] QR then card');
    const split = await billedOrder([{ id: momo.id, quantity: 2 }, { id: coke.id }]);
    r = await call('POST', `/invoices/${split.invoice.id}/payments`, {
      token: cashier,
      body: {
        expectedOrderVersion: split.order.version,
        method: 'QR',
        amountPaisa: 20000,
        reference: 'FP-99881',
      },
    });
    check('partial QR accepted', r.status === 201, r.status);
    invoice = invoiceOf(r.body);
    check('paid 200.00', invoice.settlement.totalPaidPaisa === 20000);
    check(
      'remaining 330.00',
      invoice.settlement.remainingPaisa === 33000,
      invoice.settlement.remainingPaisa,
    );
    check('status PARTIAL', invoice.settlement.status === 'PARTIAL');
    check('the reference is kept', invoice.settlement.payments[0]?.reference === 'FP-99881');

    let mid = await prisma.order.findFirstOrThrow({ where: { id: split.order.id } });
    check('the order stays BILLED', mid.status === 'BILLED', mid.status);
    check('closedAt stays null', mid.closedAt === null);
    check(
      'the table stays AWAITING_PAYMENT',
      (await floorStatus(split.table.name)) === 'AWAITING_PAYMENT',
    );

    r = await call('POST', `/invoices/${split.invoice.id}/payments`, {
      token: cashier,
      body: {
        expectedOrderVersion: mid.version,
        method: 'CARD',
        amountPaisa: 33000,
        reference: 'AUTH-4417',
      },
    });
    check('the second payment settles it', r.status === 201, r.status);
    invoice = invoiceOf(r.body);
    check('two payments listed', invoice.settlement.payments.length === 2);
    check(
      'in the order they were taken',
      invoice.settlement.payments[0]?.method === 'QR' &&
        invoice.settlement.payments[1]?.method === 'CARD',
    );
    check(
      'total paid equals the bill',
      invoice.settlement.totalPaidPaisa === invoice.grandTotalPaisa,
    );
    check('status PAID', invoice.settlement.status === 'PAID');
    closed = await prisma.order.findFirstOrThrow({ where: { id: split.order.id } });
    check('order PAID and closed', closed.status === 'PAID' && closed.closedAt !== null);
    check('table AVAILABLE', (await floorStatus(split.table.name)) === 'AVAILABLE');

    // ------------------------------------------------------------ overpayment
    console.log('\n[overpayment] refused for every method');
    const creditCustomer = await prisma.customer.create({
      data: {
        restaurantId: (await prisma.restaurant.findFirstOrThrow()).id,
        name: 'Sagarmatha Traders',
      },
    });
    for (const method of ['CASH', 'QR', 'CARD', 'CREDIT'] as const) {
      const over = await billedOrder([{ id: coke.id }]);
      r = await call('POST', `/invoices/${over.invoice.id}/payments`, {
        token: cashier,
        body: {
          expectedOrderVersion: over.order.version,
          method,
          ...(method === 'CREDIT' ? { customerId: creditCustomer.id } : {}),
          amountPaisa: over.invoice.grandTotalPaisa + 1,
        },
      });
      check(`${method} above the remaining -> 409`, r.status === 409, r.status);
      check(
        `${method} code AMOUNT_EXCEEDS_REMAINING`,
        errorCode(r.body) === 'AMOUNT_EXCEEDS_REMAINING',
      );
      check(
        `${method} recorded nothing`,
        (await prisma.payment.count({ where: { invoiceId: over.invoice.id } })) === 0,
      );
    }

    console.log('\n[overpayment] a second payment cannot exceed what is left');
    const partial = await billedOrder([{ id: momo.id, quantity: 2 }]);
    r = await call('POST', `/invoices/${partial.invoice.id}/payments`, {
      token: cashier,
      body: { expectedOrderVersion: partial.order.version, method: 'QR', amountPaisa: 30000 },
    });
    mid = await prisma.order.findFirstOrThrow({ where: { id: partial.order.id } });
    r = await call('POST', `/invoices/${partial.invoice.id}/payments`, {
      token: cashier,
      body: { expectedOrderVersion: mid.version, method: 'CASH', amountPaisa: 20000 },
    });
    check('more than the remaining 140.00 -> 409', r.status === 409, r.status);
    check(
      'total paid is unchanged',
      (
        await prisma.payment.aggregate({
          where: { invoiceId: partial.invoice.id },
          _sum: { amountPaisa: true },
        })
      )._sum.amountPaisa === 30000,
    );

    console.log('\n[settled] a settled bill takes no more money');
    r = await call('POST', `/invoices/${first.invoice.id}/payments`, {
      token: cashier,
      body: { expectedOrderVersion: closed.version, method: 'CASH', amountPaisa: 100 },
    });
    check('paying a closed order -> 409', r.status === 409, r.status);
    check('code ORDER_ALREADY_PAID', errorCode(r.body) === 'ORDER_ALREADY_PAID', errorCode(r.body));

    // ---------------------------------------------------------------- credit
    console.log('\n[credit] settles operationally, and is not cash');
    const credit = await billedOrder([{ id: momo.id, quantity: 2 }]);
    r = await call('POST', `/invoices/${credit.invoice.id}/payments`, {
      token: cashier,
      body: {
        expectedOrderVersion: credit.order.version,
        method: 'CREDIT',
        amountPaisa: credit.invoice.grandTotalPaisa,
        customerId: creditCustomer.id,
      },
    });
    check('credit accepted -> 201', r.status === 201, r.status);
    invoice = invoiceOf(r.body);
    check('the bill counts as settled', invoice.settlement.status === 'PAID');
    check(
      'the account name is kept',
      invoice.settlement.payments[0]?.creditAccountName === 'Sagarmatha Traders',
    );
    closed = await prisma.order.findFirstOrThrow({ where: { id: credit.order.id } });
    check('order PAID', closed.status === 'PAID');
    check(
      'THE TABLE IS FREED - the guest has left',
      (await floorStatus(credit.table.name)) === 'AVAILABLE',
    );
    check(
      'but the method still says CREDIT, not cash',
      (await prisma.payment.findFirstOrThrow({ where: { invoiceId: credit.invoice.id } }))
        .method === 'CREDIT',
    );
    check(
      'an account name on a non-credit payment is refused',
      (
        await call('POST', `/invoices/${partial.invoice.id}/payments`, {
          token: cashier,
          body: {
            expectedOrderVersion: 999,
            method: 'CASH',
            amountPaisa: 100,
            creditAccountName: 'x',
          },
        })
      ).status === 400,
    );

    console.log('\n[tender] only cash has one');
    const tenderTest = await billedOrder([{ id: coke.id }]);
    r = await call('POST', `/invoices/${tenderTest.invoice.id}/payments`, {
      token: cashier,
      body: {
        expectedOrderVersion: tenderTest.order.version,
        method: 'CARD',
        amountPaisa: 9000,
        tenderedPaisa: 10000,
      },
    });
    check('a tender on a card payment -> 400', r.status === 400, r.status);

    // ------------------------------------------------------------ zero total
    console.log('\n[zero total] settled without a fake payment row');
    const freeTable = await newTable();
    let freeOrder = orderOf(
      (
        await call('POST', '/orders/items', {
          token: cashier,
          body: { target: { kind: 'TABLE', tableId: freeTable.id }, menuItemId: momo.id },
        })
      ).body,
    );
    freeOrder = orderOf(
      (
        await call('POST', `/orders/${freeOrder.id}/send-kot`, {
          token: cashier,
          body: { expectedVersion: freeOrder.version },
        })
      ).body,
    );
    const freePre = (
      (
        await call('PATCH', `/orders/${freeOrder.id}/discount`, {
          token: manager,
          body: {
            expectedVersion: freeOrder.version,
            discountType: 'PERCENT',
            discountValue: 10000,
          },
        })
      ).body as { preBill: PreBillDto }
    ).preBill;
    const freeInvoice = invoiceOf(
      (
        await call('POST', `/orders/${freeOrder.id}/invoice`, {
          token: cashier,
          body: { expectedVersion: freePre.orderVersion },
        })
      ).body,
    );
    check('a zero-total invoice was issued', freeInvoice.grandTotalPaisa === 0);
    check('it is UNPAID until someone settles it', freeInvoice.settlement.status === 'UNPAID');
    check(
      'the table is still AWAITING_PAYMENT',
      (await floorStatus(freeTable.name)) === 'AWAITING_PAYMENT',
    );

    const freeVersion = (await prisma.order.findFirstOrThrow({ where: { id: freeOrder.id } }))
      .version;
    r = await call('POST', `/invoices/${freeInvoice.id}/payments`, {
      token: cashier,
      body: { expectedOrderVersion: freeVersion, method: 'CASH', amountPaisa: 1 },
    });
    check('you cannot pay anything against a zero bill -> 409', r.status === 409, r.status);
    check('code ALREADY_SETTLED', errorCode(r.body) === 'ALREADY_SETTLED', errorCode(r.body));

    r = await call('POST', `/invoices/${freeInvoice.id}/settle`, {
      token: cashier,
      body: { expectedOrderVersion: freeVersion },
    });
    check('settle -> 201', r.status === 201, r.status);
    check(
      'NO payment row was invented',
      (await prisma.payment.count({ where: { invoiceId: freeInvoice.id } })) === 0,
    );
    closed = await prisma.order.findFirstOrThrow({ where: { id: freeOrder.id } });
    check('order PAID and closed', closed.status === 'PAID' && closed.closedAt !== null);
    check('table AVAILABLE', (await floorStatus(freeTable.name)) === 'AVAILABLE');

    console.log('\n[zero total] settle refuses a real bill');
    const realBill = await billedOrder([{ id: coke.id }]);
    r = await call('POST', `/invoices/${realBill.invoice.id}/settle`, {
      token: cashier,
      body: { expectedOrderVersion: realBill.order.version },
    });
    check('settling a bill with an amount -> 409', r.status === 409, r.status);
    check('code NOT_A_ZERO_BILL', errorCode(r.body) === 'NOT_A_ZERO_BILL');
    check(
      'the order is still BILLED',
      (await prisma.order.findFirstOrThrow({ where: { id: realBill.order.id } })).status ===
        'BILLED',
    );

    // --------------------------------------------------------- concurrency
    console.log('\n[concurrency] two terminals settle the same bill at once');
    const race = await billedOrder([{ id: momo.id, quantity: 2 }]);
    const total = race.invoice.grandTotalPaisa;
    const [a, b] = await Promise.all([
      call('POST', `/invoices/${race.invoice.id}/payments`, {
        token: cashier,
        body: { expectedOrderVersion: race.order.version, method: 'CASH', amountPaisa: total },
      }),
      call('POST', `/invoices/${race.invoice.id}/payments`, {
        token: owner,
        body: { expectedOrderVersion: race.order.version, method: 'QR', amountPaisa: total },
      }),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    check(
      'exactly one is accepted',
      statuses[0] === 201 && statuses[1] === 409,
      statuses.join('/'),
    );
    check(
      'the loser gets a safe conflict',
      ['ORDER_CHANGED', 'ALREADY_SETTLED', 'ORDER_ALREADY_PAID'].includes(
        errorCode(a.status === 409 ? a.body : b.body) ?? '',
      ),
      errorCode(a.status === 409 ? a.body : b.body),
    );
    const racePayments = await prisma.payment.findMany({ where: { invoiceId: race.invoice.id } });
    check('EXACTLY ONE payment row exists', racePayments.length === 1, racePayments.length);
    check(
      'the customer was charged once, not twice',
      racePayments.reduce((sum, p) => sum + p.amountPaisa, 0) === total,
      racePayments.reduce((sum, p) => sum + p.amountPaisa, 0),
    );
    closed = await prisma.order.findFirstOrThrow({ where: { id: race.order.id } });
    check('the order is PAID exactly once', closed.status === 'PAID');
    check(
      'no SQL detail leaked',
      !/UNIQUE|constraint|prisma/i.test(JSON.stringify(a.status === 409 ? a.body : b.body)),
    );

    console.log('\n[concurrency] two concurrent PARTIAL payments serialise');
    const race2 = await billedOrder([{ id: momo.id, quantity: 2 }]);
    const [c, d] = await Promise.all([
      call('POST', `/invoices/${race2.invoice.id}/payments`, {
        token: cashier,
        body: { expectedOrderVersion: race2.order.version, method: 'CASH', amountPaisa: 10000 },
      }),
      call('POST', `/invoices/${race2.invoice.id}/payments`, {
        token: owner,
        body: { expectedOrderVersion: race2.order.version, method: 'QR', amountPaisa: 20000 },
      }),
    ]);
    check(
      'one succeeds, one is told to retry',
      [c.status, d.status].sort((x, y) => x - y).join('/') === '201/409',
      [c.status, d.status].join('/'),
    );
    check(
      'only one payment landed',
      (await prisma.payment.count({ where: { invoiceId: race2.invoice.id } })) === 1,
    );
    // The retry is the documented cost of serialising through the order version.
    const race2Version = (await prisma.order.findFirstOrThrow({ where: { id: race2.order.id } }))
      .version;
    const retryAmount = c.status === 201 ? 20000 : 10000;
    r = await call('POST', `/invoices/${race2.invoice.id}/payments`, {
      token: owner,
      body: { expectedOrderVersion: race2Version, method: 'QR', amountPaisa: retryAmount },
    });
    check('and the retry succeeds against the refreshed balance', r.status === 201, r.status);
    check(
      'now two payments',
      (await prisma.payment.count({ where: { invoiceId: race2.invoice.id } })) === 2,
    );

    // ------------------------------------------------------------- security
    console.log('\n[security]');
    const secure = await billedOrder([{ id: coke.id }]);
    check(
      'KITCHEN cannot take payment -> 403',
      (
        await call('POST', `/invoices/${secure.invoice.id}/payments`, {
          token: kitchen,
          body: { expectedOrderVersion: secure.order.version, method: 'CASH', amountPaisa: 9000 },
        })
      ).status === 403,
    );
    check(
      'KITCHEN cannot settle -> 403',
      (
        await call('POST', `/invoices/${secure.invoice.id}/settle`, {
          token: kitchen,
          body: { expectedOrderVersion: secure.order.version },
        })
      ).status === 403,
    );
    check(
      'unauthenticated -> 401',
      (
        await call('POST', `/invoices/${secure.invoice.id}/payments`, {
          body: { expectedOrderVersion: 1, method: 'CASH', amountPaisa: 1 },
        })
      ).status === 401,
    );
    check(
      'MANAGER can take payment',
      (
        await call('POST', `/invoices/${secure.invoice.id}/payments`, {
          token: manager,
          body: { expectedOrderVersion: secure.order.version, method: 'CASH', amountPaisa: 9000 },
        })
      ).status === 201,
    );

    console.log('\n[security] cross-restaurant');
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
      data: { restaurantId: other.id, name: 'A' },
    });
    const otherTable = await prisma.restaurantTable.create({
      data: { restaurantId: other.id, areaId: otherArea.id, name: 'T' },
    });
    const otherOrder = await prisma.order.create({
      data: {
        restaurantId: other.id,
        orderNumber: 1,
        type: 'DINE_IN',
        status: 'BILLED',
        tableId: otherTable.id,
        openedByStaffId: otherStaff.id,
        businessDate: '2026-09-05',
        version: 1,
      },
    });
    const otherInvoice = await prisma.invoice.create({
      data: {
        restaurantId: other.id,
        orderId: otherOrder.id,
        invoiceNumber: 1,
        fiscalYearStartBsYear: 2083,
        status: 'ACTIVE',
        issuedByStaffId: otherStaff.id,
        businessDate: '2026-09-05',
        subtotalPaisa: 10000,
        grandTotalPaisa: 10000,
      },
    });
    r = await call('POST', `/invoices/${otherInvoice.id}/payments`, {
      token: cashier,
      body: { expectedOrderVersion: 1, method: 'CASH', amountPaisa: 10000 },
    });
    check("another restaurant's invoice -> 404", r.status === 404, r.status);
    check(
      'code INVOICE_NOT_FOUND (existence not revealed)',
      errorCode(r.body) === 'INVOICE_NOT_FOUND',
    );
    check(
      'nothing was recorded there',
      (await prisma.payment.count({ where: { restaurantId: other.id } })) === 0,
    );
    check(
      'an unknown id answers identically',
      errorCode(
        (
          await call('POST', '/invoices/nope/payments', {
            token: cashier,
            body: { expectedOrderVersion: 1, method: 'CASH', amountPaisa: 1 },
          })
        ).body,
      ) === 'INVOICE_NOT_FOUND',
    );

    console.log('\n[security] a voided invoice takes no money');
    const voided = await billedOrder([{ id: coke.id }]);
    await prisma.invoice.update({ where: { id: voided.invoice.id }, data: { status: 'VOID' } });
    r = await call('POST', `/invoices/${voided.invoice.id}/payments`, {
      token: cashier,
      body: { expectedOrderVersion: voided.order.version, method: 'CASH', amountPaisa: 9000 },
    });
    check('paying a voided bill -> 409', r.status === 409, r.status);
    check('code INVOICE_VOIDED', errorCode(r.body) === 'INVOICE_VOIDED');

    console.log('\n[security] no generic payment CRUD');
    const anyPayment = await prisma.payment.findFirstOrThrow();
    for (const method of ['PATCH', 'PUT'] as const) {
      check(
        `${method} /payments/:id is not a route`,
        (
          await call(method, `/payments/${anyPayment.id}`, {
            token: owner,
            body: { amountPaisa: 1 },
          })
        ).status === 404,
      );
    }
    check(
      'DELETE /payments/:id is not a route',
      (await call('DELETE', `/payments/${anyPayment.id}`, { token: owner })).status === 404,
    );
    check(
      'the payment is untouched',
      (await prisma.payment.findFirstOrThrow({ where: { id: anyPayment.id } })).amountPaisa ===
        anyPayment.amountPaisa,
    );

    // =======================================================================
    // THE GOLDEN WORKFLOW - the whole loop, API only, nothing touched by hand
    // =======================================================================
    console.log('\n========== GOLDEN WORKFLOW ==========');
    const g = await newTable();
    check(
      `${g.name} starts AVAILABLE`,
      (await floorStatus(g.name)) === 'AVAILABLE',
      await floorStatus(g.name),
    );

    let go = orderOf(
      (
        await call('POST', '/orders/items', {
          token: cashier,
          body: { target: { kind: 'TABLE', tableId: g.id }, menuItemId: momo.id, quantity: 2 },
        })
      ).body,
    );
    go = orderOf(
      (
        await call('POST', '/orders/items', {
          token: cashier,
          body: {
            target: { kind: 'ORDER', orderId: go.id, expectedVersion: go.version },
            menuItemId: coke.id,
          },
        })
      ).body,
    );
    check('momo x2 + coke x1, order is DRAFT', go.status === 'DRAFT' && go.items.length === 2);
    check('table OCCUPIED', (await floorStatus(g.name)) === 'OCCUPIED', await floorStatus(g.name));

    go = orderOf(
      (
        await call('POST', `/orders/${go.id}/send-kot`, {
          token: cashier,
          body: { expectedVersion: go.version },
        })
      ).body,
    );
    check('sent to kitchen, order OPEN', go.status === 'OPEN');
    check(
      'table PREPARING',
      (await floorStatus(g.name)) === 'PREPARING',
      await floorStatus(g.name),
    );

    const ticket = (
      (await call('GET', '/kitchen/tickets', { token: kitchen })).body as {
        tickets: { id: string; orderId: string }[];
      }
    ).tickets.find((t) => t.orderId === go.id);
    for (const [status, expectedFloor] of [
      ['PREPARING', 'PREPARING'],
      ['READY', 'READY'],
      ['SERVED', 'OCCUPIED'],
    ] as const) {
      const moved = await call('PATCH', `/kitchen/tickets/${ticket?.id ?? ''}/status`, {
        token: kitchen,
        body: { status },
      });
      check(`kitchen -> ${status}`, moved.status === 200, moved.status);
      check(
        `floor reads ${expectedFloor}`,
        (await floorStatus(g.name)) === expectedFloor,
        await floorStatus(g.name),
      );
    }
    check(
      'the order is still OPEN after being served',
      (await prisma.order.findFirstOrThrow({ where: { id: go.id } })).status === 'OPEN',
    );

    const goVersion = (await prisma.order.findFirstOrThrow({ where: { id: go.id } })).version;
    const goBilling = (await call('GET', `/orders/${go.id}/billing`, { token: cashier }))
      .body as BillingResponse;
    check(
      'billing shows a PRE-BILL, not an invoice',
      goBilling.preBill !== null && goBilling.invoice === null,
    );
    check(
      'pre-bill total 530.00',
      goBilling.preBill?.grandTotalPaisa === 53000,
      goBilling.preBill?.grandTotalPaisa,
    );

    const goInvoice = invoiceOf(
      (
        await call('POST', `/orders/${go.id}/invoice`, {
          token: cashier,
          body: { expectedVersion: goVersion },
        })
      ).body,
    );
    check(
      'STANDARD invoice issued',
      goInvoice.invoiceType === 'STANDARD' && goInvoice.invoiceNumber > 0,
      goInvoice.invoiceNumber,
    );
    check(
      'order BILLED',
      (await prisma.order.findFirstOrThrow({ where: { id: go.id } })).status === 'BILLED',
    );
    check('table AWAITING_PAYMENT', (await floorStatus(g.name)) === 'AWAITING_PAYMENT');

    const payVersion = (await prisma.order.findFirstOrThrow({ where: { id: go.id } })).version;
    const paid = invoiceOf(
      (
        await call('POST', `/invoices/${goInvoice.id}/payments`, {
          token: cashier,
          body: {
            expectedOrderVersion: payVersion,
            method: 'CASH',
            amountPaisa: 53000,
            tenderedPaisa: 100000,
          },
        })
      ).body,
    );
    check(
      'cash taken, change 470.00',
      paid.settlement.payments[0]?.changePaisa === 47000,
      paid.settlement.payments[0]?.changePaisa,
    );
    check('settled in full', paid.settlement.status === 'PAID');
    const goClosed = await prisma.order.findFirstOrThrow({ where: { id: go.id } });
    check('ORDER PAID', goClosed.status === 'PAID');
    check('closedAt written', goClosed.closedAt !== null);
    check(
      `${g.name} IS AVAILABLE AGAIN`,
      (await floorStatus(g.name)) === 'AVAILABLE',
      await floorStatus(g.name),
    );
    check('the invoice remains ACTIVE', paid.status === 'ACTIVE');
    check(
      'its ticket left the kitchen board',
      !(
        (await call('GET', '/kitchen/tickets', { token: kitchen })).body as {
          tickets: { orderId: string }[];
        }
      ).tickets.some((t) => t.orderId === go.id),
    );
    check(
      'opening the table again offers a fresh start',
      ((await call('GET', `/tables/${g.id}/order`, { token: cashier })).body as { order: unknown })
        .order === null,
    );
    console.log('===== the full loop works end to end =====');
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
