/**
 * Phase 4I backend verification - drives the real HTTP API.
 *
 *   npm run verify:corrections --workspace @nayaro/server
 *
 * Four corrections, one file: KOT void, dispatched-item cancellation, unpaid
 * invoice void and reissue, and payment reversal before the sale closes. Ends
 * with the four golden scenarios end to end.
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import type { BillingResponse, InvoiceDto, OrderDto } from '@nayaro/shared';
import { assertDatabaseIntegrity, ensureDataLayout, resolveDataLayout } from '@nayaro/database';
import { createLogger } from '../src/utils/logger';
import { startNayaroServer, stopNayaroServer, type NayaroServerHandle } from '../src/server';
import { hashPassword } from '../src/modules/auth/password';

const ROOT = resolve(tmpdir(), 'nayaro-4i-verify');
const PORT = 4333;

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
const errorMessage = (body: unknown): string =>
  (body as { error?: { message?: string } } | null)?.error?.message ?? '';
const orderOf = (body: unknown): OrderDto => (body as { order: OrderDto }).order;
const invoiceOf = (body: unknown): InvoiceDto => (body as { invoice: InvoiceDto }).invoice;
const itemNamed = (order: OrderDto, name: string): OrderDto['items'][number] =>
  order.items.find((item) => item.name === name)!;

/** Every message a correction can produce must be readable by a cashier. */
function assertNoLeak(label: string, body: unknown): void {
  const message = errorMessage(body).toLowerCase();
  const leaked = ['prisma', 'sqlite', 'constraint', 'p20', 'unique', 'foreign key'].filter((word) =>
    message.includes(word),
  );
  check(`${label} leaks no database detail`, leaked.length === 0, leaked.join(','));
}

async function main(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true });
  const layout = ensureDataLayout(resolveDataLayout(ROOT));
  const handle: NayaroServerHandle = await startNayaroServer({
    allowDirectRegistration: true,
    port: PORT,
    databaseFilePath: layout.databaseFilePath,
    logger: createLogger({ scope: 'verify-corrections', silent: true }),
  });
  const { prisma } = handle;

  try {
    // =====================================================================
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

    const readOrder = async (id: string): Promise<OrderDto> =>
      orderOf((await call('GET', `/orders/${id}`, { token: cashier })).body);

    /** An OPEN order with one dispatched ticket. The start of most tests here. */
    const dispatchedOrder = async (
      items: { id: string; quantity?: number }[] = [{ id: momo.id, quantity: 2 }],
    ): Promise<{ order: OrderDto; table: { id: string; name: string } }> => {
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
      return { order, table };
    };

    const issue = async (order: OrderDto): Promise<InvoiceDto> =>
      invoiceOf(
        (
          await call('POST', `/orders/${order.id}/invoice`, {
            token: cashier,
            body: { expectedVersion: (await readOrder(order.id)).version },
          })
        ).body,
      );

    const ticketNumbers = async (): Promise<number[]> =>
      (
        (await call('GET', '/kitchen/tickets', { token: kitchen })).body as {
          tickets: { kotNumber: number }[];
        }
      ).tickets.map((t) => t.kotNumber);

    check('setup produced a working restaurant', restaurant.name === 'Himali Bhansa Ghar');

    // =====================================================================
    console.log('\n[A] KOT void - the dispatch was a mistake');

    {
      const { order, table } = await dispatchedOrder();
      const kot = order.tickets[0]!;
      check('a fresh order has one NEW ticket', order.tickets.length === 1 && kot.status === 'NEW');
      check('and 2 momo are dispatched', itemNamed(order, 'Chicken Momo').dispatchedQuantity === 2);
      check(
        'so nothing is left to send',
        itemNamed(order, 'Chicken Momo').undispatchedQuantity === 0,
      );

      const voided = await call('POST', `/kitchen/tickets/${kot.id}/void`, {
        token: manager,
        body: { reason: 'Sent to the wrong table' },
      });
      check('a NEW ticket may be voided', voided.status === 200, voided.status);

      const after = orderOf(voided.body);
      check(
        'the quantities come back to undispatched',
        itemNamed(after, 'Chicken Momo').undispatchedQuantity === 2,
      );
      check(
        'and nothing counts as dispatched any more',
        itemNamed(after, 'Chicken Momo').dispatchedQuantity === 0,
      );
      check('the ordered quantity never moved', itemNamed(after, 'Chicken Momo').quantity === 2);
      check('the order stays OPEN, not DRAFT', after.status === 'OPEN');
      check('live ticket count drops to zero', after.kitchen.ticketCount === 0);

      const record = after.tickets[0]!;
      check(
        'the ticket is kept, marked VOID',
        after.tickets.length === 1 && record.status === 'VOID',
      );
      check('with the reason', record.voidReason === 'Sent to the wrong table');
      check('who did it', record.voidedBy?.name === 'Sunita Karki');
      check('and when', typeof record.voidedAt === 'string' && record.voidedAt.length > 0);

      check(
        'the kitchen board no longer shows it',
        !(await ticketNumbers()).includes(kot.kotNumber),
      );
      check('the table falls back to OCCUPIED', (await floorStatus(table.name)) === 'OCCUPIED');

      // The whole point: it can be sent again.
      const resent = await call('POST', `/orders/${order.id}/send-kot`, {
        token: cashier,
        body: { expectedVersion: after.version },
      });
      check('the same food can be sent again', resent.status === 201, resent.status);
      const fresh = orderOf(resent.body);
      const live = fresh.tickets.filter((t) => t.status !== 'VOID');
      check('on a brand new ticket', live.length === 1 && live[0]!.kotNumber !== kot.kotNumber);
      check('and the voided number is never reused', live[0]!.kotNumber === kot.kotNumber + 1);
      check(
        'the kitchen sees the new ticket only',
        (await ticketNumbers()).includes(live[0]!.kotNumber),
      );
    }

    {
      const { order } = await dispatchedOrder();
      const kot = order.tickets[0]!;
      await call('PATCH', `/kitchen/tickets/${kot.id}/status`, {
        token: kitchen,
        body: { status: 'PREPARING' },
      });
      const voided = await call('POST', `/kitchen/tickets/${kot.id}/void`, {
        token: manager,
        body: { reason: 'Duplicate ticket' },
      });
      check('a PREPARING ticket may be voided', voided.status === 200, voided.status);
    }

    {
      const { order } = await dispatchedOrder();
      const kot = order.tickets[0]!;
      for (const status of ['PREPARING', 'READY'] as const) {
        await call('PATCH', `/kitchen/tickets/${kot.id}/status`, {
          token: kitchen,
          body: { status },
        });
      }
      const voided = await call('POST', `/kitchen/tickets/${kot.id}/void`, {
        token: manager,
        body: { reason: 'Ordered by mistake, kitchen informed' },
      });
      check('a READY ticket may still be voided', voided.status === 200, voided.status);

      const second = await call('POST', `/kitchen/tickets/${kot.id}/void`, {
        token: manager,
        body: { reason: 'again' },
      });
      check(
        'voiding it twice is refused',
        errorCode(second.body) === 'KOT_ALREADY_VOID',
        errorCode(second.body),
      );
      assertNoLeak('double void', second.body);
    }

    {
      const { order } = await dispatchedOrder();
      const kot = order.tickets[0]!;
      for (const status of ['PREPARING', 'READY', 'SERVED'] as const) {
        await call('PATCH', `/kitchen/tickets/${kot.id}/status`, {
          token: kitchen,
          body: { status },
        });
      }
      const voided = await call('POST', `/kitchen/tickets/${kot.id}/void`, {
        token: manager,
        body: { reason: 'too late' },
      });
      check(
        'a SERVED ticket cannot be voided',
        errorCode(voided.body) === 'KOT_ALREADY_SERVED',
        errorCode(voided.body),
      );
      check('and the message says what to do instead', /cancel/i.test(errorMessage(voided.body)));
    }

    {
      console.log('\n[A] KOT void - authority and races');
      const { order } = await dispatchedOrder();
      const kot = order.tickets[0]!;

      for (const [who, token] of [
        ['a cashier', cashier],
        ['the kitchen', kitchen],
      ] as const) {
        const denied = await call('POST', `/kitchen/tickets/${kot.id}/void`, {
          token,
          body: { reason: 'not allowed' },
        });
        check(`${who} may not void a ticket`, denied.status === 403, denied.status);
      }
      const noReason = await call('POST', `/kitchen/tickets/${kot.id}/void`, {
        token: manager,
        body: { reason: '   ' },
      });
      check('a blank reason is refused', noReason.status === 400, noReason.status);
      check(
        'the ticket survived every refusal',
        (await readOrder(order.id)).tickets[0]!.status === 'NEW',
      );

      const unknown = await call('POST', '/kitchen/tickets/cly000000000000000000000/void', {
        token: manager,
        body: { reason: 'nope' },
      });
      check('an unknown ticket is 404', unknown.status === 404, unknown.status);

      // Two managers, same ticket, same instant.
      const [a, b] = await Promise.all([
        call('POST', `/kitchen/tickets/${kot.id}/void`, {
          token: manager,
          body: { reason: 'race A' },
        }),
        call('POST', `/kitchen/tickets/${kot.id}/void`, {
          token: owner,
          body: { reason: 'race B' },
        }),
      ]);
      const winners = [a, b].filter((r) => r.status === 200);
      check(
        'two managers voiding at once produce exactly one void',
        winners.length === 1,
        `${String(a.status)}/${String(b.status)}`,
      );
      check(
        'and the ticket is voided once',
        (await prisma.kot.count({ where: { id: kot.id, status: 'VOID' } })) === 1,
      );
    }

    {
      const { order } = await dispatchedOrder();
      await issue(order);
      const kot = (await readOrder(order.id)).tickets[0]!;
      const voided = await call('POST', `/kitchen/tickets/${kot.id}/void`, {
        token: manager,
        body: { reason: 'wrong order' },
      });
      check(
        'a ticket on a BILLED order cannot be voided',
        errorCode(voided.body) === 'ORDER_ALREADY_BILLED',
        errorCode(voided.body),
      );
      check('and it says to void the bill first', /void the bill/i.test(errorMessage(voided.body)));
    }

    // =====================================================================
    console.log('\n[B] Cancelling dispatched items');

    {
      const { order, table } = await dispatchedOrder([
        { id: momo.id, quantity: 2 },
        { id: coke.id },
      ]);
      const item = itemNamed(order, 'Chicken Momo');

      const cancelled = await call('POST', `/orders/${order.id}/items/${item.id}/cancellations`, {
        token: manager,
        body: { quantity: 1, reason: 'Customer changed their mind' },
      });
      check('a manager may cancel a dispatched item', cancelled.status === 201, cancelled.status);

      const after = orderOf(cancelled.body);
      const line = itemNamed(after, 'Chicken Momo');
      check('the ordered quantity is untouched', line.quantity === 2);
      check('the dispatch history is untouched', line.dispatchedQuantity === 2);
      check('one is cancelled', line.cancelledQuantity === 1);
      check('one remains billable', line.billableQuantity === 1);
      check('and the line total follows the billable count', line.lineTotalPaisa === 22000);
      check('the reason is kept', line.cancellations[0]?.reason === 'Customer changed their mind');
      check('with who cancelled it', line.cancellations[0]?.cancelledBy.name === 'Sunita Karki');
      check('and when', typeof line.cancellations[0]?.cancelledAt === 'string');

      check(
        'the kitchen ticket still says 2',
        after.tickets[0]!.items.find((i) => i.name === 'Chicken Momo')?.quantity === 2,
      );
      check('nothing new becomes sendable', line.undispatchedQuantity === 0);
      check('the table is still preparing food', (await floorStatus(table.name)) === 'PREPARING');

      const preBill = (
        (await call('GET', `/orders/${order.id}/billing`, { token: cashier }))
          .body as BillingResponse
      ).preBill!;
      const preBillMomo = preBill.lines.find((l) => l.name === 'Chicken Momo')!;
      check('the pre-bill charges one momo', preBillMomo.billableQuantity === 1);
      check('and shows the cancelled one', preBillMomo.cancelledQuantity === 1);
      check(
        'the pre-bill subtotal is momo + coke',
        preBill.subtotalPaisa === 22000 + 9000,
        preBill.subtotalPaisa,
      );

      const invoice = await issue(after);
      const invoiceMomo = invoice.lines.find((l) => l.description === 'Chicken Momo')!;
      check('the invoice bills one momo', invoiceMomo.quantity === 1);
      check('at the right line total', invoiceMomo.lineTotalPaisa === 22000);
      check(
        'and the invoice subtotal matches',
        invoice.subtotalPaisa === 31000,
        invoice.subtotalPaisa,
      );
    }

    {
      console.log('\n[B] Cancellation guards');
      const { order } = await dispatchedOrder([{ id: momo.id, quantity: 2 }]);
      const item = itemNamed(order, 'Chicken Momo');

      const tooMany = await call('POST', `/orders/${order.id}/items/${item.id}/cancellations`, {
        token: manager,
        body: { quantity: 3, reason: 'more than exists' },
      });
      check(
        'cancelling more than went to the kitchen is refused',
        errorCode(tooMany.body) === 'CANCELS_MORE_THAN_SENT',
        errorCode(tooMany.body),
      );
      assertNoLeak('over-cancel', tooMany.body);

      await call('POST', `/orders/${order.id}/items/${item.id}/cancellations`, {
        token: manager,
        body: { quantity: 2, reason: 'Whole order cancelled by the customer' },
      });
      const full = itemNamed(await readOrder(order.id), 'Chicken Momo');
      check('a fully dispatched line can be fully cancelled', full.cancelledQuantity === 2);
      check('and nothing is billable', full.billableQuantity === 0);

      const again = await call('POST', `/orders/${order.id}/items/${item.id}/cancellations`, {
        token: manager,
        body: { quantity: 1, reason: 'one too many' },
      });
      check(
        'cancelling past that is refused',
        errorCode(again.body) === 'CANCELS_MORE_THAN_SENT',
        errorCode(again.body),
      );
      check(
        'and the message says so plainly',
        /already been cancelled/i.test(errorMessage(again.body)),
        errorMessage(again.body),
      );

      const nothing = await call('GET', `/orders/${order.id}/billing`, { token: cashier });
      check(
        'the pre-bill for a fully cancelled order is zero',
        (nothing.body as BillingResponse).preBill!.subtotalPaisa === 0,
      );
      const cannotIssue = await call('POST', `/orders/${order.id}/invoice`, {
        token: cashier,
        body: { expectedVersion: (await readOrder(order.id)).version },
      });
      check(
        'and it cannot be billed at all',
        errorCode(cannotIssue.body) === 'NOTHING_TO_BILL',
        errorCode(cannotIssue.body),
      );

      const kot = (await readOrder(order.id)).tickets[0]!;
      const voidAfterCancel = await call('POST', `/kitchen/tickets/${kot.id}/void`, {
        token: manager,
        body: { reason: 'trying both corrections at once' },
      });
      check(
        'its ticket can no longer be voided as sent-in-error',
        errorCode(voidAfterCancel.body) === 'KOT_HAS_CANCELLATIONS',
        errorCode(voidAfterCancel.body),
      );
    }

    {
      const table = await newTable();
      const draft = orderOf(
        (
          await call('POST', '/orders/items', {
            token: cashier,
            body: {
              target: { kind: 'TABLE', tableId: table.id },
              menuItemId: momo.id,
              quantity: 2,
            },
          })
        ).body,
      );
      const item = draft.items[0]!;
      const undispatched = await call(
        'POST',
        `/orders/${draft.id}/items/${item.id}/cancellations`,
        {
          token: manager,
          body: { quantity: 1, reason: 'not sent yet' },
        },
      );
      check(
        'an item the kitchen never saw is not cancellable',
        errorCode(undispatched.body) === 'ORDER_NOT_EDITABLE' ||
          errorCode(undispatched.body) === 'ITEM_NOT_DISPATCHED',
        errorCode(undispatched.body),
      );
      check(
        'and it points at the ordinary edit instead',
        /quantity/i.test(errorMessage(undispatched.body)),
        errorMessage(undispatched.body),
      );
    }

    {
      const { order } = await dispatchedOrder([{ id: momo.id, quantity: 2 }]);
      const item = itemNamed(order, 'Chicken Momo');

      for (const [who, token] of [
        ['a cashier', cashier],
        ['the kitchen', kitchen],
      ] as const) {
        const denied = await call('POST', `/orders/${order.id}/items/${item.id}/cancellations`, {
          token,
          body: { quantity: 1, reason: 'not allowed' },
        });
        check(`${who} may not cancel an item`, denied.status === 403, denied.status);
      }
      const blank = await call('POST', `/orders/${order.id}/items/${item.id}/cancellations`, {
        token: manager,
        body: { quantity: 1, reason: '' },
      });
      check('a cancellation needs a reason', blank.status === 400, blank.status);
      const zero = await call('POST', `/orders/${order.id}/items/${item.id}/cancellations`, {
        token: manager,
        body: { quantity: 0, reason: 'nothing' },
      });
      check('and a quantity above zero', zero.status === 400, zero.status);
      const unknown = await call(
        `POST`,
        `/orders/${order.id}/items/cly000000000000000000000/cancellations`,
        { token: manager, body: { quantity: 1, reason: 'ghost' } },
      );
      check('an item from another order is 404', unknown.status === 404, unknown.status);
      check(
        'nothing was cancelled by any of that',
        itemNamed(await readOrder(order.id), 'Chicken Momo').cancelledQuantity === 0,
      );

      // Two managers, both cancelling the last remaining unit.
      await call('POST', `/orders/${order.id}/items/${item.id}/cancellations`, {
        token: manager,
        body: { quantity: 1, reason: 'first one' },
      });
      const [a, b] = await Promise.all([
        call('POST', `/orders/${order.id}/items/${item.id}/cancellations`, {
          token: manager,
          body: { quantity: 1, reason: 'race A' },
        }),
        call('POST', `/orders/${order.id}/items/${item.id}/cancellations`, {
          token: owner,
          body: { quantity: 1, reason: 'race B' },
        }),
      ]);
      const winners = [a, b].filter((r) => r.status === 201);
      check(
        'two managers cancelling the last unit produce exactly one cancellation',
        winners.length === 1,
        `${String(a.status)}/${String(b.status)}`,
      );
      const final = itemNamed(await readOrder(order.id), 'Chicken Momo');
      check('and the line cannot be over-cancelled', final.cancelledQuantity === 2);
      check('billable never goes negative', final.billableQuantity === 0);
    }

    // =====================================================================
    console.log('\n[C] Voiding an unpaid invoice, and reissuing');

    {
      const { order, table } = await dispatchedOrder([{ id: momo.id, quantity: 2 }]);
      const invoice = await issue(order);
      check('the order is BILLED', (await readOrder(order.id)).status === 'BILLED');
      check(
        'the table is awaiting payment',
        (await floorStatus(table.name)) === 'AWAITING_PAYMENT',
      );

      const voided = await call('POST', `/invoices/${invoice.id}/void`, {
        token: manager,
        body: { reason: 'Wrong items on the bill' },
      });
      check('an unpaid bill may be voided', voided.status === 200, voided.status);

      const dead = invoiceOf(voided.body);
      check('the invoice is VOID', dead.status === 'VOID');
      check('with a reason', dead.void?.reason === 'Wrong items on the bill');
      check('and who voided it', dead.void?.voidedBy.name === 'Sunita Karki');
      check('and when', typeof dead.void?.voidedAt === 'string');
      check('its lines survive', dead.lines.length === 1);
      check('and its total survives', dead.grandTotalPaisa === invoice.grandTotalPaisa);

      check('the order reopens', (await readOrder(order.id)).status === 'OPEN');
      check(
        'the table leaves AWAITING_PAYMENT',
        (await floorStatus(table.name)) !== 'AWAITING_PAYMENT',
      );
      check(
        'no ACTIVE invoice remains',
        (await prisma.invoice.count({ where: { orderId: order.id, status: 'ACTIVE' } })) === 0,
      );
      check(
        'the billing screen offers a fresh pre-bill',
        (
          (await call('GET', `/orders/${order.id}/billing`, { token: cashier }))
            .body as BillingResponse
        ).preBill !== null,
      );

      // Correct the mistake, then reissue.
      const item = itemNamed(await readOrder(order.id), 'Chicken Momo');
      await call('POST', `/orders/${order.id}/items/${item.id}/cancellations`, {
        token: manager,
        body: { quantity: 1, reason: 'Only one was actually eaten' },
      });
      const reissued = await issue(await readOrder(order.id));
      check(
        'a reissue takes the NEXT number',
        reissued.invoiceNumber === invoice.invoiceNumber + 1,
        `${String(invoice.invoiceNumber)} -> ${String(reissued.invoiceNumber)}`,
      );
      check('the old number is never reused', reissued.invoiceNumber !== invoice.invoiceNumber);
      check('the new bill reflects the correction', reissued.lines[0]!.quantity === 1);
      check(
        'the voided one stays VOID',
        (await prisma.invoice.findFirstOrThrow({ where: { id: invoice.id } })).status === 'VOID',
      );
      check(
        'and exactly one ACTIVE invoice exists again',
        (await prisma.invoice.count({ where: { orderId: order.id, status: 'ACTIVE' } })) === 1,
      );

      const twice = await call('POST', `/invoices/${invoice.id}/void`, {
        token: manager,
        body: { reason: 'again' },
      });
      check(
        'voiding the same bill twice is refused',
        errorCode(twice.body) === 'INVOICE_ALREADY_VOID',
        errorCode(twice.body),
      );
    }

    {
      console.log('\n[C] Invoice void - authority, payments and the race');
      const { order } = await dispatchedOrder([{ id: momo.id, quantity: 1 }]);
      const invoice = await issue(order);

      for (const [who, token] of [
        ['a cashier', cashier],
        ['the kitchen', kitchen],
      ] as const) {
        const denied = await call('POST', `/invoices/${invoice.id}/void`, {
          token,
          body: { reason: 'not allowed' },
        });
        check(`${who} may not void a bill`, denied.status === 403, denied.status);
      }
      const blank = await call('POST', `/invoices/${invoice.id}/void`, {
        token: manager,
        body: { reason: '  ' },
      });
      check('voiding a bill needs a reason', blank.status === 400, blank.status);
      const unknown = await call('POST', '/invoices/cly000000000000000000000/void', {
        token: manager,
        body: { reason: 'ghost' },
      });
      check('an unknown bill is 404', unknown.status === 404, unknown.status);

      await call('POST', `/invoices/${invoice.id}/payments`, {
        token: cashier,
        body: {
          expectedOrderVersion: (await readOrder(order.id)).version,
          method: 'CASH',
          amountPaisa: 1000,
        },
      });
      const withMoney = await call('POST', `/invoices/${invoice.id}/void`, {
        token: manager,
        body: { reason: 'money is on it' },
      });
      check(
        'a bill with money on it cannot be voided',
        errorCode(withMoney.body) === 'INVOICE_HAS_PAYMENTS',
        errorCode(withMoney.body),
      );
      check(
        'and it says to void the payment first',
        /void the payment/i.test(errorMessage(withMoney.body)),
        errorMessage(withMoney.body),
      );
    }

    {
      // Manager voids the bill while a cashier takes money for it.
      const { order } = await dispatchedOrder([{ id: momo.id, quantity: 1 }]);
      const invoice = await issue(order);
      const version = (await readOrder(order.id)).version;

      const [voidRes, payRes] = await Promise.all([
        call('POST', `/invoices/${invoice.id}/void`, {
          token: manager,
          body: { reason: 'racing the till' },
        }),
        call('POST', `/invoices/${invoice.id}/payments`, {
          token: cashier,
          body: { expectedOrderVersion: version, method: 'CASH', amountPaisa: 1000 },
        }),
      ]);
      const voidWon = voidRes.status === 200;
      const payWon = payRes.status === 201;
      check(
        'a void racing a payment does not produce both',
        !(voidWon && payWon),
        `void ${String(voidRes.status)} / pay ${String(payRes.status)}`,
      );
      check(
        'exactly one of them succeeded',
        voidWon !== payWon,
        `void ${String(voidRes.status)} / pay ${String(payRes.status)}`,
      );

      const finalInvoice = await prisma.invoice.findFirstOrThrow({ where: { id: invoice.id } });
      const livePayments = await prisma.payment.count({
        where: { invoiceId: invoice.id, voidedAt: null },
      });
      check(
        'a VOID invoice never holds a live payment',
        finalInvoice.status === 'ACTIVE' || livePayments === 0,
        `${finalInvoice.status}/${String(livePayments)}`,
      );
      check(
        'and a paid invoice is still ACTIVE',
        livePayments === 0 || finalInvoice.status === 'ACTIVE',
      );
    }

    {
      const { order } = await dispatchedOrder([{ id: momo.id, quantity: 1 }]);
      const invoice = await issue(order);
      await call('POST', `/invoices/${invoice.id}/payments`, {
        token: cashier,
        body: {
          expectedOrderVersion: (await readOrder(order.id)).version,
          method: 'CASH',
          amountPaisa: invoice.grandTotalPaisa,
        },
      });
      check('the order is settled', (await readOrder(order.id)).status === 'PAID');
      const settled = await call('POST', `/invoices/${invoice.id}/void`, {
        token: manager,
        body: { reason: 'too late' },
      });
      check(
        'a settled sale cannot be voided',
        errorCode(settled.body) === 'ORDER_ALREADY_PAID',
        errorCode(settled.body),
      );
      check(
        'and it says a refund would be needed',
        /refund/i.test(errorMessage(settled.body)),
        errorMessage(settled.body),
      );
    }

    // =====================================================================
    console.log('\n[D] Reversing a payment before the sale closes');

    {
      const { order } = await dispatchedOrder([{ id: momo.id, quantity: 2 }]);
      const invoice = await issue(order);
      const paid = invoiceOf(
        (
          await call('POST', `/invoices/${invoice.id}/payments`, {
            token: cashier,
            body: {
              expectedOrderVersion: (await readOrder(order.id)).version,
              method: 'CASH',
              amountPaisa: 40000,
            },
          })
        ).body,
      );
      check('a partial payment is recorded', paid.settlement.totalPaidPaisa === 40000);
      const remainingBefore = paid.settlement.remainingPaisa;
      check('and the bill is PARTIAL', paid.settlement.status === 'PARTIAL');
      check('the order is still BILLED', (await readOrder(order.id)).status === 'BILLED');

      const payment = paid.settlement.payments[0]!;
      const reversed = await call('POST', `/payments/${payment.id}/void`, {
        token: manager,
        body: { reason: 'Keyed as cash, customer actually paid by QR' },
      });
      check('a manager may reverse it', reversed.status === 200, reversed.status);

      const after = invoiceOf(reversed.body);
      check('the total paid falls back to zero', after.settlement.totalPaidPaisa === 0);
      check(
        'the remaining balance rises again',
        after.settlement.remainingPaisa === remainingBefore + 40000,
      );
      check('the bill is UNPAID again', after.settlement.status === 'UNPAID');
      check('the payment row is NOT deleted', after.settlement.payments.length === 1);
      check('it is shown as voided', after.settlement.payments[0]!.void !== null);
      check(
        'with the reason',
        after.settlement.payments[0]!.void?.reason ===
          'Keyed as cash, customer actually paid by QR',
      );
      check(
        'and who reversed it',
        after.settlement.payments[0]!.void?.voidedBy.name === 'Sunita Karki',
      );
      check(
        'the row survives in the database',
        (await prisma.payment.count({ where: { id: payment.id } })) === 1,
      );

      const twice = await call('POST', `/payments/${payment.id}/void`, {
        token: manager,
        body: { reason: 'again' },
      });
      check(
        'reversing it twice is refused',
        errorCode(twice.body) === 'PAYMENT_ALREADY_VOID',
        errorCode(twice.body),
      );

      // And now the correct payment.
      const corrected = invoiceOf(
        (
          await call('POST', `/invoices/${invoice.id}/payments`, {
            token: cashier,
            body: {
              expectedOrderVersion: (await readOrder(order.id)).version,
              method: 'QR',
              amountPaisa: after.grandTotalPaisa,
              reference: 'FP-99887',
            },
          })
        ).body,
      );
      check('the right payment settles the bill', corrected.settlement.remainingPaisa === 0);
      check(
        'counting only the live one',
        corrected.settlement.totalPaidPaisa === corrected.grandTotalPaisa,
      );
      check('both rows are on the record', corrected.settlement.payments.length === 2);
      check('the order closes', (await readOrder(order.id)).status === 'PAID');

      const tooLate = await call('POST', `/payments/${corrected.settlement.payments[1]!.id}/void`, {
        token: manager,
        body: { reason: 'after the fact' },
      });
      check(
        'a payment on a settled sale cannot be reversed',
        errorCode(tooLate.body) === 'ORDER_ALREADY_PAID',
        errorCode(tooLate.body),
      );
      check(
        'and it says a refund would be needed',
        /refund/i.test(errorMessage(tooLate.body)),
        errorMessage(tooLate.body),
      );
    }

    {
      console.log('\n[D] Payment void - authority and races');
      const { order } = await dispatchedOrder([{ id: momo.id, quantity: 2 }]);
      const invoice = await issue(order);
      const paid = invoiceOf(
        (
          await call('POST', `/invoices/${invoice.id}/payments`, {
            token: cashier,
            body: {
              expectedOrderVersion: (await readOrder(order.id)).version,
              method: 'CASH',
              amountPaisa: 10000,
            },
          })
        ).body,
      );
      const payment = paid.settlement.payments[0]!;

      for (const [who, token] of [
        ['a cashier', cashier],
        ['the kitchen', kitchen],
      ] as const) {
        const denied = await call('POST', `/payments/${payment.id}/void`, {
          token,
          body: { reason: 'not allowed' },
        });
        check(`${who} may not reverse a payment`, denied.status === 403, denied.status);
      }
      const blank = await call('POST', `/payments/${payment.id}/void`, {
        token: manager,
        body: { reason: '' },
      });
      check('reversing a payment needs a reason', blank.status === 400, blank.status);
      const unknown = await call('POST', '/payments/cly000000000000000000000/void', {
        token: manager,
        body: { reason: 'ghost' },
      });
      check('an unknown payment is 404', unknown.status === 404, unknown.status);

      const [a, b] = await Promise.all([
        call('POST', `/payments/${payment.id}/void`, {
          token: manager,
          body: { reason: 'race A' },
        }),
        call('POST', `/payments/${payment.id}/void`, { token: owner, body: { reason: 'race B' } }),
      ]);
      check(
        'two managers reversing at once produce exactly one reversal',
        [a, b].filter((r) => r.status === 200).length === 1,
        `${String(a.status)}/${String(b.status)}`,
      );
      const row = await prisma.payment.findFirstOrThrow({ where: { id: payment.id } });
      check('with one reason, not two', row.voidReason === 'race A' || row.voidReason === 'race B');

      // The sequence the whole phase exists for.
      const nowVoidable = await call('POST', `/invoices/${invoice.id}/void`, {
        token: manager,
        body: { reason: 'Bill was wrong; payment already reversed' },
      });
      check(
        'a bill whose only payment was reversed can now be voided',
        nowVoidable.status === 200,
        nowVoidable.status,
      );
      check('and the order reopens', (await readOrder(order.id)).status === 'OPEN');
    }

    // =====================================================================
    console.log('\n[E] No generic history deletion exists');

    {
      const { order } = await dispatchedOrder([{ id: momo.id, quantity: 1 }]);
      const kot = order.tickets[0]!;
      const invoice = await issue(order);
      const paidInvoice = invoiceOf(
        (
          await call('POST', `/invoices/${invoice.id}/payments`, {
            token: cashier,
            body: {
              expectedOrderVersion: (await readOrder(order.id)).version,
              method: 'CASH',
              amountPaisa: 1000,
            },
          })
        ).body,
      );
      for (const [what, path] of [
        ['a ticket', `/kitchen/tickets/${kot.id}`],
        ['an invoice', `/invoices/${invoice.id}`],
        ['a payment', `/payments/${paidInvoice.settlement.payments[0]!.id}`],
      ] as const) {
        const deleted = await call('DELETE', path, { token: owner });
        check(`there is no DELETE for ${what}`, deleted.status === 404, deleted.status);
      }
      check('the ticket is still there', (await prisma.kot.count({ where: { id: kot.id } })) === 1);
      check('so is the invoice', (await prisma.invoice.count({ where: { id: invoice.id } })) === 1);
      check(
        'and so is the payment',
        (await prisma.payment.count({ where: { invoiceId: invoice.id } })) === 1,
      );
    }

    // =====================================================================
    console.log('\n[GOLDEN] Scenario A - sent to the kitchen by mistake');
    {
      const { order, table } = await dispatchedOrder([{ id: momo.id, quantity: 2 }]);
      const kot = order.tickets[0]!;
      check('A1 momo x2 is on a ticket', kot.items[0]!.quantity === 2);
      check('A2 the table is preparing', (await floorStatus(table.name)) === 'PREPARING');

      await call('POST', `/kitchen/tickets/${kot.id}/void`, {
        token: manager,
        body: { reason: 'Sent to the wrong table' },
      });
      const reopened = await readOrder(order.id);
      check(
        'A3 the quantities are unsent again',
        itemNamed(reopened, 'Chicken Momo').undispatchedQuantity === 2,
      );
      check('A4 the table is merely occupied', (await floorStatus(table.name)) === 'OCCUPIED');

      await call('POST', `/orders/${order.id}/send-kot`, {
        token: cashier,
        body: { expectedVersion: reopened.version },
      });
      const resent = await readOrder(order.id);
      check('A5 the kitchen has a new ticket', resent.kitchen.ticketCount === 1);
      check(
        'A6 and the void is still on the record',
        resent.tickets.filter((t) => t.status === 'VOID').length === 1,
      );
    }

    console.log('\n[GOLDEN] Scenario B - the customer cancels one');
    {
      const { order } = await dispatchedOrder([{ id: momo.id, quantity: 2 }]);
      const item = itemNamed(order, 'Chicken Momo');
      await call('POST', `/orders/${order.id}/items/${item.id}/cancellations`, {
        token: manager,
        body: { quantity: 1, reason: 'Customer changed their mind' },
      });
      const after = await readOrder(order.id);
      check('B1 the kitchen record still says 2', after.tickets[0]!.items[0]!.quantity === 2);
      const invoice = await issue(after);
      check('B2 the bill charges 1', invoice.lines[0]!.quantity === 1);
      check('B3 for the price of one', invoice.subtotalPaisa === 22000);
    }

    console.log('\n[GOLDEN] Scenario C - wrong bill, reissued');
    {
      const { order } = await dispatchedOrder([{ id: momo.id, quantity: 2 }, { id: coke.id }]);
      const wrong = await issue(order);
      check('C1 a bill is issued', wrong.status === 'ACTIVE');

      await call('POST', `/invoices/${wrong.id}/void`, {
        token: manager,
        body: { reason: 'Coke was for the next table' },
      });
      const reopened = await readOrder(order.id);
      check('C2 the order reopens', reopened.status === 'OPEN');

      const cokeLine = itemNamed(reopened, 'Coke');
      await call('POST', `/orders/${order.id}/items/${cokeLine.id}/cancellations`, {
        token: manager,
        body: { quantity: 1, reason: 'Belonged to another table' },
      });
      const right = await issue(await readOrder(order.id));
      check('C3 the new bill has one line', right.lines.length === 1);
      check('C4 charging only the momo', right.subtotalPaisa === 44000, right.subtotalPaisa);
      check('C5 with a new number', right.invoiceNumber === wrong.invoiceNumber + 1);
      check(
        'C6 and the old one stays VOID',
        (await prisma.invoice.findFirstOrThrow({ where: { id: wrong.id } })).status === 'VOID',
      );
    }

    console.log('\n[GOLDEN] Scenario D - paid by the wrong method');
    {
      const { order, table } = await dispatchedOrder([{ id: momo.id, quantity: 2 }]);
      const invoice = await issue(order);
      const partial = invoiceOf(
        (
          await call('POST', `/invoices/${invoice.id}/payments`, {
            token: cashier,
            body: {
              expectedOrderVersion: (await readOrder(order.id)).version,
              method: 'CASH',
              amountPaisa: 40000,
            },
          })
        ).body,
      );
      check('D1 Rs 400 is recorded as cash', partial.settlement.totalPaidPaisa === 40000);

      const reversed = invoiceOf(
        (
          await call('POST', `/payments/${partial.settlement.payments[0]!.id}/void`, {
            token: manager,
            body: { reason: 'Was actually paid by QR' },
          })
        ).body,
      );
      check(
        'D2 the balance rises back to the full amount',
        reversed.settlement.remainingPaisa === reversed.grandTotalPaisa,
      );

      const settled = invoiceOf(
        (
          await call('POST', `/invoices/${invoice.id}/payments`, {
            token: cashier,
            body: {
              expectedOrderVersion: (await readOrder(order.id)).version,
              method: 'QR',
              amountPaisa: reversed.grandTotalPaisa,
              reference: 'FP-10231',
            },
          })
        ).body,
      );
      check('D3 the QR payment settles it', settled.settlement.status === 'PAID');
      check(
        'D4 the wrong payment is still visible, marked void',
        settled.settlement.payments.filter((p) => p.void !== null).length === 1,
      );
      check('D5 counted at zero', settled.settlement.totalPaidPaisa === settled.grandTotalPaisa);
      check('D6 and the table is free', (await floorStatus(table.name)) === 'AVAILABLE');
    }

    // =====================================================================
    console.log('\n[integrity] the database still enforces its own rules');
    await assertDatabaseIntegrity(prisma);
    check('CHECK constraints survived the phase', true);
  } finally {
    await stopNayaroServer(handle);
  }

  console.log(`\n${fail === 0 ? `ALL ${String(pass)} CHECKS PASSED` : `${String(fail)} FAILED`}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
