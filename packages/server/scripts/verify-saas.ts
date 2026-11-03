/**
 * Hosted-platform guarantees: token verification on every request, tenant
 * lifecycle enforcement, and isolation between restaurants.
 *
 *   npm test
 *
 * Runs against a disposable database and its own server instance.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { io as connectSocket, type Socket } from 'socket.io-client';
import type {
  AuditLogResponse,
  DailyReportResponse,
  InvoiceDto,
  ManagedMenuResponse,
  MenuResponse,
  OrderDto,
  StaffListResponse,
} from '@nayaro/shared';
import { startNayaroServer, stopNayaroServer, type NayaroServerHandle } from '../src/server';
import { createLogger } from '../src/utils/logger';
import { setTenantStatus } from '../src/modules/tenant/tenant.service';
import { resolveBusinessDate } from '../src/utils/businessDate';

const WEB_ORIGIN = 'https://app.example.test';
const root = mkdtempSync(join(tmpdir(), 'nayaro-saas-'));
let handle: NayaroServerHandle | undefined;
let checks = 0;

interface Reply<T> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
}

async function call<T = unknown>(
  method: string,
  path: string,
  options: { token?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Reply<T>> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token !== undefined) headers['Authorization'] = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${handle!.baseUrl}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: (text.length > 0 ? JSON.parse(text) : null) as T,
    headers: response.headers,
  };
}

function expectStatus(reply: Reply<unknown>, status: number, label: string): void {
  checks += 1;
  assert.equal(reply.status, status, `${label}: ${JSON.stringify(reply.body)}`);
}

function errorCode(reply: Reply<unknown>): string | undefined {
  return (reply.body as { error?: { code?: string } } | null)?.error?.code;
}

const PASSWORD = 'correct-horse-battery';

async function registerRestaurant(workspace: string, name: string): Promise<string> {
  const reply = await call('POST', '/tenants/register', {
    body: {
      restaurant: { slug: workspace, name },
      owner: { name: `${name} Owner`, username: 'owner', password: PASSWORD },
    },
  });
  expectStatus(reply, 201, `register ${workspace}`);
  return (reply.body as { restaurantId: string }).restaurantId;
}

async function signIn(workspace: string, username: string, password = PASSWORD): Promise<string> {
  const reply = await call<{ token: string }>('POST', '/auth/login', {
    body: { workspace, username, password },
  });
  expectStatus(reply, 200, `sign in ${workspace}/${username}`);
  return reply.body.token;
}

interface RestaurantFixture {
  readonly restaurantId: string;
  readonly owner: string;
  readonly cashier: string;
  readonly waiter: string;
  readonly categoryId: string;
  readonly itemId: string;
  readonly tableId: string;
  readonly order: OrderDto;
  readonly invoice: InvoiceDto;
  readonly cashierStaffId: string;
}

async function buildRestaurant(workspace: string, name: string): Promise<RestaurantFixture> {
  const restaurantId = await registerRestaurant(workspace, name);
  const owner = await signIn(workspace, 'owner');

  for (const [username, role] of [
    ['cashier', 'CASHIER'],
    ['waiter', 'WAITER'],
  ] as const) {
    expectStatus(
      await call('POST', '/management/staff', {
        token: owner,
        body: { name: `${name} ${role}`, username, password: PASSWORD, role },
      }),
      201,
      `create ${role}`,
    );
  }
  const staff = await call<StaffListResponse>('GET', '/management/staff', { token: owner });
  const cashierStaffId = staff.body.staff.find((row) => row.username === 'cashier')!.id;

  let menu = await call<ManagedMenuResponse>('POST', '/management/menu/categories', {
    token: owner,
    body: { name: `${name} Mains` },
  });
  const categoryId = menu.body.categories[0]!.id;
  menu = await call<ManagedMenuResponse>('POST', '/management/menu/items', {
    token: owner,
    body: { categoryId, name: `${name} Momo`, pricePaisa: 25000 },
  });
  const itemId = menu.body.categories[0]!.items[0]!.id;

  const area = await call<{ areas: { id: string }[] }>('POST', '/floor/areas', {
    token: owner,
    body: { name: 'Main hall' },
  });
  const areaId = area.body.areas[0]!.id;
  const floor = await call<{ areas: { tables: { id: string }[] }[] }>('POST', '/floor/tables', {
    token: owner,
    body: { areaId, name: 'T1' },
  });
  const tableId = floor.body.areas[0]!.tables[0]!.id;

  const cashier = await signIn(workspace, 'cashier');
  const waiter = await signIn(workspace, 'waiter');

  let order = (
    await call<{ order: OrderDto }>('POST', '/orders/items', {
      token: cashier,
      body: { target: { kind: 'TABLE', tableId }, menuItemId: itemId, quantity: 2 },
    })
  ).body.order;
  order = (
    await call<{ order: OrderDto }>('POST', `/orders/${order.id}/send-kot`, {
      token: cashier,
      body: { expectedVersion: order.version },
    })
  ).body.order;
  const invoiceReply = await call<{ invoice: InvoiceDto }>('POST', `/orders/${order.id}/invoice`, {
    token: cashier,
    body: { expectedVersion: order.version },
  });
  expectStatus(invoiceReply, 201, `${workspace} issues an invoice`);
  const invoice = invoiceReply.body.invoice;
  const current = await call<{ order: OrderDto }>('GET', `/orders/${order.id}`, { token: cashier });
  const paid = await call('POST', `/invoices/${invoice.id}/payments`, {
    token: cashier,
    body: { expectedOrderVersion: current.body.order.version, method: 'QR', amountPaisa: invoice.grandTotalPaisa },
  });
  expectStatus(paid, 201, `${workspace} takes payment`);

  return {
    restaurantId,
    owner,
    cashier,
    waiter,
    categoryId,
    itemId,
    tableId,
    order,
    invoice,
    cashierStaffId,
  };
}

async function verifyAuthentication(a: RestaurantFixture): Promise<void> {
  console.log('[auth] the backend verifies every token');

  const missing = await call('GET', '/auth/me');
  expectStatus(missing, 401, 'missing token');

  const injected = await call('GET', '/auth/me', { token: 'some-random-value' });
  expectStatus(injected, 401, 'manually injected random token');

  const wellFormed = randomBytes(32).toString('base64url');
  expectStatus(await call('GET', '/auth/me', { token: wellFormed }), 401, 'well-formed forged token');
  expectStatus(
    await call('GET', '/menu', { headers: { Authorization: `Basic ${a.owner}` } }),
    401,
    'valid token under the wrong scheme',
  );
  expectStatus(
    await call('GET', '/auth/me', { token: 'x'.repeat(5000) }),
    401,
    'oversized token',
  );

  const valid = await call<{ staff: { role: string }; tenant: { workspace: string } }>(
    'GET',
    '/auth/me',
    { token: a.owner },
  );
  expectStatus(valid, 200, 'valid token');
  assert.equal(valid.body.tenant.workspace, 'alpha-kitchen');
  assert.equal(valid.body.staff.role, 'OWNER');

  // A genuine token pasted by hand is just as valid - the header is what counts.
  const manual = await fetch(`${handle!.baseUrl}/auth/me`, {
    headers: { authorization: `bearer ${a.owner}` },
  });
  checks += 1;
  assert.equal(manual.status, 200, 'a genuine token supplied manually works');

  expectStatus(
    await call('POST', '/auth/login', {
      body: { workspace: 'alpha-kitchen', username: 'owner', password: 'wrong-password' },
    }),
    401,
    'wrong password',
  );
  const unknownWorkspace = await call('POST', '/auth/login', {
    body: { workspace: 'no-such-place', username: 'owner', password: PASSWORD },
  });
  expectStatus(unknownWorkspace, 401, 'unknown workspace');
  assert.equal(errorCode(unknownWorkspace), 'INVALID_CREDENTIALS', 'no workspace oracle');

  console.log('[auth] expiry');
  const expiring = await signIn('alpha-kitchen', 'waiter');
  await handle!.prisma.session.updateMany({
    where: { restaurantId: a.restaurantId, revokedAt: null, staff: { username: 'waiter' } },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  expectStatus(await call('GET', '/auth/me', { token: expiring }), 401, 'expired token');

  console.log('[auth] revocation');
  const revoked = await signIn('alpha-kitchen', 'owner');
  expectStatus(await call('POST', '/auth/logout', { token: revoked }), 204, 'logout');
  expectStatus(await call('GET', '/auth/me', { token: revoked }), 401, 'token after logout');

  const remote = await signIn('alpha-kitchen', 'cashier');
  const sessions = await call<{ sessions: { id: string; staff: { username: string } }[] }>(
    'GET',
    '/auth/sessions',
    { token: a.owner },
  );
  // Most recently used first, so the first cashier row is the session just issued.
  const target = sessions.body.sessions.find((row) => row.staff.username === 'cashier')!;
  expectStatus(
    await call('DELETE', `/auth/sessions/${target.id}`, { token: a.owner }),
    204,
    'owner signs a device out',
  );
  expectStatus(await call('GET', '/auth/me', { token: remote }), 401, 'remotely revoked token');

  console.log('[auth] role permissions');
  const cashier = await signIn('alpha-kitchen', 'cashier');
  const waiter = await signIn('alpha-kitchen', 'waiter');
  expectStatus(await call('GET', '/management/staff', { token: cashier }), 403, 'cashier -> staff');
  expectStatus(await call('GET', '/reports/daily', { token: waiter }), 403, 'waiter -> reports');
  expectStatus(
    await call('PATCH', '/management/settings/financial', { token: cashier, body: { vatEnabled: true } }),
    403,
    'cashier -> tax settings',
  );
  expectStatus(await call('GET', '/audit-log', { token: cashier }), 403, 'cashier -> audit log');

  console.log('[auth] disabled user');
  expectStatus(
    await call('PATCH', `/management/staff/${a.cashierStaffId}`, {
      token: a.owner,
      body: { isActive: false },
    }),
    200,
    'owner disables cashier',
  );
  expectStatus(await call('GET', '/auth/me', { token: cashier }), 401, 'disabled user token');
  expectStatus(
    await call('POST', '/auth/login', {
      body: { workspace: 'alpha-kitchen', username: 'cashier', password: PASSWORD },
    }),
    401,
    'disabled user cannot sign in',
  );
  expectStatus(
    await call('PATCH', `/management/staff/${a.cashierStaffId}`, {
      token: a.owner,
      body: { isActive: true },
    }),
    200,
    'owner re-enables cashier',
  );
}

async function verifyTenantLifecycle(a: RestaurantFixture): Promise<void> {
  console.log('[tenant] suspension and expiry apply to live sessions');
  const live = await signIn('alpha-kitchen', 'owner');

  await setTenantStatus(handle!.prisma, 'alpha-kitchen', { status: 'SUSPENDED', reason: 'test' });
  const suspended = await call('GET', '/menu', { token: live });
  expectStatus(suspended, 403, 'suspended tenant, existing token');
  assert.equal(errorCode(suspended), 'TENANT_SUSPENDED');
  const suspendedLogin = await call('POST', '/auth/login', {
    body: { workspace: 'alpha-kitchen', username: 'owner', password: PASSWORD },
  });
  expectStatus(suspendedLogin, 403, 'suspended tenant, correct password');
  const wrongWhileSuspended = await call('POST', '/auth/login', {
    body: { workspace: 'alpha-kitchen', username: 'owner', password: 'wrong-password' },
  });
  expectStatus(wrongWhileSuspended, 401, 'suspension is not revealed to a guesser');
  expectStatus(
    await call('GET', '/public/menu?workspace=alpha-kitchen'),
    404,
    'suspended tenant has no public menu',
  );

  await setTenantStatus(handle!.prisma, 'alpha-kitchen', {
    status: 'TRIAL',
    subscriptionEndsAt: new Date(Date.now() - 60_000),
  });
  const expired = await call('GET', '/menu', { token: live });
  expectStatus(expired, 403, 'expired subscription');
  assert.equal(errorCode(expired), 'SUBSCRIPTION_EXPIRED');

  await setTenantStatus(handle!.prisma, 'alpha-kitchen', {
    status: 'ACTIVE',
    subscriptionEndsAt: null,
  });
  expectStatus(await call('GET', '/menu', { token: live }), 200, 'reactivated tenant');
  void a;
}

async function verifyIsolation(a: RestaurantFixture, b: RestaurantFixture): Promise<void> {
  console.log('[isolation] restaurant A cannot reach restaurant B');

  const menuA = await call<MenuResponse>('GET', '/menu', { token: a.owner });
  const itemIdsA = menuA.body.categories.flatMap((category) => category.items.map((item) => item.id));
  checks += 1;
  assert.ok(itemIdsA.includes(a.itemId) && !itemIdsA.includes(b.itemId), 'menu lists only own products');

  expectStatus(
    await call('PATCH', `/management/menu/items/${b.itemId}`, {
      token: a.owner,
      body: { pricePaisa: 1 },
    }),
    404,
    'A edits B product',
  );
  expectStatus(
    await call('PATCH', `/management/menu/categories/${b.categoryId}`, {
      token: a.owner,
      body: { name: 'Hijacked' },
    }),
    404,
    'A edits B category',
  );
  expectStatus(await call('GET', `/orders/${b.order.id}`, { token: a.owner }), 404, 'A reads B order');
  expectStatus(
    await call('GET', `/orders/${b.order.id}/billing`, { token: a.owner }),
    404,
    'A reads B bill',
  );
  expectStatus(
    await call('POST', `/invoices/${b.invoice.id}/void`, {
      token: a.owner,
      body: { reason: 'Attempted cross-tenant void' },
    }),
    404,
    'A voids B invoice',
  );
  expectStatus(
    await call('POST', `/invoices/${b.invoice.id}/prints`, { token: a.owner, body: {} }),
    404,
    'A reprints B invoice',
  );
  expectStatus(
    await call('POST', '/orders/items', {
      token: a.cashier,
      body: { target: { kind: 'TABLE', tableId: b.tableId }, menuItemId: a.itemId, quantity: 1 },
    }),
    404,
    'A orders onto B table',
  );
  expectStatus(
    await call('POST', '/orders/items', {
      token: a.cashier,
      body: { target: { kind: 'TABLE', tableId: a.tableId }, menuItemId: b.itemId, quantity: 1 },
    }),
    404,
    'A sells B product',
  );

  const invoicesA = await call<{ invoices: { id: string }[] }>('GET', '/invoices', { token: a.owner });
  checks += 1;
  assert.ok(
    !JSON.stringify(invoicesA.body).includes(b.invoice.id),
    'invoice history lists only own bills',
  );

  const reportA = await call<DailyReportResponse>(
    'GET',
    `/reports/daily?date=${a.invoice.businessDate}`,
    { token: a.owner },
  );
  expectStatus(reportA, 200, 'A report');
  assert.equal(reportA.body.sales.invoiceCount, 1, 'A report counts only A sales');
  assert.equal(reportA.body.sales.grandTotalPaisa, a.invoice.grandTotalPaisa);

  const staffA = await call<StaffListResponse>('GET', '/management/staff', { token: a.owner });
  checks += 1;
  assert.ok(
    staffA.body.staff.every((row) => row.name.startsWith('Alpha')),
    'staff list contains only own staff',
  );
  expectStatus(
    await call('PATCH', `/management/staff/${b.cashierStaffId}`, {
      token: a.owner,
      body: { isActive: false },
    }),
    404,
    'A disables B staff',
  );
  expectStatus(
    await call('POST', `/management/staff/${b.cashierStaffId}/password`, {
      token: a.owner,
      body: { newPassword: 'taken-over-123' },
    }),
    404,
    'A resets B password',
  );

  const audit = await call<AuditLogResponse>('GET', '/audit-log', { token: a.owner });
  expectStatus(audit, 200, 'A audit log');
  checks += 1;
  assert.ok(
    audit.body.entries.every((entry) => entry.staff === null || entry.staff.name.startsWith('Alpha')),
    'audit log contains only own events',
  );
  assert.ok(audit.body.entries.some((entry) => entry.action === 'AUTH_LOGIN'), 'sign-ins are audited');

  const sessionsA = await call<{ sessions: { id: string; staff: { name: string } }[] }>(
    'GET',
    '/auth/sessions',
    { token: a.owner },
  );
  checks += 1;
  assert.ok(sessionsA.body.sessions.every((row) => row.staff.name.startsWith('Alpha')));
  const sessionsB = await call<{ sessions: { id: string }[] }>('GET', '/auth/sessions', {
    token: b.owner,
  });
  expectStatus(
    await call('DELETE', `/auth/sessions/${sessionsB.body.sessions[0]!.id}`, { token: a.owner }),
    404,
    'A signs out a B device',
  );

  console.log('[isolation] client-supplied tenant ids are ignored');
  const smuggled = await call<ManagedMenuResponse>('POST', '/management/menu/categories', {
    token: a.owner,
    body: { name: 'Smuggled', restaurantId: b.restaurantId },
  });
  checks += 1;
  assert.ok(smuggled.status === 201 || smuggled.status === 400, 'extra field is not honoured');
  const bCategories = await handle!.prisma.menuCategory.count({
    where: { restaurantId: b.restaurantId, name: 'Smuggled' },
  });
  assert.equal(bCategories, 0, 'nothing was written into B');
  const viaQuery = await call<MenuResponse>(`GET`, `/menu?restaurantId=${b.restaurantId}`, {
    token: a.owner,
  });
  checks += 1;
  assert.ok(
    !JSON.stringify(viaQuery.body).includes(b.itemId),
    'restaurantId query parameter is ignored',
  );
  const viaHeader = await call<MenuResponse>('GET', '/menu', {
    token: a.owner,
    headers: { 'X-Restaurant-Id': b.restaurantId, 'X-Tenant-Id': b.restaurantId },
  });
  checks += 1;
  assert.ok(!JSON.stringify(viaHeader.body).includes(b.itemId), 'tenant headers are ignored');

  console.log('[isolation] realtime events stay inside their restaurant');
  const heard: string[] = [];
  const socketB: Socket = connectSocket(handle!.baseUrl, {
    auth: { token: b.owner },
    transports: ['websocket'],
    extraHeaders: { Origin: WEB_ORIGIN },
  });
  await new Promise<void>((resolve, reject) => {
    socketB.on('connect', () => resolve());
    socketB.on('connect_error', reject);
  });
  socketB.onAny((event: string) => heard.push(event));
  await call('POST', '/orders/items', {
    token: a.cashier,
    body: { target: { kind: 'TAKEAWAY' }, menuItemId: a.itemId, quantity: 1 },
  });
  await new Promise((resolve) => setTimeout(resolve, 300));
  socketB.disconnect();
  checks += 1;
  assert.deepEqual(heard, [], 'B heard none of A’s events');

  const forged: Socket = connectSocket(handle!.baseUrl, {
    auth: { token: 'forged' },
    transports: ['websocket'],
    reconnection: false,
  });
  const refused = await new Promise<boolean>((resolve) => {
    forged.on('connect', () => resolve(false));
    forged.on('connect_error', () => resolve(true));
  });
  forged.disconnect();
  checks += 1;
  assert.ok(refused, 'socket with forged token is refused');
}

async function verifyRegistrationAndHeaders(): Promise<void> {
  console.log('[platform] registration rules, headers and CORS');
  const duplicate = await call('POST', '/tenants/register', {
    body: {
      restaurant: { slug: 'alpha-kitchen', name: 'Copycat' },
      owner: { name: 'X', username: 'owner', password: PASSWORD },
    },
  });
  expectStatus(duplicate, 409, 'duplicate workspace');
  expectStatus(
    await call('POST', '/tenants/register', {
      body: {
        restaurant: { slug: 'admin', name: 'Reserved' },
        owner: { name: 'X', username: 'owner', password: PASSWORD },
      },
    }),
    400,
    'reserved workspace',
  );
  expectStatus(
    await call('POST', '/tenants/register', {
      body: {
        restaurant: { slug: 'weak-pass', name: 'Weak' },
        owner: { name: 'X', username: 'owner', password: 'short' },
      },
    }),
    400,
    'weak password',
  );

  const lookup = await call<{ name: string }>('GET', '/tenants/lookup?workspace=alpha-kitchen');
  expectStatus(lookup, 200, 'workspace lookup');
  assert.equal(lookup.body.name, 'Alpha Kitchen');

  const headers = (await call('GET', '/health')).headers;
  checks += 1;
  assert.equal(headers.get('x-content-type-options'), 'nosniff');
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.match(headers.get('content-security-policy') ?? '', /default-src 'none'/);
  assert.equal(headers.get('x-powered-by'), null);

  const allowed = await call('GET', '/health', { headers: { Origin: WEB_ORIGIN } });
  const blocked = await call('GET', '/health', { headers: { Origin: 'https://evil.example' } });
  checks += 1;
  assert.equal(allowed.headers.get('access-control-allow-origin'), WEB_ORIGIN);
  assert.equal(blocked.headers.get('access-control-allow-origin'), null);
  assert.equal(allowed.headers.get('access-control-allow-credentials'), null);

  console.log('[platform] sign-in throttling');
  let throttled: Reply<unknown> | undefined;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    throttled = await call('POST', '/auth/login', {
      body: { workspace: 'beta-bistro', username: 'owner', password: 'guess-guess-guess' },
    });
  }
  expectStatus(throttled!, 429, 'repeated failures are throttled');
  checks += 1;
  assert.ok(throttled!.headers.get('retry-after'), 'Retry-After is sent');
}

function verifyBusinessDates(): void {
  console.log('[time] business days follow each restaurant’s own time zone');
  // 19:30 UTC is 01:15 the next day in Kathmandu: before a 04:00 day start, so
  // it still belongs to the previous business day there.
  const lateNight = new Date('2026-11-02T19:30:00Z');
  checks += 3;
  assert.equal(resolveBusinessDate(lateNight, 240, 'Asia/Kathmandu'), '2026-11-02');
  assert.equal(resolveBusinessDate(new Date('2026-11-02T23:00:00Z'), 240, 'Asia/Kathmandu'), '2026-11-03');
  assert.equal(resolveBusinessDate(lateNight, 240, 'America/New_York'), '2026-11-02');
}

try {
  verifyBusinessDates();
  handle = await startNayaroServer({
    allowDirectRegistration: true,
    port: 0,
    host: '127.0.0.1',
    databaseFilePath: join(root, 'saas.db'),
    webOrigins: [WEB_ORIGIN],
    registrationsPerHour: 50,
    logger: createLogger({ scope: 'verify-saas', silent: true }),
  });

  const a = await buildRestaurant('alpha-kitchen', 'Alpha Kitchen');
  const b = await buildRestaurant('beta-bistro', 'Beta Bistro');

  await verifyIsolation(a, b);
  await verifyAuthentication(a);
  await verifyTenantLifecycle(a);
  await verifyRegistrationAndHeaders();

  console.log(`PASS: ${String(checks)} checks - authentication, tenant lifecycle, isolation, headers.`);
} finally {
  if (handle) await stopNayaroServer(handle);
  rmSync(root, { recursive: true, force: true });
}
