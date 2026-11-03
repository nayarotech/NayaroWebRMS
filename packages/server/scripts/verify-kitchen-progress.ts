/** Kitchen acknowledgment, waiting alerts, and recovery from missed events. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import {
  isNewTicketOverdue,
  kitchenProgressLabel,
  ticketElapsedSeconds,
  type KitchenTicketsResponse,
  type LoginResponse,
  type OrderResponse,
  type SendToKitchenResponse,
  type SettingsResponse,
} from '@nayaro/shared';
import { ensureDataLayout, resolveDataLayout } from '@nayaro/database';
import {
  serviceSyncSnapshot,
  watchServiceConnection,
} from '../../../apps/web/src/lib/serviceRecovery';
import { startNayaroServer, stopNayaroServer } from '../src/server';

const root = mkdtempSync(join(tmpdir(), 'nayaro-kitchen-progress-'));
const layout = ensureDataLayout(resolveDataLayout(root));
let handle: Awaited<ReturnType<typeof startNayaroServer>> | undefined;
const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Infinity } },
});
const cleanups: (() => void)[] = [];
let checks = 0;

async function call<T>(
  method: string,
  path: string,
  status: number,
  token?: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${handle!.baseUrl}${path}`, {
    method,
    headers: {
      Connection: 'close',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const result: unknown = await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`);
  checks++;
  return result as T;
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (condition()) return;
    await delay(20);
  }
  assert.fail('Recovery did not refresh the active service queries');
}

try {
  handle = await startNayaroServer({
    allowDirectRegistration: true,
    host: '127.0.0.1',
    port: 4341,
    databaseFilePath: layout.databaseFilePath,
    silent: true,
  });
  const password = 'kitchen-progress-test-password';
  await call('POST', '/tenants/register', 201, undefined, {
    restaurant: { slug: 'verify-restaurant', name: 'Kitchen progress' },
    owner: { name: 'Owner', username: 'owner', password },
  });
  const owner = await call<LoginResponse>('POST', '/auth/login', 200, undefined, {
    workspace: 'verify-restaurant', username: 'owner',
    password,
  });
  const tokens = new Map<string, string>();
  for (const role of ['MANAGER', 'WAITER', 'KITCHEN']) {
    const username = role.toLowerCase();
    await call('POST', '/management/staff', 201, owner.token, {
      name: role,
      username,
      role,
      password,
    });
    tokens.set(
      role,
      (await call<LoginResponse>('POST', '/auth/login', 200, undefined, { workspace: 'verify-restaurant', username, password }))
        .token,
    );
  }
  const tickets = () =>
    call<KitchenTicketsResponse>('GET', '/kitchen/tickets', 200, tokens.get('WAITER'));
  assert.equal((await tickets()).newTicketAlertMinutes, 5);
  for (const value of [0, -1, 61, 1.5, '5']) {
    await call('PATCH', '/management/settings/operational', 400, owner.token, {
      kitchenNewTicketAlertMinutes: value,
    });
  }
  for (const role of ['WAITER', 'KITCHEN']) {
    await call('PATCH', '/management/settings/operational', 403, tokens.get(role), {
      kitchenNewTicketAlertMinutes: 1,
    });
  }
  const settings = await call<SettingsResponse>(
    'PATCH',
    '/management/settings/operational',
    200,
    tokens.get('MANAGER'),
    { kitchenNewTicketAlertMinutes: 2 },
  );
  assert.equal(settings.operational.kitchenNewTicketAlertMinutes, 2);
  assert.equal((await tickets()).newTicketAlertMinutes, 2);
  console.log(
    'PASS default threshold, validation, management permissions, and staff-readable configuration',
  );

  const restaurantId = owner.staff.restaurantId;
  const category = await handle.prisma.menuCategory.create({
    data: { restaurantId, name: 'Food' },
  });
  const item = await handle.prisma.menuItem.create({
    data: { restaurantId, categoryId: category.id, name: 'Momo', pricePaisa: 22000 },
  });
  const created = await call<OrderResponse>('POST', '/orders/items', 201, tokens.get('WAITER'), {
    target: { kind: 'TAKEAWAY' },
    menuItemId: item.id,
  });
  const { order } = created;
  const sent = await call<SendToKitchenResponse>(
    'POST',
    `/orders/${order.id}/send-kot`,
    201,
    tokens.get('WAITER'),
    { expectedVersion: order.version },
  );
  assert.equal(sent.kot.status, 'NEW');
  assert.match(kitchenProgressLabel(sent.kot.status), /waiting to start/);
  assert.equal(isNewTicketOverdue('NEW', 119, 2), false);
  assert.equal(isNewTicketOverdue('NEW', 120, 2), true);
  for (const status of ['PREPARING', 'READY', 'SERVED', 'VOID'] as const)
    assert.equal(isNewTicketOverdue(status, 3600, 2), false);
  // Age is from the till even when a phone's wall clock is hours off.
  assert.equal(ticketElapsedSeconds(120, 1_000_000, 1_005_000), 125);
  assert.equal(ticketElapsedSeconds(120, 1_000_000, 999_000), 120);
  await handle.prisma.kot.update({
    where: { id: sent.kot.id },
    data: { createdAt: new Date(Date.now() - 180_000) },
  });
  const waiting = (await tickets()).tickets[0]!;
  assert.equal(isNewTicketOverdue(waiting.status, waiting.elapsedSeconds, 2), true);
  console.log(
    'PASS sent acknowledgment and overdue boundaries without flagging cooking/served tickets',
  );

  let failRead = false;
  let reads = 0;
  const orderKey = ['tables', 'test-table', 'order'];
  const observer = new QueryObserver(queryClient, {
    queryKey: orderKey,
    queryFn: async () => {
      reads++;
      if (failRead) throw new Error('Wi-Fi unavailable');
      return call<OrderResponse>('GET', `/orders/${order.id}`, 200, tokens.get('WAITER'));
    },
  });
  cleanups.push(observer.subscribe(() => {}));
  await until(() => observer.getCurrentResult().isSuccess);
  assert.equal(JSON.parse(serviceSyncSnapshot(queryClient)).failed, false);
  let connection = { state: 'connected', connectCount: 1 };
  let notify: (() => void) | undefined;
  cleanups.push(
    watchServiceConnection(
      queryClient,
      (listener) => {
        notify = listener;
        return () => {
          notify = undefined;
        };
      },
      () => connection,
    ),
  );
  await until(() => !observer.getCurrentResult().isFetching);
  const beforeDisconnect = reads;
  connection = { state: 'reconnecting', connectCount: 1 };
  notify?.();
  await call('PATCH', `/kitchen/tickets/${sent.kot.id}/status`, 200, tokens.get('KITCHEN'), {
    status: 'PREPARING',
  });
  assert.equal(observer.getCurrentResult().data!.order.tickets[0]!.status, 'NEW');
  assert.equal(reads, beforeDisconnect);
  connection = { state: 'connected', connectCount: 2 };
  notify?.();
  await until(() => observer.getCurrentResult().data?.order.tickets[0]?.status === 'PREPARING');
  assert.match(
    kitchenProgressLabel(observer.getCurrentResult().data!.order.tickets[0]!.status),
    /started preparing/,
  );
  const afterRecovery = reads;
  notify?.();
  assert.equal(
    reads,
    afterRecovery,
    'A duplicate connection notification must not restart fetching',
  );
  assert.equal(
    await handle.prisma.kot.count({ where: { orderId: order.id } }),
    1,
    'Recovery must not resend tickets',
  );
  console.log('PASS reconnect recovers a missed kitchen acknowledgment without replaying dispatch');

  failRead = true;
  await observer.refetch();
  const failed = JSON.parse(serviceSyncSnapshot(queryClient)) as {
    failed: boolean;
    lastSuccessAt: number;
  };
  assert.equal(failed.failed, true);
  assert.ok(failed.lastSuccessAt > 0, 'A failed refresh must retain the last successful sync time');
  failRead = false;
  await observer.refetch();
  assert.equal(JSON.parse(serviceSyncSnapshot(queryClient)).failed, false);
  const cooking = (await tickets()).tickets[0]!;
  assert.equal(isNewTicketOverdue(cooking.status, cooking.elapsedSeconds, 2), false);
  assert.ok(cooking.startedAt);
  assert.ok(cooking.elapsedSeconds >= 180, 'Starting preparation must not reset total ticket age');
  console.log(`PASS stale-data detection and refresh recovery; ${checks} HTTP checks passed`);
} finally {
  for (const cleanup of cleanups.reverse()) cleanup();
  queryClient.clear();
  if (handle) await stopNayaroServer(handle);
  rmSync(root, { recursive: true, force: true });
}
