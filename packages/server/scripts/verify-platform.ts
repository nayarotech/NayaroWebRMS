/** Nayaro console: separate admin accounts, analytics, account actions and read-only support views. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  LoginResponse,
  MeResponse,
  PlatformImpersonationResponse,
  PlatformLoginResponse,
  PlatformOverview,
  PlatformTenantDetail,
  PlatformTenantsResponse,
} from '@nayaro/shared';
import { ensureDataLayout, resolveDataLayout } from '@nayaro/database';
import { startNayaroServer, stopNayaroServer } from '../src/server';
import { upsertPlatformAdmin } from '../src/modules/platform/platform.auth';

const root = mkdtempSync(join(tmpdir(), 'nayaro-platform-'));
const layout = ensureDataLayout(resolveDataLayout(root));
let handle: Awaited<ReturnType<typeof startNayaroServer>> | undefined;
let checks = 0;

async function call<T>(method: string, path: string, status: number, token?: string, body?: unknown): Promise<T> {
  const response = await fetch(`${handle!.baseUrl}${path}`, {
    method,
    headers: {
      Connection: 'close',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.equal(response.status, status, `${method} ${path}: ${text}`);
  checks++;
  return (text ? JSON.parse(text) : undefined) as T;
}

try {
  handle = await startNayaroServer({
    allowDirectRegistration: true,
    host: '127.0.0.1',
    port: 0,
    databaseFilePath: layout.databaseFilePath,
    silent: true,
  });
  await upsertPlatformAdmin(handle.prisma, { email: 'Ops@Nayaro.tech', name: 'Raghav', password: 'console-test-password' });

  for (const slug of ['momo-house', 'thakali-kitchen']) {
    await call('POST', '/tenants/register', 201, undefined, {
      restaurant: { slug, name: slug.replace('-', ' ') },
      owner: { name: `Owner ${slug}`, username: 'owner', password: 'tenant-test-password' },
    });
  }
  const owner = await call<LoginResponse>('POST', '/auth/login', 200, undefined, {
    workspace: 'momo-house',
    username: 'owner',
    password: 'tenant-test-password',
  });

  // The console is closed to everyone but platform admins.
  await call('GET', '/platform/overview', 401);
  await call('GET', '/platform/overview', 401, owner.token, undefined);
  await call('POST', '/platform/auth/login', 401, undefined, { email: 'ops@nayaro.tech', password: 'wrong-password' });
  await call('POST', '/platform/auth/login', 401, undefined, { email: 'owner@momo.com', password: 'tenant-test-password' });
  const admin = await call<PlatformLoginResponse>('POST', '/platform/auth/login', 200, undefined, {
    email: 'OPS@nayaro.tech',
    password: 'console-test-password',
  });
  assert.equal(admin.admin.name, 'Raghav');
  // ...and a console token is not a restaurant session.
  await call('GET', '/auth/me', 401, admin.token);

  // Analytics.
  const overview = await call<PlatformOverview>('GET', '/platform/overview', 200, admin.token);
  assert.equal(overview.tenants.total, 2);
  assert.equal(overview.tenants.trial, 2);
  assert.equal(overview.tenants.newThisWeek, 2);
  assert.equal(overview.signupsPerDay.length, 30);
  assert.equal(overview.signupsPerDay.at(-1)!.value, 2);
  assert.ok(overview.onlineNow.people >= 1, 'the signed-in owner counts as online');
  assert.ok(overview.recentActivity.some((entry) => entry.action === 'TENANT_REGISTERED'));
  checks += 6;

  const { tenants } = await call<PlatformTenantsResponse>('GET', '/platform/tenants', 200, admin.token);
  const momo = tenants.find((row) => row.workspace === 'momo-house')!;
  assert.equal(momo.owner?.name, 'Owner momo-house');
  assert.equal(momo.daysLeft, 14);
  assert.equal(momo.onlineNow, 1);
  checks += 3;

  let detail = await call<PlatformTenantDetail>('GET', `/platform/tenants/${momo.id}`, 200, admin.token);
  assert.equal(detail.staff.length, 1);
  assert.equal(detail.salesPerDay.length, 30);
  assert.ok(detail.sessions.length >= 1);
  checks += 3;

  // Account actions, each recorded in the restaurant's own log.
  detail = await call<PlatformTenantDetail>('POST', `/platform/tenants/${momo.id}/actions`, 200, admin.token, {
    action: 'extend',
    days: 7,
  });
  assert.equal(detail.tenant.daysLeft, 21);
  assert.ok(detail.activity.some((entry) => entry.action === 'PLATFORM_ACCOUNT_CHANGED' && entry.summary.includes('Raghav')));
  checks += 2;
  await call('POST', `/platform/tenants/${momo.id}/actions`, 400, admin.token, { action: 'suspend', reason: '' });
  await call('POST', `/platform/tenants/${momo.id}/actions`, 200, admin.token, { action: 'suspend', reason: 'Test suspension' });
  await call('GET', '/floor', 403, owner.token);
  await call('POST', `/platform/tenants/${momo.id}/actions`, 200, admin.token, { action: 'reactivate' });
  await call('GET', '/floor', 200, owner.token);
  detail = await call<PlatformTenantDetail>('POST', `/platform/tenants/${momo.id}/actions`, 200, admin.token, {
    action: 'activate',
    until: null,
  });
  assert.equal(detail.tenant.status, 'ACTIVE');
  assert.equal(detail.tenant.daysLeft, null);
  checks += 2;
  // "Extend" must never give an end date to an account that has none.
  await call('POST', `/platform/tenants/${momo.id}/actions`, 409, admin.token, { action: 'extend', days: 7 });

  // Support view: read-only, short-lived, and visible to the restaurant.
  const view = await call<PlatformImpersonationResponse>(
    'POST',
    `/platform/tenants/${momo.id}/support-view`,
    201,
    admin.token,
  );
  assert.equal(view.staff.role, 'OWNER');
  assert.equal(view.tenant.workspace, 'momo-house');
  const minutes = (Date.parse(view.impersonation.expiresAt) - Date.now()) / 60_000;
  assert.ok(minutes > 55 && minutes <= 60, 'one hour');
  checks += 3;
  const me = await call<MeResponse>('GET', '/auth/me', 200, view.token);
  assert.equal(me.impersonation?.adminName, 'Raghav');
  await call('GET', '/floor', 200, view.token);
  const refused = await call<{ error: { code: string } }>('POST', '/floor/areas', 403, view.token, { name: 'Terrace' });
  assert.equal(refused.error.code, 'READ_ONLY_SUPPORT_VIEW');
  await call('PATCH', '/settings', 403, view.token, {});
  const ownerAudit = await call<{ entries?: { action: string }[] } | { action: string }[]>('GET', '/audit-log', 200, owner.token);
  assert.ok(JSON.stringify(ownerAudit).includes('SUPPORT_VIEW_STARTED'), 'the owner can see Nayaro looked');
  const session = await handle.prisma.session.findFirstOrThrow({ where: { impersonatedByAdminId: { not: null } } });
  assert.equal(session.expiresAt.toISOString(), view.impersonation.expiresAt, 'activity never extends a support view');
  checks += 4;
  await call('POST', '/auth/logout', 204, view.token);
  await call('GET', '/auth/me', 401, view.token);
  // The owner's own session is untouched by the support view ending.
  await call('GET', '/auth/me', 200, owner.token);

  // Support views are not counted as the restaurant being active or online.
  const after = await call<PlatformTenantsResponse>('GET', '/platform/tenants', 200, admin.token);
  assert.equal(after.tenants.find((row) => row.id === momo.id)!.onlineNow, 1);
  checks++;

  // Unfinished sign-ups, without exposing the parked password hash.
  await call('POST', '/tenants/register/start', 202, undefined, {
    restaurant: { slug: 'late-cafe', name: 'Late Cafe' },
    owner: { name: 'Late Owner', email: 'late@example.com', username: 'late', password: 'late-cafe-password' },
  });
  const signups = await call<{ signups: Record<string, unknown>[] }>('GET', '/platform/signups', 200, admin.token);
  assert.equal(signups.signups[0]!['restaurantName'], 'Late Cafe');
  assert.ok(!JSON.stringify(signups).includes('scrypt'), 'no password hash leaves the server');
  checks += 2;

  const page = await call<{ entries: unknown[]; nextBefore: string | null }>('GET', '/platform/activity', 200, admin.token);
  assert.ok(page.entries.length > 0);
  checks++;

  await call('POST', '/platform/auth/logout', 204, admin.token);
  await call('GET', '/platform/overview', 401, admin.token);

  console.log(`PASS: ${String(checks)} checks - console access, analytics, account actions, read-only support view.`);
} finally {
  if (handle) await stopNayaroServer(handle);
  rmSync(root, { recursive: true, force: true });
}
