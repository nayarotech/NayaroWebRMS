/** Durable request receipts and clients recovering from a lost write response. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { io, type Socket } from 'socket.io-client';
import type {
  InvoiceDto,
  LoginResponse,
  OrderResponse,
  SendToKitchenResponse,
} from '@nayaro/shared';
import { ensureDataLayout, resolveDataLayout } from '@nayaro/database';
import { startNayaroServer, stopNayaroServer } from '../src/server';

const root = mkdtempSync(join(tmpdir(), 'nayaro-safe-retries-'));
const layout = ensureDataLayout(resolveDataLayout(root));
let handle: Awaited<ReturnType<typeof startNayaroServer>> | undefined;
const realFetch = globalThis.fetch;
let checks = 0;
let socket: Socket | undefined;

async function call<T>(
  path: string,
  status: number,
  token?: string,
  body?: unknown,
  key?: string,
): Promise<T> {
  const response = await realFetch(`${handle!.baseUrl}${path}`, {
    method: 'POST',
    headers: {
      Connection: 'close',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: JSON.stringify(body),
  });
  const result: unknown = await response.json();
  assert.equal(response.status, status, `${path}: ${JSON.stringify(result)}`);
  checks++;
  return result as T;
}

try {
  const start = () =>
    startNayaroServer({
      host: '127.0.0.1',
      port: 4342,
      databaseFilePath: layout.databaseFilePath,
      silent: true,
    });
  handle = await start();
  await call('/tenants/register', 201, undefined, {
    restaurant: { slug: 'verify-restaurant', name: 'Retry verification' },
    owner: { name: 'Owner', username: 'owner', password: 'safe-retries-test-password' },
  });
  const owner = await call<LoginResponse>('/auth/login', 200, undefined, {
    workspace: 'verify-restaurant', username: 'owner',
    password: 'safe-retries-test-password',
  });
  await call('/management/staff', 201, owner.token, {
    name: 'Waiter',
    username: 'waiter',
    password: 'safe-retries-staff-password',
    role: 'WAITER',
  });
  const waiter = await call<LoginResponse>('/auth/login', 200, undefined, {
    workspace: 'verify-restaurant', username: 'waiter',
    password: 'safe-retries-staff-password',
  });
  socket = io(handle.baseUrl, {
    auth: { token: owner.token },
    transports: ['websocket'],
    reconnection: false,
  });
  await new Promise<void>((resolve, reject) => {
    socket!.once('connect', resolve);
    socket!.once('connect_error', reject);
  });
  let kitchenEvents = 0;
  let paymentEvents = 0;
  socket.on('kot:created', () => kitchenEvents++);
  socket.on('payment:recorded', () => paymentEvents++);
  const restaurant = await handle.prisma.restaurant.findFirstOrThrow();
  const category = await handle.prisma.menuCategory.create({
    data: { restaurantId: restaurant.id, name: 'Food' },
  });
  const item = await handle.prisma.menuItem.create({
    data: { restaurantId: restaurant.id, categoryId: category.id, name: 'Momo', pricePaisa: 10000 },
  });
  const body = { target: { kind: 'TAKEAWAY' }, menuItemId: item.id };
  const key = 'test-add-takeaway-0001';
  const first = await call<OrderResponse>('/orders/items', 201, owner.token, body, key);
  const replay = await call<OrderResponse>('/orders/items', 201, owner.token, body, key);
  assert.deepEqual(replay, first);
  assert.equal(await handle.prisma.order.count(), 1);
  assert.equal(await handle.prisma.orderItem.count(), 1);

  // A retry confirms the original result, even if the dish is now sold out.
  await handle.prisma.menuItem.update({ where: { id: item.id }, data: { isAvailable: false } });
  assert.deepEqual(await call('/orders/items', 201, owner.token, body, key), first);
  await call('/orders/items', 409, owner.token, { ...body, quantity: 2 }, key);
  await call('/orders/items', 400, owner.token, body, 'short');
  await call('/orders/items', 401, undefined, body, key);
  const failedKey = 'test-failed-action-0001';
  await call('/orders/items', 409, owner.token, body, failedKey);
  assert.equal(await handle.prisma.requestReceipt.count({ where: { key: failedKey } }), 0);
  await handle.prisma.menuItem.update({ where: { id: item.id }, data: { isAvailable: true } });
  await call('/orders/items', 201, owner.token, body, failedKey);

  // Simultaneous copies produce one write, both callers get the same response.
  const countBefore = await handle.prisma.order.count();
  const concurrent = await Promise.all([
    call('/orders/items', 201, owner.token, body, 'test-concurrent-add-01'),
    call('/orders/items', 201, owner.token, body, 'test-concurrent-add-01'),
  ]);
  assert.deepEqual(concurrent[0], concurrent[1]);
  assert.equal(await handle.prisma.order.count(), countBefore + 1);

  // Existing-order quantities must not increment again on a replay.
  const addBody = {
    target: { kind: 'ORDER', orderId: first.order.id, expectedVersion: first.order.version },
    menuItemId: item.id,
  };
  const added = await call<OrderResponse>(
    '/orders/items',
    201,
    owner.token,
    addBody,
    'test-existing-add-0001',
  );
  assert.deepEqual(
    await call('/orders/items', 201, owner.token, addBody, 'test-existing-add-0001'),
    added,
  );
  assert.equal(added.order.items[0]!.quantity, 2);
  // Reservation and version changes must roll back together on domain failure.
  const staleKey = 'test-stale-version-001';
  await call('/orders/items', 409, owner.token, addBody, staleKey);
  assert.equal(await handle.prisma.requestReceipt.count({ where: { key: staleKey } }), 0);
  assert.equal(
    (await handle.prisma.order.findUniqueOrThrow({ where: { id: first.order.id } })).version,
    added.order.version,
  );
  const sendPath = `/orders/${first.order.id}/send-kot`;
  const sendBody = { expectedVersion: added.order.version };
  const ticket = await call<SendToKitchenResponse>(
    sendPath,
    201,
    owner.token,
    sendBody,
    'test-send-ticket-0001',
  );
  assert.deepEqual(
    await call(sendPath, 201, owner.token, sendBody, 'test-send-ticket-0001'),
    ticket,
  );
  assert.equal(await handle.prisma.kot.count(), 1);
  await delay(40);
  assert.equal(kitchenEvents, 1, 'Replaying a ticket must not ring the kitchen alarm twice');
  // Reusing a key on another operation is rejected, even with another payload.
  await call(sendPath, 409, owner.token, sendBody, key);

  const issued = await call<{ invoice: InvoiceDto }>(
    `/orders/${first.order.id}/invoice`,
    201,
    owner.token,
    {
      expectedVersion: ticket.order.version,
      invoiceType: 'STANDARD',
    },
  );
  const paymentPath = `/invoices/${issued.invoice.id}/payments`;
  const order = await handle.prisma.order.findUniqueOrThrow({ where: { id: first.order.id } });
  const payment = {
    expectedOrderVersion: order.version,
    method: 'CASH',
    amountPaisa: issued.invoice.grandTotalPaisa,
  };
  const partial = { ...payment, amountPaisa: 5000 };
  const paymentCopies = await Promise.all([
    call(paymentPath, 201, owner.token, partial, 'test-payment-partial-01'),
    call(paymentPath, 201, owner.token, partial, 'test-payment-partial-01'),
  ]);
  assert.deepEqual(paymentCopies[0], paymentCopies[1]);
  assert.equal(await handle.prisma.payment.count(), 1);
  payment.expectedOrderVersion = (
    await handle.prisma.order.findUniqueOrThrow({ where: { id: order.id } })
  ).version;
  payment.amountPaisa -= partial.amountPaisa;
  const paid = await call(paymentPath, 201, owner.token, payment, 'test-payment-full-001');
  assert.deepEqual(
    await call(paymentPath, 201, owner.token, payment, 'test-payment-full-001'),
    paid,
  );
  assert.equal(await handle.prisma.payment.count(), 2);
  await delay(40);
  assert.equal(paymentEvents, 2, 'Each distinct payment is announced once');
  await call(paymentPath, 403, waiter.token, payment, 'test-payment-full-001');
  assert.equal(
    (await handle.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status,
    'PAID',
  );

  // An identifier is scoped to staff: another waiter cannot read the owner's receipt.
  const separate = await call<OrderResponse>('/orders/items', 201, waiter.token, body, key);
  assert.notEqual(separate.order.id, first.order.id);
  assert.equal(await handle.prisma.requestReceipt.count({ where: { key } }), 2);
  socket.disconnect();

  // Receipts survive a process restart and do not depend on in-memory caches.
  await stopNayaroServer(handle);
  handle = await start();
  assert.deepEqual(
    await call(paymentPath, 201, owner.token, payment, 'test-payment-full-001'),
    paid,
  );
  assert.deepEqual(await call('/orders/items', 201, owner.token, body, key), first);
  assert.equal(await handle.prisma.payment.count(), 2);

  // Exercise both real clients: commit the write, then lose the first response.
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: new URL(handle.baseUrl),
    },
  });
  // Load browser modules at runtime; the server TS project intentionally has no DOM globals.
  const clientPaths = ['../../../apps/web/src/services/apiClient'];
  interface BrowserClient {
    setAuthTokenGetter(getter: () => string | null): void;
    apiClient: { postWithReceipt(path: string, body: unknown): Promise<unknown> };
  }
  for (const clientPath of clientPaths) {
    const client = (await import(clientPath)) as BrowserClient;
    client.setAuthTokenGetter(() => owner.token);
    const seen: RequestInit[] = [];
    globalThis.fetch = async (url, options) => {
      seen.push(options!);
      // The web client targets its configured API origin; point it at this test server.
      const target = String(url).replace(/^https?:\/\/[^/]+/, handle!.baseUrl);
      const response = await realFetch(target, options);
      if (seen.length === 1) {
        await response.text();
        throw new TypeError('Response lost after commit');
      }
      return response;
    };
    const before: number = await handle.prisma.order.count();
    await client.apiClient.postWithReceipt('/orders/items', body);
    assert.equal(seen.length, 2);
    assert.equal(
      (seen[0]!.headers as Record<string, string>)['Idempotency-Key'],
      (seen[1]!.headers as Record<string, string>)['Idempotency-Key'],
    );
    assert.equal(await handle.prisma.order.count(), before + 1);

    // Ordinary HTTP failures never trigger a retry; two lost replies stop at two.
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response(
        JSON.stringify({ error: { code: 'ORDER_CHANGED', message: 'Changed' } }),
        { status: 409 },
      );
    };
    await assert.rejects(() => client.apiClient.postWithReceipt('/orders/items', body));
    assert.equal(calls, 1);
    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      throw new TypeError('Offline');
    };
    await assert.rejects(() => client.apiClient.postWithReceipt('/orders/items', body));
    assert.equal(calls, 2);

    // A changed login must not replay the old staff member's action.
    let token = owner.token;
    client.setAuthTokenGetter(() => token);
    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      token = 'different-session';
      throw new TypeError('Offline');
    };
    await assert.rejects(() => client.apiClient.postWithReceipt('/orders/items', body));
    assert.equal(calls, 1);
  }
  console.log(
    `PASS: ${checks} HTTP checks; durable, concurrent and failed retries; the web client recovers lost responses.`,
  );
} finally {
  globalThis.fetch = realFetch;
  socket?.disconnect();
  if (handle) await stopNayaroServer(handle);
  rmSync(root, { recursive: true, force: true });
}
