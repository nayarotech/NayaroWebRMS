/** Table transfers: atomic movement, audit history, permissions and live clients. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { io, type Socket } from 'socket.io-client';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import {
  REALTIME_EVENTS,
  type FloorResponse,
  type InvoiceDto,
  type KitchenTicketsResponse,
  type LoginResponse,
  type OrderDto,
  type OrderResponse,
} from '@nayaro/shared';
import { ensureDataLayout, resolveDataLayout } from '@nayaro/database';
import { startNayaroServer, stopNayaroServer } from '../src/server';
import { refreshOrderViews, serviceSyncSnapshot } from '../../../apps/web/src/lib/serviceRecovery';

const root = mkdtempSync(join(tmpdir(), 'nayaro-transfers-'));
const layout = ensureDataLayout(resolveDataLayout(root));
let handle: Awaited<ReturnType<typeof startNayaroServer>> | undefined;
let socket: Socket | undefined;
const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const cleanups: (() => void)[] = [];
let checks = 0;
let sequence = 0;
interface Result<T> {
  status: number;
  body: T;
}
async function request<T>(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
  key?: string,
): Promise<Result<T>> {
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
  return { status: response.status, body: (await response.json()) as T };
}
async function call<T>(
  method: string,
  path: string,
  status: number,
  token?: string,
  body?: unknown,
  key?: string,
): Promise<T> {
  const response = await request<T>(method, path, token, body, key);
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(response.body)}`);
  checks++;
  return response.body;
}
async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await delay(20);
  }
  assert.fail('Service views did not recover after the transfer');
}
try {
  const start = () =>
    startNayaroServer({
      host: '127.0.0.1',
      port: 4344,
      databaseFilePath: layout.databaseFilePath,
      silent: true,
    });
  handle = await start();
  await call('POST', '/tenants/register', 201, undefined, {
    restaurant: { slug: 'verify-restaurant', name: 'Transfer verification' },
    owner: { name: 'Owner', username: 'owner', password: 'transfer-owner-password' },
  });
  const owner = (
    await call<LoginResponse>('POST', '/auth/login', 200, undefined, {
      workspace: 'verify-restaurant', username: 'owner',
      password: 'transfer-owner-password',
    })
  ).token;
  const restaurant = await handle.prisma.restaurant.findFirstOrThrow();
  const tokens = new Map<string, string>([['OWNER', owner]]);
  for (const role of ['MANAGER', 'CASHIER', 'WAITER', 'KITCHEN'] as const) {
    await call('POST', '/management/staff', 201, owner, {
      name: role,
      username: role.toLowerCase(),
      password: 'transfer-staff-password',
      role,
    });
    tokens.set(
      role,
      (
        await call<LoginResponse>('POST', '/auth/login', 200, undefined, {
          workspace: 'verify-restaurant', username: role.toLowerCase(),
          password: 'transfer-staff-password',
        })
      ).token,
    );
  }
  const waiter = tokens.get('WAITER')!;
  const area = await handle.prisma.restaurantArea.create({
    data: { restaurantId: restaurant.id, name: 'Main floor' },
  });
  const otherArea = await handle.prisma.restaurantArea.create({
    data: { restaurantId: restaurant.id, name: 'Terrace' },
  });
  const table = async (areaId = area.id) =>
    handle!.prisma.restaurantTable.create({
      data: { restaurantId: restaurant.id, areaId, name: `Table ${++sequence}` },
    });
  const [a, b, c, occupied, inactive] = await Promise.all([
    table(),
    table(otherArea.id),
    table(),
    table(),
    table(),
  ]);
  await handle.prisma.restaurantTable.update({
    where: { id: inactive.id },
    data: { isActive: false },
  });
  const category = await handle.prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: 'Food' },
  });
  const item = await handle.prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: 'Momo', pricePaisa: 15000 },
  });
  const add = async (tableId?: string) =>
    (
      await call<OrderResponse>('POST', '/orders/items', 201, waiter, {
        target: tableId ? { kind: 'TABLE', tableId } : { kind: 'TAKEAWAY' },
        menuItemId: item.id,
        quantity: 2,
        note: 'No onion',
      })
    ).order;
  const get = async (orderId: string) =>
    (await call<OrderResponse>('GET', `/orders/${orderId}`, 200, waiter)).order;
  const floor = () => call<FloorResponse>('GET', '/floor', 200, waiter);
  const floorTable = (data: FloorResponse, id: string) =>
    data.areas.flatMap((row) => row.tables).find((row) => row.id === id)!;
  const path = (id: string) => `/orders/${id}/transfer-table`;
  const transfer = async (
    order: OrderDto,
    toTableId: string,
    token = waiter,
    key = `transfer-action-${++sequence}`,
  ) =>
    call<OrderResponse>(
      'POST',
      path(order.id),
      200,
      token,
      { expectedVersion: order.version, toTableId },
      key,
    );
  let order = await add(a.id);
  await add(occupied.id);
  assert.equal(floorTable(await floor(), a.id).activeOrderId, order.id);
  assert.equal(order.canTransferTable, true);
  const before = await handle.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
  const counters = await handle.prisma.restaurantCounter.findMany({ orderBy: { name: 'asc' } });
  const moved = await transfer(order, b.id, waiter, 'transfer-first-action-001');
  assert.equal(moved.order.id, order.id);
  assert.equal(moved.order.version, order.version + 1);
  assert.equal(moved.order.table!.id, b.id);
  assert.deepEqual(moved.order.items, order.items);
  assert.equal(moved.order.orderNumber, order.orderNumber);
  assert.equal(
    (await handle.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).businessDate,
    before.businessDate,
  );
  assert.deepEqual(
    await handle.prisma.restaurantCounter.findMany({ orderBy: { name: 'asc' } }),
    counters,
  );
  assert.equal(moved.order.tableTransfers.length, 1);
  assert.equal(moved.order.tableTransfers[0]!.staff.name, 'WAITER');
  assert.equal(moved.order.tableTransfers[0]!.from.name, a.name);
  assert.equal(moved.order.tableTransfers[0]!.to.name, b.name);
  assert.equal(floorTable(await floor(), a.id).status, 'AVAILABLE');
  assert.equal(floorTable(await floor(), b.id).status, 'OCCUPIED');
  assert.equal(
    (await call<{ order: null }>('GET', `/tables/${a.id}/order`, 200, waiter)).order,
    null,
  );
  assert.deepEqual(
    await call(
      'POST',
      path(order.id),
      200,
      waiter,
      { expectedVersion: order.version, toTableId: b.id },
      'transfer-first-action-001',
    ),
    moved,
  );
  assert.equal(await handle.prisma.orderTableTransfer.count({ where: { orderId: order.id } }), 1);
  await call(
    'POST',
    path(order.id),
    409,
    waiter,
    { expectedVersion: moved.order.version, toTableId: c.id },
    'transfer-first-action-001',
  );
  await call('POST', path(order.id), 409, waiter, {
    expectedVersion: order.version,
    toTableId: c.id,
  });
  order = await get(order.id);
  assert.equal(order.table!.id, b.id);
  const rejectedCount = await handle.prisma.orderTableTransfer.count();
  for (const [toTableId, status] of [
    [b.id, 409],
    [occupied.id, 409],
    [inactive.id, 409],
    ['missing', 404],
  ] as const)
    await call('POST', path(order.id), status, waiter, {
      expectedVersion: order.version,
      toTableId,
    });
  await call('POST', path(order.id), 400, waiter, { toTableId: c.id });
  await call('POST', path(order.id), 400, waiter, { expectedVersion: -1, toTableId: c.id });
  assert.equal(await handle.prisma.orderTableTransfer.count(), rejectedCount);
  assert.equal((await get(order.id)).version, order.version);

  // Authentication and tenant boundaries are checked before touching an order.
  await call('POST', path(order.id), 401, undefined, {
    expectedVersion: order.version,
    toTableId: c.id,
  });
  await call('POST', path(order.id), 403, tokens.get('KITCHEN'), {
    expectedVersion: order.version,
    toTableId: c.id,
  });
  const other = await handle.prisma.restaurant.create({
    data: { slug: 'other-restaurant', name: 'Other', address: '', phone: '', panNumber: '' },
  });
  const foreignArea = await handle.prisma.restaurantArea.create({
    data: { restaurantId: other.id, name: 'Private' },
  });
  const foreignTable = await handle.prisma.restaurantTable.create({
    data: { restaurantId: other.id, areaId: foreignArea.id, name: 'Private table' },
  });
  await call('POST', path(order.id), 404, waiter, {
    expectedVersion: order.version,
    toTableId: foreignTable.id,
  });
  await call('POST', path('missing'), 404, waiter, {
    expectedVersion: order.version,
    toTableId: c.id,
  });
  const primaryOwner = await handle.prisma.staff.findFirstOrThrow({
    where: { restaurantId: restaurant.id, role: 'OWNER' },
  });
  await handle.prisma.staff.create({
    data: {
      restaurantId: other.id,
      name: 'Other owner',
      username: 'other-owner',
      passwordHash: primaryOwner.passwordHash,
      role: 'OWNER',
    },
  });
  const foreignToken = (
    await call<LoginResponse>('POST', '/auth/login', 200, undefined, {
      workspace: 'other-restaurant', username: 'other-owner',
      password: 'transfer-owner-password',
    })
  ).token;
  await call('POST', path(order.id), 404, foreignToken, {
    expectedVersion: order.version,
    toTableId: foreignTable.id,
  });
  // Changing a destination's area to inactive must also rule it out.
  const hiddenArea = await handle.prisma.restaurantArea.create({
    data: { restaurantId: restaurant.id, name: 'Closed area', isActive: false },
  });
  const hidden = await table(hiddenArea.id);
  await call('POST', path(order.id), 409, waiter, {
    expectedVersion: order.version,
    toTableId: hidden.id,
  });

  // Every order-taking role can move tables; a kitchen account can opt into that duty.
  for (const role of ['OWNER', 'MANAGER', 'CASHIER', 'WAITER']) {
    order = (await transfer(order, order.table!.id === b.id ? c.id : b.id, tokens.get(role))).order;
  }
  const kitchenStaff = await handle.prisma.staff.findFirstOrThrow({
    where: { role: 'KITCHEN', restaurantId: restaurant.id },
  });
  await call('PATCH', `/management/staff/${kitchenStaff.id}`, 200, owner, { canTakeOrders: true });
  const extraDuty = (
    await call<LoginResponse>('POST', '/auth/login', 200, undefined, {
      workspace: 'verify-restaurant', username: 'kitchen',
      password: 'transfer-staff-password',
    })
  ).token;
  order = (await transfer(order, a.id, extraDuty)).order;
  const takeaway = await add();
  await call('POST', path(takeaway.id), 409, waiter, {
    expectedVersion: takeaway.version,
    toTableId: c.id,
  });

  // Live observers follow order identity and refresh kitchen labels without a new dispatch.
  order = (
    await call<OrderResponse>('POST', `/orders/${order.id}/send-kot`, 201, waiter, {
      expectedVersion: order.version,
    })
  ).order;
  const ticketBefore = await handle.prisma.kot.findFirstOrThrow({ where: { orderId: order.id } });
  socket = io(handle.baseUrl, {
    auth: { token: waiter },
    transports: ['websocket'],
    reconnection: false,
  });
  await new Promise<void>((resolve, reject) => {
    socket!.once('connect', resolve);
    socket!.once('connect_error', reject);
  });
  let newTicketEvents = 0;
  let transferEvents = 0;
  socket.on(REALTIME_EVENTS.kotCreated, () => newTicketEvents++);
  socket.on(REALTIME_EVENTS.orderUpdated, () => {
    transferEvents++;
    void refreshOrderViews(cache);
  });
  let failOrderRead = false;
  const orderObserver = new QueryObserver<OrderResponse>(cache, {
    queryKey: ['orders', order.id],
    queryFn: () => {
      if (failOrderRead) throw new Error('Connection interrupted');
      return call('GET', `/orders/${order.id}`, 200, waiter);
    },
  });
  const floorObserver = new QueryObserver<FloorResponse>(cache, {
    queryKey: ['floor'],
    queryFn: floor,
  });
  const kitchenObserver = new QueryObserver<KitchenTicketsResponse>(cache, {
    queryKey: ['kitchen', 'tickets'],
    queryFn: () => call('GET', '/kitchen/tickets', 200, waiter),
  });
  cleanups.push(
    orderObserver.subscribe(() => {}),
    floorObserver.subscribe(() => {}),
    kitchenObserver.subscribe(() => {}),
  );
  await until(
    () =>
      orderObserver.getCurrentResult().isSuccess &&
      kitchenObserver.getCurrentResult().isSuccess &&
      floorObserver.getCurrentResult().isSuccess,
  );
  const liveBody = { expectedVersion: order.version, toTableId: b.id };
  const liveMove = await call<OrderResponse>(
    'POST',
    path(order.id),
    200,
    waiter,
    liveBody,
    'transfer-live-action-001',
  );
  await until(
    () =>
      orderObserver.getCurrentResult().data?.order.table?.id === b.id &&
      kitchenObserver
        .getCurrentResult()
        .data?.tickets.some(
          (ticket) => ticket.id === ticketBefore.id && ticket.tableName === b.name,
        ) === true &&
      floorTable(floorObserver.getCurrentResult().data!, a.id).status === 'AVAILABLE',
  );
  await call('POST', path(order.id), 200, waiter, liveBody, 'transfer-live-action-001');
  await delay(40);
  assert.equal(transferEvents, 1, 'A replay must not broadcast another transfer');
  assert.equal(newTicketEvents, 0, 'A transfer must not ring a new-ticket alarm');
  const ticketAfter = await handle.prisma.kot.findUniqueOrThrow({ where: { id: ticketBefore.id } });
  assert.deepEqual(ticketAfter, ticketBefore);
  assert.equal(await handle.prisma.kot.count({ where: { orderId: order.id } }), 1);
  assert.equal(floorTable(await floor(), b.id).status, 'PREPARING');
  assert.equal(JSON.parse(serviceSyncSnapshot(cache)).failed, false);
  failOrderRead = true;
  await orderObserver.refetch();
  assert.equal(
    JSON.parse(serviceSyncSnapshot(cache)).failed,
    true,
    'The pinned order must contribute to connection freshness',
  );
  failOrderRead = false;
  await orderObserver.refetch();
  assert.equal(JSON.parse(serviceSyncSnapshot(cache)).failed, false);
  order = liveMove.order;
  for (const cleanup of cleanups.splice(0)) cleanup();
  cache.clear();
  socket.disconnect();

  // A newly seated group at the old table is a separate order. Old clients stay on the moved ID.
  const newGuests = await add(a.id);
  assert.notEqual(newGuests.id, order.id);
  assert.equal((await get(order.id)).table!.id, b.id);
  await call('POST', '/orders/items', 409, waiter, {
    target: { kind: 'ORDER', orderId: order.id, expectedVersion: liveBody.expectedVersion },
    menuItemId: item.id,
  });
  assert.equal((await get(newGuests.id)).items[0]!.quantity, 2);

  // A bill permanently ends transfers, including after voiding the bill.
  const invoice = (
    await call<{ invoice: InvoiceDto }>(
      'POST',
      `/orders/${order.id}/invoice`,
      201,
      tokens.get('CASHIER'),
      { expectedVersion: order.version },
    )
  ).invoice;
  assert.equal((await get(order.id)).canTransferTable, false);
  await call('POST', path(order.id), 409, waiter, {
    expectedVersion: invoice.orderVersion,
    toTableId: c.id,
  });
  await call('POST', `/invoices/${invoice.id}/void`, 200, owner, { reason: 'Wrong buyer details' });
  order = await get(order.id);
  assert.equal(order.canTransferTable, false);
  await call('POST', path(order.id), 409, waiter, {
    expectedVersion: order.version,
    toTableId: c.id,
  });

  // Closed orders stay fixed too.
  const reissued = (
    await call<{ invoice: InvoiceDto }>('POST', `/orders/${order.id}/invoice`, 201, owner, {
      expectedVersion: order.version,
    })
  ).invoice;
  await call('POST', `/invoices/${reissued.id}/payments`, 201, owner, {
    expectedOrderVersion: reissued.orderVersion,
    method: 'CASH',
    amountPaisa: reissued.grandTotalPaisa,
  });
  const paidOrder = await get(order.id);
  await call('POST', path(paidOrder.id), 409, waiter, {
    expectedVersion: paidOrder.version,
    toTableId: c.id,
  });

  // Competing moves to one destination must have exactly one winner.
  const [raceFromA, raceFromB, raceTo] = await Promise.all([table(), table(), table()]);
  const [raceA, raceB] = await Promise.all([add(raceFromA.id), add(raceFromB.id)]);
  const moves = await Promise.all(
    [raceA, raceB].map((candidate, index) =>
      request(
        'POST',
        path(candidate.id),
        waiter,
        { expectedVersion: candidate.version, toTableId: raceTo.id },
        `transfer-race-target-${index}`,
      ),
    ),
  );
  assert.deepEqual(moves.map((row) => row.status).sort(), [200, 409]);
  assert.equal(
    await handle.prisma.order.count({ where: { tableId: raceTo.id, closedAt: null } }),
    1,
  );
  const sameBody = {
    expectedVersion: (await get(raceA.id)).version,
    toTableId: (await table()).id,
  };
  const copies = await Promise.all(
    [1, 2].map(() =>
      call<OrderResponse>(
        'POST',
        path(raceA.id),
        200,
        waiter,
        sameBody,
        'transfer-concurrent-copy-01',
      ),
    ),
  );
  assert.deepEqual(copies[0], copies[1]);

  // A transfer racing the first item for new guests cannot overwrite their order.
  const firstItemSource = await table();
  const firstItemTarget = await table();
  const firstItemOrder = await add(firstItemSource.id);
  const firstItemRace = await Promise.all([
    request(
      'POST',
      path(firstItemOrder.id),
      waiter,
      { expectedVersion: firstItemOrder.version, toTableId: firstItemTarget.id },
      'transfer-first-item-race-01',
    ),
    request('POST', '/orders/items', waiter, {
      target: { kind: 'TABLE', tableId: firstItemTarget.id },
      menuItemId: item.id,
    }),
  ]);
  assert.equal(firstItemRace.filter((row) => row.status === 200 || row.status === 201).length, 1);
  assert.equal(firstItemRace.filter((row) => row.status === 409).length, 1);
  assert.equal(
    await handle.prisma.order.count({ where: { tableId: firstItemTarget.id, closedAt: null } }),
    1,
  );

  // Billing and moving claim the same order version; both cannot succeed.
  const billingSource = await table();
  const billingDestination = await table();
  let billingOrder = await add(billingSource.id);
  billingOrder = (
    await call<OrderResponse>('POST', `/orders/${billingOrder.id}/send-kot`, 201, waiter, {
      expectedVersion: billingOrder.version,
    })
  ).order;
  const billingRace = await Promise.all([
    request(
      'POST',
      path(billingOrder.id),
      waiter,
      { expectedVersion: billingOrder.version, toTableId: billingDestination.id },
      'transfer-invoice-race-001',
    ),
    request('POST', `/orders/${billingOrder.id}/invoice`, tokens.get('CASHIER'), {
      expectedVersion: billingOrder.version,
    }),
  ]);
  assert.equal(billingRace.filter((row) => row.status === 200 || row.status === 201).length, 1);
  assert.equal(billingRace.filter((row) => row.status === 409).length, 1);
  const billed = await handle.prisma.invoice.count({ where: { orderId: billingOrder.id } });
  if (billed > 0) assert.equal((await get(billingOrder.id)).table!.id, billingSource.id);

  // Deactivation racing a move cannot leave an active order at an inactive table.
  const raceFrom = await table();
  const raceDestination = await table();
  const raceOrder = await add(raceFrom.id);
  const deactivateRace = await Promise.all([
    request(
      'POST',
      path(raceOrder.id),
      waiter,
      { expectedVersion: raceOrder.version, toTableId: raceDestination.id },
      'transfer-deactivate-race-01',
    ),
    request('PATCH', `/floor/tables/${raceDestination.id}`, owner, { isActive: false }),
  ]);
  assert.deepEqual(deactivateRace.map((row) => row.status).sort(), [200, 409]);
  const actualDestination = await handle.prisma.restaurantTable.findUniqueOrThrow({
    where: { id: raceDestination.id },
  });
  assert.ok(
    actualDestination.isActive || (await get(raceOrder.id)).table!.id !== raceDestination.id,
  );

  // Audit names survive table renaming; empty-draft deletion preserves the transfer record.
  const emptyFrom = await table();
  const emptyTo = await table();
  let emptyOrder = await add(emptyFrom.id);
  emptyOrder = (await transfer(emptyOrder, emptyTo.id)).order;
  await call('PATCH', `/floor/tables/${emptyTo.id}`, 200, owner, { name: 'Renamed destination' });
  emptyOrder = await get(emptyOrder.id);
  assert.equal(emptyOrder.tableTransfers[0]!.to.name, emptyTo.name);
  await call(
    'DELETE',
    `/orders/${emptyOrder.id}/items/${emptyOrder.items[0]!.id}?expectedVersion=${emptyOrder.version}`,
    200,
    waiter,
  );
  const keptAudit = await handle.prisma.orderTableTransfer.findFirstOrThrow({
    where: { orderNumber: emptyOrder.orderNumber },
  });
  assert.equal(keptAudit.orderId, null);
  assert.equal(keptAudit.toTableName, emptyTo.name);
  assert.equal(floorTable(await floor(), emptyTo.id).status, 'AVAILABLE');
  const beforeRestart = await get(raceA.id);
  await stopNayaroServer(handle);
  handle = await start();
  assert.deepEqual(await get(raceA.id), beforeRestart);
  assert.deepEqual(
    await call('POST', path(raceA.id), 200, waiter, sameBody, 'transfer-concurrent-copy-01'),
    copies[0],
  );
  assert.deepEqual(await get(raceA.id), beforeRestart);
  console.log(
    `PASS: ${checks} HTTP checks; transfers, audit retention, live order/kitchen recovery, permissions, retries and concurrent moves.`,
  );
} finally {
  for (const cleanup of cleanups) cleanup();
  cache.clear();
  socket?.disconnect();
  if (handle) await stopNayaroServer(handle);
  rmSync(root, { recursive: true, force: true });
}
