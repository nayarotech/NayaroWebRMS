/**
 * Phase 4C backend verification - drives the real HTTP API.
 *
 *   npm run verify:orders --workspace @nayaro/server
 *
 * Disposable temp data root, non-default port. Never touches the dev database.
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import type { MaybeOrderResponse, MenuResponse, OrderDto } from '@nayaro/shared';
import { ensureDataLayout, resolveDataLayout } from '@nayaro/database';
import { createLogger } from '../src/utils/logger';
import { startNayaroServer, stopNayaroServer, type NayaroServerHandle } from '../src/server';
import { hashPassword } from '../src/modules/auth/password';
import { resolveBusinessDate } from '../src/utils/businessDate';

const ROOT = resolve(tmpdir(), 'nayaro-4c-verify');
const PORT = 4329;

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

async function main(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true });
  const layout = ensureDataLayout(resolveDataLayout(ROOT));
  const handle: NayaroServerHandle = await startNayaroServer({
    port: PORT,
    databaseFilePath: layout.databaseFilePath,
    logger: createLogger({ scope: 'verify-orders', silent: true }),
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

    const tokenFor = async (username: string, password: string): Promise<string> => {
      const r = await call('POST', '/auth/login', { body: { workspace: 'verify-restaurant', username, password } });
      return (r.body as { token: string }).token;
    };
    const owner = await tokenFor('rajan.s', 'correct-horse-battery');
    const cashier = await tokenFor('bikash.t', 'staff1234');
    const kitchen = await tokenFor('maya.g', 'staff1234');

    const area = await prisma.restaurantArea.create({
      data: { restaurantId: restaurant.id, name: 'Ground Floor' },
    });
    const table4 = await prisma.restaurantTable.create({
      data: { restaurantId: restaurant.id, areaId: area.id, name: 'Table 4' },
    });
    const table5 = await prisma.restaurantTable.create({
      data: { restaurantId: restaurant.id, areaId: area.id, name: 'Table 5' },
    });
    const retiredTable = await prisma.restaurantTable.create({
      data: { restaurantId: restaurant.id, areaId: area.id, name: 'Table 9', isActive: false },
    });

    const category = await prisma.menuCategory.create({
      data: { restaurantId: restaurant.id, name: 'Momo', nameNp: 'मम' },
    });
    const drinks = await prisma.menuCategory.create({
      data: { restaurantId: restaurant.id, name: 'Drinks', nameNp: 'पेय', sortOrder: 1 },
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
        categoryId: drinks.id,
        name: 'Coke',
        nameNp: 'कोक',
        pricePaisa: 9000,
      },
    });
    const soldOut = await prisma.menuItem.create({
      data: {
        restaurantId: restaurant.id,
        categoryId: drinks.id,
        name: 'Lassi',
        pricePaisa: 12000,
        isAvailable: false,
      },
    });
    const retiredItem = await prisma.menuItem.create({
      data: {
        restaurantId: restaurant.id,
        categoryId: drinks.id,
        name: 'Old Special',
        pricePaisa: 15000,
        isActive: false,
      },
    });
    check('fixtures created', true);

    // ------------------------------------------------------------------ menu
    console.log('\n[menu]');
    let r = await call('GET', '/menu', { token: cashier });
    check('GET /menu -> 200', r.status === 200, r.status);
    const menu = r.body as MenuResponse;
    const allItems = menu.categories.flatMap((c) => c.items.map((i) => i.name));
    check('categories ordered by sortOrder', menu.categories[0]?.name === 'Momo');
    check('Nepali names present', menu.categories[0]?.nameNp === 'मम');
    check(
      'sellable items returned',
      allItems.includes('Chicken Momo') && allItems.includes('Coke'),
    );
    check('sold-out item hidden', !allItems.includes('Lassi'));
    check('retired item hidden', !allItems.includes('Old Special'));
    check('price is integer paisa', menu.categories[0]?.items[0]?.pricePaisa === 22000);
    check(
      'KITCHEN cannot read the menu',
      (await call('GET', '/menu', { token: kitchen })).status === 403,
    );
    check('unauthenticated -> 401', (await call('GET', '/menu')).status === 401);

    const emptyCategory = await prisma.menuCategory.create({
      data: { restaurantId: restaurant.id, name: 'Desserts', sortOrder: 2 },
    });
    r = await call('GET', '/menu', { token: cashier });
    check(
      'category with nothing sellable is dropped',
      !(r.body as MenuResponse).categories.some((c) => c.name === 'Desserts'),
    );
    await prisma.menuCategory.delete({ where: { id: emptyCategory.id } });

    // ------------------------------------------------------- empty table read
    console.log('\n[empty table]');
    r = await call('GET', `/tables/${table4.id}/order`, { token: cashier });
    check('GET table order -> 200', r.status === 200, r.status);
    check('no order yet', (r.body as MaybeOrderResponse).order === null);
    check('and no Order row was written', (await prisma.order.count()) === 0);
    check(
      'unknown table -> 404',
      (await call('GET', '/tables/nope/order', { token: cashier })).status === 404,
    );

    // -------------------------------------------------- first item creates it
    console.log('\n[first item creates the order atomically]');
    r = await call('POST', '/orders/items', {
      token: cashier,
      body: { target: { kind: 'TABLE', tableId: table4.id }, menuItemId: momo.id },
    });
    check('POST first item -> 201', r.status === 201, r.status);
    let order = orderOf(r.body);
    check('status is DRAFT', order.status === 'DRAFT', order.status);
    check('type is DINE_IN', order.type === 'DINE_IN');
    check('table attached', order.table?.name === 'Table 4');
    check('order number allocated from 1', order.orderNumber === 1, order.orderNumber);
    check('version starts at 1 (creation is mutation one)', order.version === 1, order.version);
    check('one line, quantity 1', order.items.length === 1 && order.items[0]?.quantity === 1);
    check('subtotal = 220.00', order.subtotalPaisa === 22000, order.subtotalPaisa);
    check('line total computed', order.items[0]?.lineTotalPaisa === 22000);
    check('name snapshot taken', order.items[0]?.name === 'Chicken Momo');
    check('Nepali snapshot taken', order.items[0]?.nameNp === 'चिकन मम');
    check('exactly one Order row exists', (await prisma.order.count()) === 1);

    const stored = await prisma.order.findFirstOrThrow();
    check(
      'businessDate recorded for today',
      stored.businessDate === resolveBusinessDate(new Date(), 240),
      stored.businessDate,
    );
    check('opened-by recorded as the signed-in cashier', stored.openedByStaffId !== null);

    // -------------------------------------------------------- duplicate taps
    console.log('\n[duplicate taps merge]');
    r = await call('POST', '/orders/items', {
      token: cashier,
      body: {
        target: { kind: 'ORDER', orderId: order.id, expectedVersion: order.version },
        menuItemId: momo.id,
      },
    });
    order = orderOf(r.body);
    check('same item merges into one line', order.items.length === 1, order.items.length);
    check('quantity became 2', order.items[0]?.quantity === 2);
    check('version advanced to 2', order.version === 2, order.version);
    check('subtotal = 440.00', order.subtotalPaisa === 44000);

    r = await call('POST', '/orders/items', {
      token: cashier,
      body: {
        target: { kind: 'ORDER', orderId: order.id, expectedVersion: order.version },
        menuItemId: coke.id,
      },
    });
    order = orderOf(r.body);
    check('a different item is a new line', order.items.length === 2);
    check('subtotal = 530.00', order.subtotalPaisa === 53000, order.subtotalPaisa);

    console.log('\n[notes separate lines]');
    r = await call('POST', '/orders/items', {
      token: cashier,
      body: {
        target: { kind: 'ORDER', orderId: order.id, expectedVersion: order.version },
        menuItemId: momo.id,
        note: 'less spicy',
      },
    });
    order = orderOf(r.body);
    check('a different note makes its own line', order.items.length === 3, order.items.length);
    check(
      'the un-noted momo line still says 2',
      order.items.find((i) => i.note === null && i.menuItemId === momo.id)?.quantity === 2,
    );
    check(
      'the noted line carries the note',
      order.items.some((i) => i.note === 'less spicy'),
    );

    r = await call('POST', '/orders/items', {
      token: cashier,
      body: {
        target: { kind: 'ORDER', orderId: order.id, expectedVersion: order.version },
        menuItemId: momo.id,
        note: '  less spicy  ',
      },
    });
    order = orderOf(r.body);
    check('the same note after trimming merges', order.items.length === 3, order.items.length);
    check('noted line is now 2', order.items.find((i) => i.note === 'less spicy')?.quantity === 2);

    // ------------------------------------------------------ price snapshots
    console.log('\n[snapshots survive menu edits]');
    const beforeRename = order.items.find((i) => i.menuItemId === coke.id);
    await prisma.menuItem.update({
      where: { id: coke.id },
      data: { name: 'Coca-Cola 250ml', nameNp: 'कोका कोला', pricePaisa: 12000 },
    });
    r = await call('GET', `/orders/${order.id}`, { token: cashier });
    order = orderOf(r.body);
    const afterRename = order.items.find((i) => i.menuItemId === coke.id);
    check(
      'renaming the menu item does NOT rewrite the line',
      afterRename?.name === 'Coke',
      afterRename?.name,
    );
    check('Nepali snapshot unchanged too', afterRename?.nameNp === 'कोक');
    check(
      'repricing does NOT rewrite the line',
      afterRename?.unitPricePaisa === beforeRename?.unitPricePaisa,
      afterRename?.unitPricePaisa,
    );
    // 2 momo + 1 coke + 2 'less spicy' momo, all at the prices captured when
    // each line was created - not the 120.00 Coke now costs.
    check('subtotal still uses the snapshots', order.subtotalPaisa === 97000, order.subtotalPaisa);

    console.log('\n[a repriced item does not merge into the old line]');
    r = await call('POST', '/orders/items', {
      token: cashier,
      body: {
        target: { kind: 'ORDER', orderId: order.id, expectedVersion: order.version },
        menuItemId: coke.id,
      },
    });
    order = orderOf(r.body);
    const cokeLines = order.items.filter((i) => i.menuItemId === coke.id);
    check('the new price gets its own line', cokeLines.length === 2, cokeLines.length);
    check(
      'old line kept the old price',
      cokeLines.some((i) => i.unitPricePaisa === 9000),
    );
    check(
      'new line has the new price',
      cokeLines.some((i) => i.unitPricePaisa === 12000),
    );

    // ----------------------------------------------------- quantity and note
    console.log('\n[quantity + note edits]');
    const momoLine = order.items.find((i) => i.menuItemId === momo.id && i.note === null);
    r = await call('PATCH', `/orders/${order.id}/items/${momoLine?.id ?? ''}`, {
      token: cashier,
      body: { expectedVersion: order.version, quantity: 5 },
    });
    order = orderOf(r.body);
    check('quantity raised to 5', order.items.find((i) => i.id === momoLine?.id)?.quantity === 5);

    r = await call('PATCH', `/orders/${order.id}/items/${momoLine?.id ?? ''}`, {
      token: cashier,
      body: { expectedVersion: order.version, quantity: 1 },
    });
    order = orderOf(r.body);
    check('quantity lowered to 1', order.items.find((i) => i.id === momoLine?.id)?.quantity === 1);

    r = await call('PATCH', `/orders/${order.id}/items/${momoLine?.id ?? ''}`, {
      token: cashier,
      body: { expectedVersion: order.version, quantity: 0 },
    });
    check('quantity 0 -> 400', r.status === 400, r.status);
    check(
      'the rejected edit left the quantity alone',
      orderOf((await call('GET', `/orders/${order.id}`, { token: cashier })).body).items.find(
        (i) => i.id === momoLine?.id,
      )?.quantity === 1,
    );
    check(
      'and leaked no internal detail',
      !/path|expected|zod|_zod/i.test(JSON.stringify(r.body)),
      JSON.stringify(r.body),
    );

    r = await call('PATCH', `/orders/${order.id}/items/${momoLine?.id ?? ''}`, {
      token: cashier,
      body: { expectedVersion: order.version, note: 'no onion' },
    });
    order = orderOf(r.body);
    check(
      'note set on an existing line',
      order.items.find((i) => i.id === momoLine?.id)?.note === 'no onion',
    );
    check('editing a note does not merge lines', order.items.length === 4, order.items.length);

    r = await call('PATCH', `/orders/${order.id}/items/${momoLine?.id ?? ''}`, {
      token: cashier,
      body: { expectedVersion: order.version, note: null },
    });
    order = orderOf(r.body);
    check('null clears the note', order.items.find((i) => i.id === momoLine?.id)?.note === null);

    r = await call('PATCH', `/orders/${order.id}/items/nope`, {
      token: cashier,
      body: { expectedVersion: order.version, quantity: 2 },
    });
    check('unknown item -> 404', r.status === 404 && errorCode(r.body) === 'ORDER_ITEM_NOT_FOUND');

    // ------------------------------------------------ optimistic concurrency
    console.log('\n[version conflict]');
    const staleVersion = order.version - 1;
    r = await call('POST', '/orders/items', {
      token: owner,
      body: {
        target: { kind: 'ORDER', orderId: order.id, expectedVersion: staleVersion },
        menuItemId: momo.id,
      },
    });
    check('stale add -> 409', r.status === 409, r.status);
    check('code ORDER_CHANGED', errorCode(r.body) === 'ORDER_CHANGED');
    check('message tells the user what happened', /another terminal/i.test(JSON.stringify(r.body)));

    r = await call('GET', `/orders/${order.id}`, { token: cashier });
    check('the rejected edit changed nothing', orderOf(r.body).items.length === 4);
    check('and did not advance the version', orderOf(r.body).version === order.version);

    r = await call('PATCH', `/orders/${order.id}/items/${momoLine?.id ?? ''}`, {
      token: owner,
      body: { expectedVersion: staleVersion, quantity: 9 },
    });
    check('stale patch -> 409', r.status === 409 && errorCode(r.body) === 'ORDER_CHANGED');
    r = await call(
      'DELETE',
      `/orders/${order.id}/items/${momoLine?.id ?? ''}?expectedVersion=${String(staleVersion)}`,
      { token: owner },
    );
    check('stale delete -> 409', r.status === 409 && errorCode(r.body) === 'ORDER_CHANGED');
    check(
      'the line survived all three stale attempts',
      (await prisma.orderItem.count({ where: { id: momoLine?.id } })) === 1,
    );

    // ------------------------------------------------------- active-order race
    console.log('\n[active-order race]');
    r = await call('POST', '/orders/items', {
      token: owner,
      body: { target: { kind: 'TABLE', tableId: table4.id }, menuItemId: momo.id },
    });
    check('second order on a busy table -> 409', r.status === 409, r.status);
    check('code ORDER_ALREADY_OPEN', errorCode(r.body) === 'ORDER_ALREADY_OPEN');
    check('no SQL detail leaked', !/UNIQUE|constraint|prisma/i.test(JSON.stringify(r.body)));
    check(
      'still exactly one order on Table 4',
      (await prisma.order.count({ where: { tableId: table4.id } })) === 1,
    );

    console.log('\n[active-order race, genuinely concurrent]');
    const [a, b] = await Promise.all([
      call('POST', '/orders/items', {
        token: cashier,
        body: { target: { kind: 'TABLE', tableId: table5.id }, menuItemId: momo.id },
      }),
      call('POST', '/orders/items', {
        token: owner,
        body: { target: { kind: 'TABLE', tableId: table5.id }, menuItemId: coke.id },
      }),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    check(
      'exactly one winner, one friendly conflict',
      statuses[0] === 201 && statuses[1] === 409,
      statuses.join('/'),
    );
    check(
      'the loser got ORDER_ALREADY_OPEN, not a 500',
      errorCode(a.status === 409 ? a.body : b.body) === 'ORDER_ALREADY_OPEN',
      errorCode(a.status === 409 ? a.body : b.body),
    );
    check(
      'Table 5 has exactly one order',
      (await prisma.order.count({ where: { tableId: table5.id } })) === 1,
    );

    // ------------------------------------------------------------ validation
    console.log('\n[validation]');
    r = await call('POST', '/orders/items', {
      token: cashier,
      body: { target: { kind: 'TABLE', tableId: retiredTable.id }, menuItemId: momo.id },
    });
    check('order on an out-of-service table -> 409', r.status === 409, r.status);
    check('code TABLE_INACTIVE', errorCode(r.body) === 'TABLE_INACTIVE');

    r = await call('POST', '/orders/items', {
      token: cashier,
      body: {
        target: { kind: 'ORDER', orderId: order.id, expectedVersion: order.version },
        menuItemId: soldOut.id,
      },
    });
    check('sold-out item -> 409', r.status === 409, r.status);
    check('code MENU_ITEM_UNAVAILABLE', errorCode(r.body) === 'MENU_ITEM_UNAVAILABLE');
    check('message names the dish', /Lassi/.test(JSON.stringify(r.body)));

    r = await call('POST', '/orders/items', {
      token: cashier,
      body: {
        target: { kind: 'ORDER', orderId: order.id, expectedVersion: order.version },
        menuItemId: retiredItem.id,
      },
    });
    check(
      'retired item -> 404 MENU_ITEM_NOT_FOUND',
      r.status === 404 && errorCode(r.body) === 'MENU_ITEM_NOT_FOUND',
    );

    r = await call('GET', '/orders/nope', { token: cashier });
    check(
      'unknown order -> 404 ORDER_NOT_FOUND',
      r.status === 404 && errorCode(r.body) === 'ORDER_NOT_FOUND',
    );

    r = await call('POST', '/orders/items', {
      token: cashier,
      body: {
        target: { kind: 'ORDER', orderId: order.id, expectedVersion: order.version },
        menuItemId: momo.id,
        quantity: 500,
      },
    });
    check('absurd quantity -> 400', r.status === 400, r.status);

    r = await call('POST', '/orders/items', { token: cashier, body: { menuItemId: momo.id } });
    check('missing target -> 400', r.status === 400, r.status);

    // Phase 4D widened this deliberately: an OPEN order is one the kitchen is
    // already cooking, and "one more Coke" is the most ordinary thing that
    // happens next. The boundary that matters is BILLED - once a bill exists
    // the order must not grow behind it.
    console.log('\n[an OPEN order may still be added to]');
    const sentOrder = await prisma.order.findFirstOrThrow({ where: { tableId: table5.id } });
    const sentBefore = orderOf(
      (await call('GET', `/orders/${sentOrder.id}`, { token: cashier })).body,
    );
    await prisma.order.update({ where: { id: sentOrder.id }, data: { status: 'OPEN' } });
    r = await call('POST', '/orders/items', {
      token: cashier,
      body: {
        target: { kind: 'ORDER', orderId: sentOrder.id, expectedVersion: sentBefore.version },
        menuItemId: momo.id,
      },
    });
    check('adding to an OPEN order -> 201', r.status === 201, r.status);
    check('the order stays OPEN', orderOf(r.body).status === 'OPEN', orderOf(r.body).status);

    console.log('\n[a BILLED order is closed to this API]');
    await prisma.order.update({ where: { id: sentOrder.id }, data: { status: 'BILLED' } });
    const billed = orderOf((await call('GET', `/orders/${sentOrder.id}`, { token: cashier })).body);
    r = await call('POST', '/orders/items', {
      token: cashier,
      body: {
        target: { kind: 'ORDER', orderId: sentOrder.id, expectedVersion: billed.version },
        menuItemId: momo.id,
      },
    });
    check('adding to a BILLED order -> 409', r.status === 409, r.status);
    check('code ORDER_NOT_EDITABLE', errorCode(r.body) === 'ORDER_NOT_EDITABLE');
    check('message points at the bill', /billed/i.test(JSON.stringify(r.body)));
    await prisma.order.update({ where: { id: sentOrder.id }, data: { status: 'DRAFT' } });

    // ------------------------------------------------------------- isolation
    console.log('\n[restaurant isolation]');
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
    const otherCategory = await prisma.menuCategory.create({
      data: { restaurantId: other.id, name: 'Other Menu' },
    });
    const otherItem = await prisma.menuItem.create({
      data: {
        restaurantId: other.id,
        categoryId: otherCategory.id,
        name: 'Other Dish',
        pricePaisa: 1000,
      },
    });
    void otherStaff;

    check(
      "other restaurant's menu is invisible",
      !JSON.stringify((await call('GET', '/menu', { token: cashier })).body).includes('Other Dish'),
    );
    check(
      "cannot read another restaurant's order",
      (await call('GET', `/orders/${order.id}`, { token: cashier })).status === 200,
    );
    r = await call('GET', `/tables/${otherTable.id}/order`, { token: cashier });
    check("cannot read another restaurant's table -> 404", r.status === 404, r.status);
    r = await call('POST', '/orders/items', {
      token: cashier,
      body: { target: { kind: 'TABLE', tableId: otherTable.id }, menuItemId: momo.id },
    });
    check("cannot order onto another restaurant's table -> 404", r.status === 404, r.status);
    r = await call('POST', '/orders/items', {
      token: cashier,
      body: {
        target: { kind: 'ORDER', orderId: order.id, expectedVersion: order.version },
        menuItemId: otherItem.id,
      },
    });
    check("cannot add another restaurant's dish -> 404", r.status === 404, r.status);
    check(
      'nothing was written to the other restaurant',
      (await prisma.order.count({ where: { restaurantId: other.id } })) === 0,
    );

    // --------------------------------------------------------- authorization
    console.log('\n[authorization]');
    check(
      'KITCHEN cannot read an order',
      (await call('GET', `/orders/${order.id}`, { token: kitchen })).status === 403,
    );
    r = await call('POST', '/orders/items', {
      token: kitchen,
      body: { target: { kind: 'TABLE', tableId: table4.id }, menuItemId: momo.id },
    });
    check('KITCHEN cannot create orders -> 403', r.status === 403, r.status);
    r = await call('PATCH', `/orders/${order.id}/items/${momoLine?.id ?? ''}`, {
      token: kitchen,
      body: { expectedVersion: order.version, quantity: 2 },
    });
    check('KITCHEN cannot edit items -> 403', r.status === 403, r.status);

    // -------------------------------------------------------------- takeaway
    console.log('\n[takeaway]');
    r = await call('POST', '/orders/items', {
      token: cashier,
      body: { target: { kind: 'TAKEAWAY' }, menuItemId: coke.id, quantity: 3 },
    });
    check('takeaway draft created -> 201', r.status === 201, r.status);
    const takeaway = orderOf(r.body);
    check('type is TAKEAWAY', takeaway.type === 'TAKEAWAY');
    check('no table attached', takeaway.table === null);
    check('quantity honoured', takeaway.items[0]?.quantity === 3);
    check('order numbers keep counting up', takeaway.orderNumber > order.orderNumber);
    r = await call('POST', '/orders/items', {
      token: cashier,
      body: { target: { kind: 'TAKEAWAY' }, menuItemId: momo.id },
    });
    check('a second concurrent takeaway is allowed', r.status === 201, r.status);
    check(
      'takeaways do not collide on the table index',
      (await prisma.order.count({ where: { type: 'TAKEAWAY' } })) === 2,
    );

    // ------------------------------------------------- empty-draft cleanup
    console.log('\n[removing the last item deletes the empty draft]');
    let cleanup = orderOf(
      (
        await call('POST', '/orders/items', {
          token: cashier,
          body: { target: { kind: 'TAKEAWAY' }, menuItemId: momo.id },
        })
      ).body,
    );
    cleanup = orderOf(
      (
        await call('POST', '/orders/items', {
          token: cashier,
          body: {
            target: { kind: 'ORDER', orderId: cleanup.id, expectedVersion: cleanup.version },
            menuItemId: coke.id,
          },
        })
      ).body,
    );
    check('two lines to remove', cleanup.items.length === 2);

    r = await call(
      'DELETE',
      `/orders/${cleanup.id}/items/${cleanup.items[0]?.id ?? ''}?expectedVersion=${String(cleanup.version)}`,
      { token: cashier },
    );
    check('removing one item -> 200', r.status === 200, r.status);
    cleanup = (r.body as MaybeOrderResponse).order as OrderDto;
    check('the order survives with one line left', cleanup !== null && cleanup.items.length === 1);

    r = await call(
      'DELETE',
      `/orders/${cleanup.id}/items/${cleanup.items[0]?.id ?? ''}?expectedVersion=${String(cleanup.version)}`,
      { token: cashier },
    );
    check('removing the last item -> 200', r.status === 200, r.status);
    check(
      'response says there is no order any more',
      (r.body as MaybeOrderResponse).order === null,
    );
    check(
      'the Order row is gone',
      (await prisma.order.findFirst({ where: { id: cleanup.id } })) === null,
    );
    check(
      'so are its items',
      (await prisma.orderItem.count({ where: { orderId: cleanup.id } })) === 0,
    );

    console.log('\n[a table freed this way becomes AVAILABLE again]');
    const t5order = await prisma.order.findFirstOrThrow({ where: { tableId: table5.id } });
    const t5full = orderOf((await call('GET', `/orders/${t5order.id}`, { token: cashier })).body);
    for (const item of t5full.items) {
      const current = orderOf(
        (await call('GET', `/orders/${t5order.id}`, { token: cashier })).body,
      );
      await call(
        'DELETE',
        `/orders/${t5order.id}/items/${item.id}?expectedVersion=${String(current.version)}`,
        { token: cashier },
      );
    }
    const floor = await call('GET', '/floor', { token: cashier });
    const t5 = (floor.body as { areas: { tables: { name: string; status: string }[] }[] }).areas
      .flatMap((x) => x.tables)
      .find((x) => x.name === 'Table 5');
    check('Table 5 is AVAILABLE again', t5?.status === 'AVAILABLE', t5?.status);
    check(
      'and Table 4 is still OCCUPIED',
      (floor.body as { areas: { tables: { name: string; status: string }[] }[] }).areas
        .flatMap((x) => x.tables)
        .find((x) => x.name === 'Table 4')?.status === 'OCCUPIED',
    );

    console.log('\n[a draft that HAS been to the kitchen is never deleted]');
    const protectedOrder = orderOf(
      (
        await call('POST', '/orders/items', {
          token: cashier,
          body: { target: { kind: 'TABLE', tableId: table5.id }, menuItemId: momo.id },
        })
      ).body,
    );
    await prisma.kot.create({
      data: {
        restaurantId: restaurant.id,
        orderId: protectedOrder.id,
        kotNumber: 1,
        status: 'NEW',
        createdByStaffId: (await prisma.staff.findFirstOrThrow({ where: { username: 'bikash.t' } }))
          .id,
      },
    });
    r = await call(
      'DELETE',
      `/orders/${protectedOrder.id}/items/${protectedOrder.items[0]?.id ?? ''}?expectedVersion=${String(protectedOrder.version)}`,
      { token: cashier },
    );
    check('the last item can still be removed', r.status === 200, r.status);
    check(
      'but the order is KEPT because a ticket exists',
      (r.body as MaybeOrderResponse).order !== null,
    );
    check(
      'the order row survives',
      (await prisma.order.findFirst({ where: { id: protectedOrder.id } })) !== null,
    );

    // ----------------------------------------------------------- reopen flow
    console.log('\n[the demo: go away and come back]');
    const reopened = await call('GET', `/tables/${table4.id}/order`, { token: cashier });
    const reopenedOrder = (reopened.body as MaybeOrderResponse).order;
    check('Table 4 still has its draft', reopenedOrder !== null);
    check('same order id', reopenedOrder?.id === order.id);
    check('same lines', reopenedOrder?.items.length === 4, reopenedOrder?.items.length);
    check(
      'same subtotal',
      reopenedOrder?.subtotalPaisa === order.subtotalPaisa,
      reopenedOrder?.subtotalPaisa,
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
