/**
 * Phase 4D backend verification - drives the real HTTP API and a real socket.
 *
 *   npm run verify:kitchen --workspace @nayaro/server
 *
 * Disposable temp data root, non-default port. Never touches the dev database.
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { io as socketClient } from 'socket.io-client';
import type {
  KitchenTicket,
  KitchenTicketsResponse,
  KotCreatedPayload,
  OrderDto,
} from '@nayaro/shared';
import { REALTIME_EVENTS } from '@nayaro/shared';
import { ensureDataLayout, resolveDataLayout } from '@nayaro/database';
import { createLogger } from '../src/utils/logger';
import { startNayaroServer, stopNayaroServer, type NayaroServerHandle } from '../src/server';
import { hashPassword } from '../src/modules/auth/password';

const ROOT = resolve(tmpdir(), 'nayaro-4d-verify');
const PORT = 4330;
const BASE = `http://127.0.0.1:${String(PORT)}`;

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
const kotOf = (body: unknown): KitchenTicket => (body as { kot: KitchenTicket }).kot;
/** Throws rather than falling back: a test that silently reads the wrong row
 * reports a pass it has not earned. */
const lineFor = (order: OrderDto, name: string): OrderDto['items'][number] => {
  const line = order.items.find((i) => i.name.startsWith(name));
  if (!line) throw new Error(`no order line for ${name}`);
  return line;
};

async function main(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true });
  const layout = ensureDataLayout(resolveDataLayout(ROOT));
  const handle: NayaroServerHandle = await startNayaroServer({
    allowDirectRegistration: true,
    port: PORT,
    databaseFilePath: layout.databaseFilePath,
    logger: createLogger({ scope: 'verify-kitchen', silent: true }),
  });
  const { prisma } = handle;

  try {
    // -------------------------------------------------------------- fixtures
    console.log('[setup]');
    await call('POST', '/tenants/register', {
      body: {
        restaurant: { slug: 'verify-restaurant', name: 'Himali Bhansa Ghar' },
        owner: { name: 'Rajan Shrestha', username: 'rajan.s', password: 'correct-horse-battery' },
      },
    });
    const restaurant = await prisma.restaurant.findFirstOrThrow();
    for (const [name, username, role] of [
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
    const tokenFor = async (username: string, password: string): Promise<string> =>
      (
        (await call('POST', '/auth/login', { body: { workspace: 'verify-restaurant', username, password } })).body as {
          token: string;
        }
      ).token;
    const owner = await tokenFor('rajan.s', 'correct-horse-battery');
    const cashier = await tokenFor('bikash.t', 'staff1234');
    const kitchen = await tokenFor('maya.g', 'staff1234');

    const area = await prisma.restaurantArea.create({
      data: { restaurantId: restaurant.id, name: 'Ground Floor' },
    });
    const table4 = await prisma.restaurantTable.create({
      data: { restaurantId: restaurant.id, areaId: area.id, name: 'Table 4' },
    });
    const table7 = await prisma.restaurantTable.create({
      data: { restaurantId: restaurant.id, areaId: area.id, name: 'Table 7' },
    });
    const category = await prisma.menuCategory.create({
      data: { restaurantId: restaurant.id, name: 'Momo' },
    });
    const momo = await prisma.menuItem.create({
      data: {
        restaurantId: restaurant.id,
        categoryId: category.id,
        name: 'Chicken Momo',
        nameNp: 'चिकन मोमो',
        pricePaisa: 22000,
      },
    });
    const coke = await prisma.menuItem.create({
      data: {
        restaurantId: restaurant.id,
        categoryId: category.id,
        name: 'Coke',
        nameNp: 'कोक',
        pricePaisa: 9000,
        sortOrder: 1,
      },
    });
    check('fixtures created', true);

    // A real second client, exactly as a kitchen terminal would be.
    const socket = socketClient(BASE, {
      transports: ['websocket'],
      reconnection: false,
      auth: { token: kitchen },
    });
    const kotEvents: KotCreatedPayload[] = [];
    socket.on(REALTIME_EVENTS.kotCreated, (payload: KotCreatedPayload) => {
      kotEvents.push(payload);
    });
    await new Promise<void>((res, rej) => {
      socket.once('connect', () => {
        res();
      });
      socket.once('connect_error', rej);
    });
    check('a second client is connected and listening', socket.connected);

    // ------------------------------------------------------- build the order
    console.log('\n[build the order: momo x2, coke x1]');
    let order = orderOf(
      (
        await call('POST', '/orders/items', {
          token: cashier,
          body: {
            target: { kind: 'TABLE', tableId: table4.id },
            menuItemId: momo.id,
            note: 'less spicy',
          },
        })
      ).body,
    );
    order = orderOf(
      (
        await call('POST', '/orders/items', {
          token: cashier,
          body: {
            target: { kind: 'ORDER', orderId: order.id, expectedVersion: order.version },
            menuItemId: momo.id,
            note: 'less spicy',
          },
        })
      ).body,
    );
    order = orderOf(
      (
        await call('POST', '/orders/items', {
          token: cashier,
          body: {
            target: { kind: 'ORDER', orderId: order.id, expectedVersion: order.version },
            menuItemId: coke.id,
          },
        })
      ).body,
    );
    check('order is DRAFT', order.status === 'DRAFT');
    check('momo x2, coke x1', order.items.length === 2);
    check(
      'nothing dispatched yet',
      order.items.every((i) => i.dispatchedQuantity === 0),
    );
    check(
      'everything is undispatched',
      order.items.every((i) => i.undispatchedQuantity === i.quantity),
    );

    let r = await call('GET', '/floor', { token: cashier });
    const statusOf = (body: unknown, name: string): string | undefined =>
      (body as { areas: { tables: { name: string; status: string }[] }[] }).areas
        .flatMap((a) => a.tables)
        .find((t) => t.name === name)?.status;
    check(
      'Table 4 is OCCUPIED before the send',
      statusOf(r.body, 'Table 4') === 'OCCUPIED',
      statusOf(r.body, 'Table 4'),
    );

    // ------------------------------------------------------------ first send
    console.log('\n[first send]');
    r = await call('POST', `/orders/${order.id}/send-kot`, {
      token: cashier,
      body: { expectedVersion: order.version },
    });
    check('send -> 201', r.status === 201, r.status);
    let kot = kotOf(r.body);
    order = orderOf(r.body);
    check('order became OPEN', order.status === 'OPEN', order.status);
    check('KOT number allocated from 1', kot.kotNumber === 1, kot.kotNumber);
    check('ticket status NEW', kot.status === 'NEW');
    check('ticket names the table', kot.tableName === 'Table 4');
    check('ticket carries the order number', kot.orderNumber === order.orderNumber);
    check('two lines on the ticket', kot.items.length === 2, kot.items.length);
    check(
      'momo x2 on the ticket',
      kot.items.find((i) => i.name === 'Chicken Momo')?.quantity === 2,
      kot.items.find((i) => i.name === 'Chicken Momo')?.quantity,
    );
    check('coke x1 on the ticket', kot.items.find((i) => i.name === 'Coke')?.quantity === 1);
    check(
      'the note went to the kitchen',
      kot.items.find((i) => i.name === 'Chicken Momo')?.note === 'less spicy',
    );
    check('elapsed starts near zero', kot.elapsedSeconds < 5, kot.elapsedSeconds);
    check(
      'order now shows everything dispatched',
      order.items.every((i) => i.undispatchedQuantity === 0),
    );
    check(
      'dispatched quantities match what was sent',
      order.items.every((i) => i.dispatchedQuantity === i.quantity),
    );
    check('exactly one KOT exists', (await prisma.kot.count()) === 1);

    await new Promise((res) => setTimeout(res, 300));
    check('the other client received kot:created', kotEvents.length === 1, kotEvents.length);
    check('event names the ticket', kotEvents[0]?.kotNumber === 1);
    check('event names the table', kotEvents[0]?.tableId === table4.id);

    r = await call('GET', '/floor', { token: cashier });
    check(
      'Table 4 turned PREPARING',
      statusOf(r.body, 'Table 4') === 'PREPARING',
      statusOf(r.body, 'Table 4'),
    );

    // ---------------------------------------------------------- the no-op send
    console.log('\n[no-op send]');
    const kotCountBefore = await prisma.kot.count();
    const counterBefore = await prisma.restaurantCounter.findFirstOrThrow({
      where: { restaurantId: restaurant.id, name: 'KOT' },
    });
    r = await call('POST', `/orders/${order.id}/send-kot`, {
      token: cashier,
      body: { expectedVersion: order.version },
    });
    check('nothing left to send -> 409', r.status === 409, r.status);
    check('code NOTHING_TO_SEND', errorCode(r.body) === 'NOTHING_TO_SEND');
    check('no empty KOT was written', (await prisma.kot.count()) === kotCountBefore);
    const counterAfter = await prisma.restaurantCounter.findFirstOrThrow({
      where: { restaurantId: restaurant.id, name: 'KOT' },
    });
    check(
      'and no KOT number was consumed',
      counterAfter.nextValue === counterBefore.nextValue,
      `${String(counterBefore.nextValue)} -> ${String(counterAfter.nextValue)}`,
    );

    // -------------------------------------------------------- the delta send
    console.log('\n[second send carries only the delta]');
    order = orderOf((await call('GET', `/orders/${order.id}`, { token: cashier })).body);
    const cokeLine = lineFor(order, 'Coke');
    r = await call('PATCH', `/orders/${order.id}/items/${cokeLine.id}`, {
      token: cashier,
      body: { expectedVersion: order.version, quantity: 2 },
    });
    order = orderOf(r.body);
    check('coke is now 2 ordered, 1 sent', lineFor(order, 'Coke').dispatchedQuantity === 1);
    check('so 1 is waiting to go', lineFor(order, 'Coke').undispatchedQuantity === 1);
    check('momo has nothing waiting', lineFor(order, 'Chicken Momo').undispatchedQuantity === 0);

    r = await call('POST', `/orders/${order.id}/send-kot`, {
      token: cashier,
      body: { expectedVersion: order.version },
    });
    check('second send -> 201', r.status === 201, r.status);
    kot = kotOf(r.body);
    order = orderOf(r.body);
    check('KOT #2', kot.kotNumber === 2, kot.kotNumber);
    check('ONE line on the second ticket', kot.items.length === 1, kot.items.length);
    check('and it is the coke', kot.items[0]?.name === 'Coke');
    check('quantity 1, not 2', kot.items[0]?.quantity === 1, kot.items[0]?.quantity);
    check('the momo was NOT resent', !kot.items.some((i) => i.name === 'Chicken Momo'));
    check(
      'everything is now dispatched again',
      order.items.every((i) => i.undispatchedQuantity === 0),
    );
    check('coke total dispatched is 2', lineFor(order, 'Coke').dispatchedQuantity === 2);

    // ------------------------------------------------------- note immutability
    console.log('\n[the ticket is a historical fact]');
    const notedLine = order.items.find((i) => i.note === 'less spicy');
    r = await call('PATCH', `/orders/${order.id}/items/${notedLine?.id ?? ''}`, {
      token: cashier,
      body: { expectedVersion: order.version, note: 'no onion' },
    });
    order = orderOf(r.body);
    check(
      'the order note now says no onion',
      order.items.some((i) => i.note === 'no onion'),
    );

    await prisma.menuItem.update({
      where: { id: momo.id },
      data: { name: 'Chicken Momo (Half)', pricePaisa: 30000 },
    });
    const tickets = (
      (await call('GET', '/kitchen/tickets', { token: kitchen })).body as KitchenTicketsResponse
    ).tickets;
    const firstTicket = tickets.find((t) => t.kotNumber === 1);
    check(
      'KOT #1 still says "less spicy"',
      firstTicket?.items.find((i) => i.name.startsWith('Chicken Momo'))?.note === 'less spicy',
      firstTicket?.items.find((i) => i.name.startsWith('Chicken Momo'))?.note,
    );
    check(
      'and still says the original dish name',
      firstTicket?.items.some((i) => i.name === 'Chicken Momo') === true,
      firstTicket?.items.map((i) => i.name).join(','),
    );

    // -------------------------------------------------- editing after dispatch
    console.log('\n[a line cannot shrink below what is cooking]');
    order = orderOf((await call('GET', `/orders/${order.id}`, { token: cashier })).body);
    const coke2 = lineFor(order, 'Coke');
    r = await call('PATCH', `/orders/${order.id}/items/${coke2.id}`, {
      token: cashier,
      body: { expectedVersion: order.version, quantity: 1 },
    });
    check('2 ordered, 2 sent, reduce to 1 -> 409', r.status === 409, r.status);
    check('code QUANTITY_BELOW_DISPATCHED', errorCode(r.body) === 'QUANTITY_BELOW_DISPATCHED');
    check(
      'message says how many went',
      /2 of these have already gone/.test(JSON.stringify(r.body)),
    );
    check(
      'nothing changed',
      lineFor(orderOf((await call('GET', `/orders/${order.id}`, { token: cashier })).body), 'Coke')
        .quantity === 2,
    );

    console.log('\n[but an undispatched surplus may be taken back]');
    order = orderOf((await call('GET', `/orders/${order.id}`, { token: cashier })).body);
    r = await call('PATCH', `/orders/${order.id}/items/${lineFor(order, 'Coke').id}`, {
      token: cashier,
      body: { expectedVersion: order.version, quantity: 3 },
    });
    order = orderOf(r.body);
    check('raised to 3 (2 sent, 1 waiting)', lineFor(order, 'Coke').undispatchedQuantity === 1);
    r = await call('PATCH', `/orders/${order.id}/items/${lineFor(order, 'Coke').id}`, {
      token: cashier,
      body: { expectedVersion: order.version, quantity: 2 },
    });
    check('back down to the dispatched quantity -> 200', r.status === 200, r.status);
    order = orderOf(r.body);
    check('now 2 ordered, 2 sent, 0 waiting', lineFor(order, 'Coke').undispatchedQuantity === 0);

    console.log('\n[a dispatched line cannot be removed]');
    r = await call(
      'DELETE',
      `/orders/${order.id}/items/${lineFor(order, 'Coke').id}?expectedVersion=${String(order.version)}`,
      { token: cashier },
    );
    check('delete refused -> 409', r.status === 409, r.status);
    check('code ITEM_ALREADY_SENT', errorCode(r.body) === 'ITEM_ALREADY_SENT');
    check(
      'no raw constraint error leaked',
      !/FOREIGN KEY|constraint failed|PrismaClient/i.test(JSON.stringify(r.body)),
      JSON.stringify(r.body),
    );
    check(
      'the line survived',
      (await prisma.orderItem.count({ where: { id: lineFor(order, 'Coke').id } })) === 1,
    );

    console.log('\n[an undispatched line may still be removed]');
    order = orderOf((await call('GET', `/orders/${order.id}`, { token: cashier })).body);
    const fresh = orderOf(
      (
        await call('POST', '/orders/items', {
          token: cashier,
          body: {
            target: { kind: 'ORDER', orderId: order.id, expectedVersion: order.version },
            menuItemId: coke.id,
            note: 'to be removed',
          },
        })
      ).body,
    );
    const removable = fresh.items.find((i) => i.note === 'to be removed');
    r = await call(
      'DELETE',
      `/orders/${fresh.id}/items/${removable?.id ?? ''}?expectedVersion=${String(fresh.version)}`,
      { token: cashier },
    );
    check('undispatched delete -> 200', r.status === 200, r.status);

    // ------------------------------------------------------- concurrent send
    console.log('\n[two terminals press Send at the same instant]');
    const raceOrder = orderOf(
      (
        await call('POST', '/orders/items', {
          token: cashier,
          body: { target: { kind: 'TABLE', tableId: table7.id }, menuItemId: momo.id, quantity: 4 },
        })
      ).body,
    );
    const [a, b] = await Promise.all([
      call('POST', `/orders/${raceOrder.id}/send-kot`, {
        token: cashier,
        body: { expectedVersion: raceOrder.version },
      }),
      call('POST', `/orders/${raceOrder.id}/send-kot`, {
        token: owner,
        body: { expectedVersion: raceOrder.version },
      }),
    ]);
    const codes = [a.status, b.status].sort((x, y) => x - y);
    check('exactly one winner', codes[0] === 201 && codes[1] === 409, codes.join('/'));
    check(
      'the loser was told the order changed',
      errorCode(a.status === 409 ? a.body : b.body) === 'ORDER_CHANGED',
      errorCode(a.status === 409 ? a.body : b.body),
    );
    const raceKots = await prisma.kot.findMany({ where: { orderId: raceOrder.id } });
    check('exactly one ticket was cut', raceKots.length === 1, raceKots.length);
    const raceItems = await prisma.kotItem.findMany({ where: { kotId: raceKots[0]?.id } });
    check(
      'no duplicated quantities',
      raceItems.reduce((n, i) => n + i.quantity, 0) === 4,
      raceItems.reduce((n, i) => n + i.quantity, 0),
    );

    console.log('\n[KOT numbers are never duplicated under load]');
    const orders: OrderDto[] = [];
    for (let i = 0; i < 6; i++) {
      const t = await prisma.restaurantTable.create({
        data: { restaurantId: restaurant.id, areaId: area.id, name: `Race ${String(i)}` },
      });
      orders.push(
        orderOf(
          (
            await call('POST', '/orders/items', {
              token: cashier,
              body: { target: { kind: 'TABLE', tableId: t.id }, menuItemId: momo.id },
            })
          ).body,
        ),
      );
    }
    const sent = await Promise.all(
      orders.map((o) =>
        call('POST', `/orders/${o.id}/send-kot`, {
          token: cashier,
          body: { expectedVersion: o.version },
        }),
      ),
    );
    check(
      'all six sends succeeded',
      sent.every((x) => x.status === 201),
      sent.map((x) => x.status).join(','),
    );
    const allKots = await prisma.kot.findMany({ select: { kotNumber: true } });
    const numbers = allKots.map((k) => k.kotNumber);
    check(
      'every KOT number is unique',
      new Set(numbers).size === numbers.length,
      numbers.sort((x, y) => x - y).join(','),
    );

    // ------------------------------------------------------------ the board
    console.log('\n[kitchen board]');
    r = await call('GET', '/kitchen/tickets', { token: kitchen });
    check('GET /kitchen/tickets -> 200', r.status === 200, r.status);
    const board = (r.body as KitchenTicketsResponse).tickets;
    check(
      'oldest ticket first',
      board[0]?.kotNumber === 1,
      board.map((t) => t.kotNumber).join(','),
    );
    check(
      'every ticket is NEW in this phase',
      board.every((t) => t.status === 'NEW'),
    );
    check('no VOID tickets are listed', !board.some((t) => t.status === 'VOID'));
    check(
      'elapsed seconds present',
      board.every((t) => typeof t.elapsedSeconds === 'number'),
    );
    check('createdAt is an ISO string', /^\d{4}-\d{2}-\d{2}T/.test(board[0]?.createdAt ?? ''));

    console.log('\n[takeaway ticket]');
    const takeaway = orderOf(
      (
        await call('POST', '/orders/items', {
          token: cashier,
          body: { target: { kind: 'TAKEAWAY' }, menuItemId: momo.id, quantity: 2 },
        })
      ).body,
    );
    const takeawayKot = kotOf(
      (
        await call('POST', `/orders/${takeaway.id}/send-kot`, {
          token: cashier,
          body: { expectedVersion: takeaway.version },
        })
      ).body,
    );
    check('takeaway ticket has no table', takeawayKot.tableName === null);
    check('and says so through its type', takeawayKot.orderType === 'TAKEAWAY');

    console.log('\n[a paid order leaves the board]');
    const boardBefore = (
      (await call('GET', '/kitchen/tickets', { token: kitchen })).body as KitchenTicketsResponse
    ).tickets.length;
    await prisma.order.update({
      where: { id: takeaway.id },
      data: { status: 'PAID', closedAt: new Date() },
    });
    const boardAfter = (
      (await call('GET', '/kitchen/tickets', { token: kitchen })).body as KitchenTicketsResponse
    ).tickets;
    check(
      'closing the order removes its ticket',
      boardAfter.length === boardBefore - 1,
      `${String(boardBefore)} -> ${String(boardAfter.length)}`,
    );
    check('and it was the right one', !boardAfter.some((t) => t.orderId === takeaway.id));

    console.log('\n[a voided ticket leaves the board]');
    const voidTarget = boardAfter[boardAfter.length - 1];
    await prisma.kot.update({ where: { id: voidTarget?.id }, data: { status: 'VOID' } });
    const afterVoid = (
      (await call('GET', '/kitchen/tickets', { token: kitchen })).body as KitchenTicketsResponse
    ).tickets;
    check('voided ticket is not shown', !afterVoid.some((t) => t.id === voidTarget?.id));
    const voidedOrder = orderOf(
      (await call('GET', `/orders/${voidTarget?.orderId ?? ''}`, { token: cashier })).body,
    );
    check(
      'and its quantities return to undispatched',
      voidedOrder.items.every((i) => i.dispatchedQuantity === 0),
      voidedOrder.items.map((i) => i.dispatchedQuantity).join(','),
    );

    // ------------------------------------------------------------- isolation
    console.log('\n[restaurant isolation]');
    const other = await prisma.restaurant.create({
      data: { name: 'Other Restaurant', address: '', phone: '', panNumber: '' },
    });
    const otherArea = await prisma.restaurantArea.create({
      data: { restaurantId: other.id, name: 'Other Area' },
    });
    const otherTable = await prisma.restaurantTable.create({
      data: { restaurantId: other.id, areaId: otherArea.id, name: 'Other Table' },
    });
    const otherCat = await prisma.menuCategory.create({
      data: { restaurantId: other.id, name: 'Other Menu' },
    });
    const otherItem = await prisma.menuItem.create({
      data: {
        restaurantId: other.id,
        categoryId: otherCat.id,
        name: 'Other Dish',
        pricePaisa: 100,
      },
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
    const otherOrder = await prisma.order.create({
      data: {
        restaurantId: other.id,
        orderNumber: 1,
        type: 'DINE_IN',
        status: 'DRAFT',
        tableId: otherTable.id,
        openedByStaffId: otherStaff.id,
        businessDate: '2026-08-31',
        version: 1,
        items: {
          create: {
            menuItemId: otherItem.id,
            nameSnapshot: 'Other Dish',
            unitPricePaisa: 100,
            quantity: 1,
          },
        },
      },
    });
    r = await call('POST', `/orders/${otherOrder.id}/send-kot`, {
      token: cashier,
      body: { expectedVersion: 1 },
    });
    check("cannot send another restaurant's order -> 404", r.status === 404, r.status);
    check(
      'and no ticket was cut for it',
      (await prisma.kot.count({ where: { restaurantId: other.id } })) === 0,
    );
    const mine = (
      (await call('GET', '/kitchen/tickets', { token: cashier })).body as KitchenTicketsResponse
    ).tickets;
    check(
      "other restaurant's tickets are invisible",
      !mine.some((t) => t.orderId === otherOrder.id),
    );

    // --------------------------------------------------------- authorization
    console.log('\n[authorization]');
    check(
      'OWNER may read the board',
      (await call('GET', '/kitchen/tickets', { token: owner })).status === 200,
    );
    check(
      'CASHIER may read the board',
      (await call('GET', '/kitchen/tickets', { token: cashier })).status === 200,
    );
    check(
      'KITCHEN may read the board',
      (await call('GET', '/kitchen/tickets', { token: kitchen })).status === 200,
    );
    check('unauthenticated -> 401', (await call('GET', '/kitchen/tickets')).status === 401);
    order = orderOf((await call('GET', `/orders/${order.id}`, { token: cashier })).body);
    r = await call('POST', `/orders/${order.id}/send-kot`, {
      token: kitchen,
      body: { expectedVersion: order.version },
    });
    check('KITCHEN cannot send to the kitchen -> 403', r.status === 403, r.status);

    console.log('\n[stale send]');
    r = await call('POST', `/orders/${order.id}/send-kot`, {
      token: cashier,
      body: { expectedVersion: order.version - 1 },
    });
    check(
      'stale version -> 409 ORDER_CHANGED',
      r.status === 409 && errorCode(r.body) === 'ORDER_CHANGED',
      errorCode(r.body),
    );

    // =======================================================================
    // Phase 4E - the status workflow
    // =======================================================================
    console.log('\n[workflow] a ticket walks NEW -> PREPARING -> READY -> SERVED');
    // A fresh table: table7 is still carrying the order the race test left on it.
    const flowTable = await prisma.restaurantTable.create({
      data: { restaurantId: restaurant.id, areaId: area.id, name: 'Flow B' },
    });
    const flowOrder = orderOf(
      (
        await call('POST', '/orders/items', {
          token: cashier,
          body: {
            target: { kind: 'TABLE', tableId: flowTable.id },
            menuItemId: momo.id,
            quantity: 2,
          },
        })
      ).body,
    );
    const flowKot = kotOf(
      (
        await call('POST', `/orders/${flowOrder.id}/send-kot`, {
          token: cashier,
          body: { expectedVersion: flowOrder.version },
        })
      ).body,
    );
    check('starts NEW', flowKot.status === 'NEW');
    check(
      'no timestamps yet',
      flowKot.startedAt === null && flowKot.readyAt === null && flowKot.servedAt === null,
    );
    const createdAt = flowKot.createdAt;

    const move = (kotId: string, status: string, token: string): Promise<Res> =>
      call('PATCH', `/kitchen/tickets/${kotId}/status`, { token, body: { status } });
    const ticketOf = (body: unknown): KitchenTicket => (body as { ticket: KitchenTicket }).ticket;

    r = await move(flowKot.id, 'PREPARING', kitchen);
    check('NEW -> PREPARING -> 200', r.status === 200, r.status);
    let t = ticketOf(r.body);
    check('status is PREPARING', t.status === 'PREPARING');
    check('startedAt was written', t.startedAt !== null);
    check('readyAt is still empty', t.readyAt === null);
    check('createdAt was NOT touched', t.createdAt === createdAt);
    const startedAt = t.startedAt;

    r = await move(flowKot.id, 'READY', kitchen);
    check('PREPARING -> READY -> 200', r.status === 200, r.status);
    t = ticketOf(r.body);
    check('status is READY', t.status === 'READY');
    check('readyAt was written', t.readyAt !== null);
    check('startedAt unchanged', t.startedAt === startedAt);
    check('createdAt still unchanged', t.createdAt === createdAt);
    const readyAt = t.readyAt;

    r = await move(flowKot.id, 'SERVED', kitchen);
    check('READY -> SERVED -> 200', r.status === 200, r.status);
    t = ticketOf(r.body);
    check('status is SERVED', t.status === 'SERVED');
    check('servedAt was written', t.servedAt !== null);
    check('startedAt still unchanged', t.startedAt === startedAt);
    check('readyAt still unchanged', t.readyAt === readyAt);
    check('createdAt still unchanged', t.createdAt === createdAt);
    check(
      'the timer still counts from creation, not from the last move',
      t.elapsedSeconds >= 0 &&
        new Date(t.createdAt).getTime() < new Date(t.servedAt ?? '').getTime(),
    );

    console.log('\n[workflow] SERVED is terminal');
    for (const target of ['PREPARING', 'READY', 'SERVED'] as const) {
      r = await move(flowKot.id, target, kitchen);
      check(
        `SERVED -> ${target} refused`,
        r.status === 409,
        `${String(r.status)} ${String(errorCode(r.body))}`,
      );
    }

    console.log('\n[workflow] skips and reversals are refused');
    const freshKot = async (tableName: string): Promise<KitchenTicket> => {
      const tbl = await prisma.restaurantTable.create({
        data: { restaurantId: restaurant.id, areaId: area.id, name: tableName },
      });
      const o = orderOf(
        (
          await call('POST', '/orders/items', {
            token: cashier,
            body: { target: { kind: 'TABLE', tableId: tbl.id }, menuItemId: momo.id },
          })
        ).body,
      );
      return kotOf(
        (
          await call('POST', `/orders/${o.id}/send-kot`, {
            token: cashier,
            body: { expectedVersion: o.version },
          })
        ).body,
      );
    };

    const skipA = await freshKot('Skip A');
    r = await move(skipA.id, 'READY', kitchen);
    check('NEW -> READY refused', r.status === 409, r.status);
    check('code INVALID_KOT_TRANSITION', errorCode(r.body) === 'INVALID_KOT_TRANSITION');
    check(
      'message is kitchen language, not enum names',
      /still waiting/.test(JSON.stringify(r.body)) && !/NEW|PREPARING/.test(JSON.stringify(r.body)),
      JSON.stringify(r.body),
    );
    r = await move(skipA.id, 'SERVED', kitchen);
    check(
      'NEW -> SERVED refused',
      r.status === 409 && errorCode(r.body) === 'INVALID_KOT_TRANSITION',
    );
    check(
      'the ticket is untouched',
      (await prisma.kot.findFirstOrThrow({ where: { id: skipA.id } })).status === 'NEW',
    );
    check(
      'and no timestamp was written',
      (await prisma.kot.findFirstOrThrow({ where: { id: skipA.id } })).startedAt === null,
    );

    const skipB = await freshKot('Skip B');
    await move(skipB.id, 'PREPARING', kitchen);
    r = await move(skipB.id, 'SERVED', kitchen);
    check(
      'PREPARING -> SERVED refused',
      r.status === 409 && errorCode(r.body) === 'INVALID_KOT_TRANSITION',
    );

    const backB = await freshKot('Back B');
    await move(backB.id, 'PREPARING', kitchen);
    await move(backB.id, 'READY', kitchen);
    r = await move(backB.id, 'PREPARING', kitchen);
    check('READY -> PREPARING refused (no going back)', r.status === 409, r.status);
    check('code INVALID_KOT_TRANSITION', errorCode(r.body) === 'INVALID_KOT_TRANSITION');

    console.log('\n[workflow] a VOID ticket is out of the workflow');
    const voidKot = await freshKot('Void B');
    await prisma.kot.update({ where: { id: voidKot.id }, data: { status: 'VOID' } });
    r = await move(voidKot.id, 'PREPARING', kitchen);
    check('VOID cannot be transitioned', r.status === 409, r.status);
    check('code KOT_VOIDED', errorCode(r.body) === 'KOT_VOIDED');

    console.log('\n[workflow] the schema refuses NEW and VOID as targets');
    const targetKot = await freshKot('Target B');
    for (const bad of ['NEW', 'VOID', 'COOKED', '']) {
      r = await move(targetKot.id, bad, kitchen);
      check(`"${bad}" is not a target -> 400`, r.status === 400, r.status);
    }

    console.log('\n[workflow] two cooks double-tap the same button');
    const raceKot = await freshKot('Race B');
    await move(raceKot.id, 'PREPARING', kitchen);
    const [x, y] = await Promise.all([
      move(raceKot.id, 'READY', kitchen),
      move(raceKot.id, 'READY', owner),
    ]);
    const results = [x.status, y.status].sort((p, q) => p - q);
    check('exactly one wins', results[0] === 200 && results[1] === 409, results.join('/'));
    check(
      'the loser is told the board moved',
      errorCode(x.status === 409 ? x.body : y.body) === 'KOT_CHANGED',
      errorCode(x.status === 409 ? x.body : y.body),
    );
    const raced = await prisma.kot.findFirstOrThrow({ where: { id: raceKot.id } });
    check('status is READY exactly once', raced.status === 'READY');
    const winner = ticketOf(x.status === 200 ? x.body : y.body);
    check(
      'readyAt is the moment it actually happened, not the duplicate click',
      raced.readyAt?.toISOString() === winner.readyAt,
      `${String(raced.readyAt?.toISOString())} vs ${String(winner.readyAt)}`,
    );

    console.log('\n[workflow] sequential duplicate cannot rewrite the timestamp');
    const firstReadyAt = raced.readyAt?.toISOString();
    await new Promise((res) => setTimeout(res, 50));
    r = await move(raceKot.id, 'READY', kitchen);
    check('the repeat is refused', r.status === 409 && errorCode(r.body) === 'KOT_CHANGED');
    check(
      'readyAt was not moved forward',
      (await prisma.kot.findFirstOrThrow({ where: { id: raceKot.id } })).readyAt?.toISOString() ===
        firstReadyAt,
    );

    console.log('\n[workflow] realtime');
    const updates: { kotId: string; status: string }[] = [];
    socket.on(REALTIME_EVENTS.kotUpdated, (payload: { kotId: string; status: string }) => {
      updates.push(payload);
    });
    const rtKot = await freshKot('Realtime B');
    await move(rtKot.id, 'PREPARING', kitchen);
    await new Promise((res) => setTimeout(res, 300));
    check('the other client received kot:updated', updates.length === 1, updates.length);
    check('with the new status', updates[0]?.status === 'PREPARING', updates[0]?.status);
    check('and the ticket id', updates[0]?.kotId === rtKot.id);

    console.log('\n[authorization] who may move a ticket');
    const roleKot = await freshKot('Role B');
    r = await move(roleKot.id, 'PREPARING', cashier);
    check('CASHIER cannot transition -> 403', r.status === 403, r.status);
    check(
      'and the ticket did not move',
      (await prisma.kot.findFirstOrThrow({ where: { id: roleKot.id } })).status === 'NEW',
    );
    check('KITCHEN can', (await move(roleKot.id, 'PREPARING', kitchen)).status === 200);
    check('OWNER can', (await move(roleKot.id, 'READY', owner)).status === 200);
    const manager = await prisma.staff.create({
      data: {
        restaurantId: restaurant.id,
        name: 'Sunita Karki',
        username: 'sunita.k',
        passwordHash: await hashPassword('staff1234'),
        role: 'MANAGER',
      },
    });
    void manager;
    const managerToken = await tokenFor('sunita.k', 'staff1234');
    check('MANAGER can', (await move(roleKot.id, 'SERVED', managerToken)).status === 200);
    check(
      'unauthenticated -> 401',
      (await call('PATCH', `/kitchen/tickets/${roleKot.id}/status`, { body: { status: 'READY' } }))
        .status === 401,
    );

    console.log("\n[isolation] another restaurant's ticket");
    // Its own table: otherTable already carries the order the 4D isolation
    // section left there, and the partial unique index rightly refuses a second.
    const otherTable2 = await prisma.restaurantTable.create({
      data: { restaurantId: other.id, areaId: otherArea.id, name: 'Other Table 2' },
    });
    const otherOrder2 = await prisma.order.create({
      data: {
        restaurantId: other.id,
        orderNumber: 99,
        type: 'DINE_IN',
        status: 'OPEN',
        tableId: otherTable2.id,
        openedByStaffId: otherStaff.id,
        businessDate: '2026-08-31',
        version: 1,
      },
    });
    const otherKot = await prisma.kot.create({
      data: {
        restaurantId: other.id,
        orderId: otherOrder2.id,
        kotNumber: 1,
        status: 'NEW',
        createdByStaffId: otherStaff.id,
      },
    });
    r = await move(otherKot.id, 'PREPARING', kitchen);
    check("cannot move another restaurant's ticket -> 404", r.status === 404, r.status);
    check('code KOT_NOT_FOUND (existence not revealed)', errorCode(r.body) === 'KOT_NOT_FOUND');
    check(
      'it did not move',
      (await prisma.kot.findFirstOrThrow({ where: { id: otherKot.id } })).status === 'NEW',
    );
    r = await move('does-not-exist', 'PREPARING', kitchen);
    check(
      'an unknown id answers identically',
      r.status === 404 && errorCode(r.body) === 'KOT_NOT_FOUND',
    );

    console.log('\n[floor] a single ticket drives the table colour');
    const floorTable = await prisma.restaurantTable.create({
      data: { restaurantId: restaurant.id, areaId: area.id, name: 'Floor B' },
    });
    const floorOrder = orderOf(
      (
        await call('POST', '/orders/items', {
          token: cashier,
          body: { target: { kind: 'TABLE', tableId: floorTable.id }, menuItemId: momo.id },
        })
      ).body,
    );
    const tableStatus = async (): Promise<string | undefined> =>
      statusOf((await call('GET', '/floor', { token: cashier })).body, 'Floor B');
    check(
      'OCCUPIED before anything is sent',
      (await tableStatus()) === 'OCCUPIED',
      await tableStatus(),
    );

    const floorKot = kotOf(
      (
        await call('POST', `/orders/${floorOrder.id}/send-kot`, {
          token: cashier,
          body: { expectedVersion: floorOrder.version },
        })
      ).body,
    );
    check('NEW ticket -> PREPARING', (await tableStatus()) === 'PREPARING', await tableStatus());
    await move(floorKot.id, 'PREPARING', kitchen);
    check(
      'PREPARING ticket -> still PREPARING',
      (await tableStatus()) === 'PREPARING',
      await tableStatus(),
    );
    await move(floorKot.id, 'READY', kitchen);
    check('READY ticket -> READY', (await tableStatus()) === 'READY', await tableStatus());
    await move(floorKot.id, 'SERVED', kitchen);
    check(
      'SERVED ticket -> back to OCCUPIED, NOT available',
      (await tableStatus()) === 'OCCUPIED',
      await tableStatus(),
    );
    check(
      'the order is still OPEN - serving is not settling',
      (await prisma.order.findFirstOrThrow({ where: { id: floorOrder.id } })).status === 'OPEN',
    );
    check(
      'and the order is not closed',
      (await prisma.order.findFirstOrThrow({ where: { id: floorOrder.id } })).closedAt === null,
    );

    console.log('\n[floor] precedence across several tickets on one order');
    // Second ticket on the same table, so the order carries two at once.
    let floorNow = orderOf(
      (await call('GET', `/orders/${floorOrder.id}`, { token: cashier })).body,
    );
    floorNow = orderOf(
      (
        await call('POST', '/orders/items', {
          token: cashier,
          body: {
            target: { kind: 'ORDER', orderId: floorOrder.id, expectedVersion: floorNow.version },
            menuItemId: coke.id,
          },
        })
      ).body,
    );
    const secondKot = kotOf(
      (
        await call('POST', `/orders/${floorOrder.id}/send-kot`, {
          token: cashier,
          body: { expectedVersion: floorNow.version },
        })
      ).body,
    );
    check('SERVED + NEW -> PREPARING', (await tableStatus()) === 'PREPARING', await tableStatus());
    await move(secondKot.id, 'PREPARING', kitchen);
    check(
      'SERVED + PREPARING -> PREPARING',
      (await tableStatus()) === 'PREPARING',
      await tableStatus(),
    );
    await move(secondKot.id, 'READY', kitchen);
    check('SERVED + READY -> READY', (await tableStatus()) === 'READY', await tableStatus());

    // A third ticket, so PREPARING and READY are live at the same time.
    floorNow = orderOf((await call('GET', `/orders/${floorOrder.id}`, { token: cashier })).body);
    floorNow = orderOf(
      (
        await call('POST', '/orders/items', {
          token: cashier,
          body: {
            target: { kind: 'ORDER', orderId: floorOrder.id, expectedVersion: floorNow.version },
            menuItemId: momo.id,
            note: 'third ticket',
          },
        })
      ).body,
    );
    const thirdKot = kotOf(
      (
        await call('POST', `/orders/${floorOrder.id}/send-kot`, {
          token: cashier,
          body: { expectedVersion: floorNow.version },
        })
      ).body,
    );
    await move(thirdKot.id, 'PREPARING', kitchen);
    check(
      'PREPARING + READY -> READY (food going cold wins)',
      (await tableStatus()) === 'READY',
      await tableStatus(),
    );
    await move(secondKot.id, 'SERVED', kitchen);
    check(
      'PREPARING + SERVED -> PREPARING',
      (await tableStatus()) === 'PREPARING',
      await tableStatus(),
    );
    await move(thirdKot.id, 'READY', kitchen);
    check('READY + SERVED -> READY', (await tableStatus()) === 'READY', await tableStatus());
    await move(thirdKot.id, 'SERVED', kitchen);
    check('all SERVED -> OCCUPIED', (await tableStatus()) === 'OCCUPIED', await tableStatus());

    console.log('\n[board] a served ticket stays until the order closes');
    const live = (
      (await call('GET', '/kitchen/tickets', { token: kitchen })).body as KitchenTicketsResponse
    ).tickets;
    check(
      'served tickets are still on the board',
      live.some((x) => x.status === 'SERVED'),
    );
    check(
      'ordering is still oldest-first, not reshuffled by status',
      live.every((x, i) => i === 0 || new Date(live[i - 1]!.createdAt) <= new Date(x.createdAt)),
      live.map((x) => x.kotNumber).join(','),
    );

    console.log('\n[POS] the order carries a compact kitchen summary');
    const summarised = orderOf(
      (await call('GET', `/orders/${floorOrder.id}`, { token: cashier })).body,
    );
    check(
      'three tickets counted',
      summarised.kitchen.ticketCount === 3,
      summarised.kitchen.ticketCount,
    );
    check(
      'all three are served',
      summarised.kitchen.servedCount === 3,
      summarised.kitchen.servedCount,
    );
    check(
      'nothing preparing or ready',
      summarised.kitchen.preparingCount === 0 && summarised.kitchen.readyCount === 0,
    );
    const mixed = orderOf((await call('GET', `/orders/${flowOrder.id}`, { token: cashier })).body);
    check('another order reports its own counts', mixed.kitchen.ticketCount === 1);

    console.log('\n[closed order] tickets can no longer be moved');
    const closedKot = await freshKot('Closed B');
    const closedOrderId = closedKot.orderId;
    await prisma.order.update({
      where: { id: closedOrderId },
      data: { status: 'PAID', closedAt: new Date() },
    });
    r = await move(closedKot.id, 'PREPARING', kitchen);
    check('a closed order refuses transitions', r.status === 409, r.status);
    check('code ORDER_CLOSED', errorCode(r.body) === 'ORDER_CLOSED');
    check(
      'no SQL or Prisma detail in any of it',
      !/constraint|PrismaClient|P20\d\d|SQLITE_/i.test(JSON.stringify(r.body)),
    );

    socket.disconnect();
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
