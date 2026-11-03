/** Extra service duties, exercised through HTTP against a disposable database. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hasServicePermission,
  type LoginResponse,
  type MeResponse,
  type OrderResponse,
  type SendToKitchenResponse,
  type StaffListResponse,
  type StaffRole,
} from '@nayaro/shared';
import { ensureDataLayout, resolveDataLayout } from '@nayaro/database';
import { startNayaroServer, stopNayaroServer } from '../src/server';

const root = mkdtempSync(join(tmpdir(), 'nayaro-service-duties-'));
const layout = ensureDataLayout(resolveDataLayout(root));
const options = {
  allowDirectRegistration: true,
  host: '127.0.0.1',
  port: 4340,
  databaseFilePath: layout.databaseFilePath,
  silent: true,
};
let handle: Awaited<ReturnType<typeof startNayaroServer>> | undefined;
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

const password = 'service-duties-test-password';
const signIn = (username: string) =>
  call<LoginResponse>('POST', '/auth/login', 200, undefined, { workspace: 'verify-restaurant', username, password });

try {
  handle = await startNayaroServer(options);
  await call('POST', '/tenants/register', 201, undefined, {
    restaurant: { slug: 'verify-restaurant', name: 'One computer restaurant' },
    owner: { name: 'Owner', username: 'owner', password },
  });
  const owner = await signIn('owner');
  const roles: StaffRole[] = ['MANAGER', 'CASHIER', 'WAITER', 'KITCHEN'];
  const accounts = new Map<StaffRole, LoginResponse>([['OWNER', owner]]);
  for (const role of roles) {
    await call('POST', '/management/staff', 201, owner.token, {
      name: role,
      username: role.toLowerCase(),
      password,
      role,
    });
    accounts.set(role, await signIn(role.toLowerCase()));
  }

  // Old accounts retain their role presets after the migration.
  for (const [role, account] of accounts) {
    assert.equal(account.staff.canTakeOrders, false);
    assert.equal(account.staff.canManageKitchen, false);
    await call('GET', '/floor', role === 'KITCHEN' ? 403 : 200, account.token);
    await call('GET', '/menu', role === 'KITCHEN' ? 403 : 200, account.token);
    // An authorized caller reaches the missing-ticket check; others stop at 403.
    await call(
      'PATCH',
      '/kitchen/tickets/missing/status',
      ['OWNER', 'MANAGER', 'KITCHEN'].includes(role) ? 404 : 403,
      account.token,
      { status: 'PREPARING' },
    );
  }
  console.log('PASS role presets preserved');

  const waiterId = accounts.get('WAITER')!.staff.id;
  const cookId = accounts.get('KITCHEN')!.staff.id;
  const cashierId = accounts.get('CASHIER')!.staff.id;
  await call('PATCH', `/management/staff/${waiterId}`, 403, accounts.get('WAITER')!.token, {
    canManageKitchen: true,
  });
  await call('PATCH', `/management/staff/${owner.staff.id}`, 403, accounts.get('MANAGER')!.token, {
    canManageKitchen: true,
  });
  await call('PATCH', `/management/staff/${waiterId}`, 400, owner.token, {
    canManageKitchen: 'true',
  });
  await call('PATCH', `/management/staff/${waiterId}`, 200, owner.token, {
    canManageKitchen: true,
  });
  await call('GET', '/auth/me', 401, accounts.get('WAITER')!.token);
  const waiter = await signIn('waiter');
  assert.equal(waiter.staff.canManageKitchen, true);
  assert.equal(hasServicePermission(waiter.staff, 'MANAGE_KITCHEN'), true);
  const me = await call<MeResponse>('GET', '/auth/me', 200, waiter.token);
  assert.equal(me.staff.canManageKitchen, true);

  await call('PATCH', `/management/staff/${cookId}`, 200, owner.token, { canTakeOrders: true });
  const cook = await signIn('kitchen');
  await call('GET', '/floor', 200, cook.token);
  await call('GET', '/menu', 200, cook.token);
  await call('PATCH', `/management/staff/${cashierId}`, 200, owner.token, {
    canManageKitchen: true,
  });
  const cashier = await signIn('cashier');
  console.log('PASS extra duties, validation, and session refresh');

  // Seed only the catalogue. All order creation and ticket changes use HTTP.
  const category = await handle.prisma.menuCategory.create({
    data: { restaurantId: owner.staff.restaurantId, name: 'Food' },
  });
  const item = await handle.prisma.menuItem.create({
    data: {
      restaurantId: owner.staff.restaurantId,
      categoryId: category.id,
      name: 'Momo',
      pricePaisa: 22000,
    },
  });
  const { order } = await call<OrderResponse>('POST', '/orders/items', 201, cook.token, {
    target: { kind: 'TAKEAWAY' },
    menuItemId: item.id,
  });
  const dispatched = await call<SendToKitchenResponse>(
    'POST',
    `/orders/${order.id}/send-kot`,
    201,
    cook.token,
    { expectedVersion: order.version },
  );
  await call('PATCH', `/kitchen/tickets/${dispatched.kot.id}/status`, 200, waiter.token, {
    status: 'PREPARING',
  });
  await call('PATCH', `/kitchen/tickets/${dispatched.kot.id}/status`, 200, cashier.token, {
    status: 'READY',
  });
  await call('PATCH', `/kitchen/tickets/${dispatched.kot.id}/status`, 200, cook.token, {
    status: 'SERVED',
  });
  console.log('PASS cook takes order; waiter, cashier, and cook advance the ticket');

  for (const account of [waiter, cook]) {
    await call('POST', `/orders/${order.id}/invoice`, 403, account.token, {});
    await call('POST', '/invoices/missing/payments', 403, account.token, {});
    await call('PATCH', `/orders/${order.id}/discount`, 403, account.token, {});
    await call('POST', `/kitchen/tickets/${dispatched.kot.id}/void`, 403, account.token, {
      reason: 'Not allowed',
    });
    await call('GET', '/management/staff', 403, account.token);
    await call('POST', '/floor/areas', 403, account.token, { name: 'Not allowed' });
  }
  console.log('PASS service duties do not grant financial, correction, or management access');

  await call('PATCH', `/management/staff/${waiterId}`, 200, owner.token, {
    canManageKitchen: false,
  });
  await call('PATCH', `/kitchen/tickets/${dispatched.kot.id}/status`, 401, waiter.token, {
    status: 'READY',
  });
  const revoked = await signIn('waiter');
  await call('PATCH', `/kitchen/tickets/${dispatched.kot.id}/status`, 403, revoked.token, {
    status: 'READY',
  });
  await call('PATCH', `/management/staff/${cookId}`, 200, owner.token, { canTakeOrders: false });
  await call('GET', '/menu', 401, cook.token);
  const kitchenOnly = await signIn('kitchen');
  await call('GET', '/menu', 403, kitchenOnly.token);

  // New staff can receive combined duties at creation, and retain them on restart.
  const created = await call<StaffListResponse>('POST', '/management/staff', 201, owner.token, {
    name: 'Combined',
    username: 'combined',
    password,
    role: 'WAITER',
    canManageKitchen: true,
  });
  assert.equal(created.staff.find((s) => s.username === 'combined')?.canManageKitchen, true);
  await stopNayaroServer(handle);
  handle = undefined;
  handle = await startNayaroServer(options);
  const combined = await signIn('combined');
  assert.equal(combined.staff.canManageKitchen, true);
  await call('PATCH', '/kitchen/tickets/missing/status', 404, combined.token, {
    status: 'PREPARING',
  });
  console.log(`PASS removal and persistence; ${checks} HTTP checks passed`);
} finally {
  if (handle) await stopNayaroServer(handle);
  rmSync(root, { recursive: true, force: true });
}
