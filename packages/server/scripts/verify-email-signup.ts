/** Verified sign-up: emailed codes, attempt limits, and signing in by email or username. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoginResponse } from '@nayaro/shared';
import { createPrismaClient, ensureDataLayout, resolveDataLayout } from '@nayaro/database';
import { startNayaroServer, stopNayaroServer } from '../src/server';
import type { Mailer, OutgoingEmail } from '../src/modules/email/mailer';

const root = mkdtempSync(join(tmpdir(), 'nayaro-email-signup-'));
const layout = ensureDataLayout(resolveDataLayout(root));
let handle: Awaited<ReturnType<typeof startNayaroServer>> | undefined;
let checks = 0;

const outbox: OutgoingEmail[] = [];
const mailer: Mailer = {
  send(email) {
    outbox.push(email);
    return Promise.resolve();
  },
};
const lastCode = (): string => {
  const match = /\b(\d{6})\b/.exec(outbox.at(-1)?.text ?? '');
  assert.ok(match, 'an email with a 6-digit code was sent');
  return match[1]!;
};

async function call<T>(path: string, status: number, body?: unknown): Promise<T & { code?: string }> {
  const response = await fetch(`${handle!.baseUrl}${path}`, {
    method: 'POST',
    headers: { Connection: 'close', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = (await response.json()) as T & { code?: string; error?: { code: string } };
  assert.equal(response.status, status, `${path}: ${JSON.stringify(result)}`);
  checks++;
  return result;
}
const errorCode = (reply: { error?: { code?: string } } & Record<string, unknown>): string | undefined =>
  reply.error?.code ?? (reply['code'] as string | undefined);

const form = (email: string | undefined, slug = 'momo-house') => ({
  restaurant: { slug, name: 'Momo House' },
  owner: { name: 'Sita Sharma', username: 'sita', password: 'verified-signup-password', ...(email ? { email } : {}) },
});

try {
  handle = await startNayaroServer({
    host: '127.0.0.1',
    port: 0,
    databaseFilePath: layout.databaseFilePath,
    silent: true,
    registrationsPerHour: 50,
    mailer,
  });

  // The one-step route is off unless a test or the seed turns it on.
  assert.equal(errorCode(await call('/tenants/register', 404, form('a@b.co'))), 'NOT_FOUND');

  // An email is required, and nothing exists until the code is entered.
  assert.equal(errorCode(await call('/tenants/register/start', 400, form(undefined))), 'EMAIL_REQUIRED');
  const started = await call<{ email: string }>('/tenants/register/start', 202, form('Sita@Example.com'));
  assert.equal(started.email, 'sita@example.com', 'the address is lower-cased');
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0]!.to, 'sita@example.com');
  assert.match(outbox[0]!.subject, /^\d{6} is your Nayaro RMS verification code$/);
  assert.match(outbox[0]!.html, /NAYARO/);
  const prisma = createPrismaClient({ databaseFilePath: layout.databaseFilePath });
  assert.equal(await prisma.restaurant.count({ where: { slug: 'momo-house' } }), 0, 'no tenant before verifying');
  const stored = await prisma.pendingRegistration.findUniqueOrThrow({ where: { email: 'sita@example.com' } });
  assert.ok(!stored.payload.includes('verified-signup-password'), 'the plain password is never stored');
  checks += 3;

  // Asking again straight away is refused.
  assert.equal(
    errorCode(await call('/tenants/register/resend', 429, { email: 'sita@example.com' })),
    'RESEND_TOO_SOON',
  );

  // Wrong codes count down, then lock the code.
  const code = lastCode();
  const wrong = code === '000000' ? '111111' : '000000';
  const firstMiss = await call<{ error?: { message: string } }>('/tenants/register/verify', 400, {
    email: 'sita@example.com',
    code: wrong,
  });
  assert.match(JSON.stringify(firstMiss), /4 tries left/);
  for (let attempt = 0; attempt < 4; attempt++) {
    await call('/tenants/register/verify', 400, { email: 'sita@example.com', code: wrong });
  }
  assert.equal(
    errorCode(await call('/tenants/register/verify', 429, { email: 'sita@example.com', code })),
    'TOO_MANY_ATTEMPTS',
    'even the right code is refused once locked',
  );

  // A new code (after the cooldown) unlocks it; the old code is dead.
  await prisma.pendingRegistration.update({
    where: { email: 'sita@example.com' },
    data: { lastSentAt: new Date(Date.now() - 61_000) },
  });
  await call('/tenants/register/resend', 200, { email: 'sita@example.com' });
  const fresh = lastCode();
  assert.equal(outbox.length, 2);
  if (fresh !== code) {
    await call('/tenants/register/verify', 400, { email: 'sita@example.com', code });
  }

  // The right code creates the restaurant and signs the owner in.
  const signedIn = await call<LoginResponse>('/tenants/register/verify', 201, {
    email: 'sita@example.com',
    code: fresh,
  });
  assert.ok(signedIn.token.length > 20);
  assert.equal(signedIn.staff.role, 'OWNER');
  assert.equal(signedIn.tenant.workspace, 'momo-house');
  const owner = await prisma.staff.findUniqueOrThrow({ where: { email: 'sita@example.com' } });
  assert.ok(owner.emailVerifiedAt !== null);
  assert.equal(await prisma.pendingRegistration.count(), 0, 'the pending sign-up is used up');
  checks += 3;

  // A used code cannot create a second restaurant.
  assert.equal(
    errorCode(await call('/tenants/register/verify', 404, { email: 'sita@example.com', code: fresh })),
    'REGISTRATION_NOT_FOUND',
  );

  // Sign in with the email (no workspace), or with workspace + username.
  const byEmail = await call<LoginResponse>('/auth/login', 200, {
    email: 'SITA@example.com',
    password: 'verified-signup-password',
  });
  assert.equal(byEmail.staff.id, owner.id);
  const byUsername = await call<LoginResponse>('/auth/login', 200, {
    workspace: 'momo-house',
    username: 'sita',
    password: 'verified-signup-password',
  });
  assert.equal(byUsername.staff.id, owner.id);
  assert.equal(
    errorCode(await call('/auth/login', 401, { email: 'sita@example.com', password: 'wrong-password' })),
    'INVALID_CREDENTIALS',
  );
  assert.equal(
    errorCode(await call('/auth/login', 401, { email: 'nobody@example.com', password: 'whatever-password' })),
    'INVALID_CREDENTIALS',
    'an unknown email gets the same answer as a wrong password',
  );
  await call('/auth/login', 400, { email: 'sita@example.com', workspace: 'momo-house', username: 'sita', password: 'x' });

  // An address or workspace already in use is refused before any email.
  const sent = outbox.length;
  assert.equal(errorCode(await call('/tenants/register/start', 409, form('sita@example.com', 'other-place'))), 'EMAIL_TAKEN');
  assert.equal(errorCode(await call('/tenants/register/start', 409, form('new@example.com', 'momo-house'))), 'WORKSPACE_TAKEN');
  assert.equal(outbox.length, sent, 'no email for a refused sign-up');

  // An expired code is refused.
  await call('/tenants/register/start', 202, form('late@example.com', 'late-cafe'));
  const lateCode = lastCode();
  await prisma.pendingRegistration.update({
    where: { email: 'late@example.com' },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal(
    errorCode(await call('/tenants/register/verify', 410, { email: 'late@example.com', code: lateCode })),
    'CODE_EXPIRED',
  );
  await prisma.$disconnect();

  console.log(`PASS: ${String(checks)} checks - verified sign-up, code limits, resend, and email or username sign-in.`);
} finally {
  if (handle) await stopNayaroServer(handle);
  rmSync(root, { recursive: true, force: true });
}
