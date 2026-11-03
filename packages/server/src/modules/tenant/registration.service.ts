import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { NayaroPrismaClient } from '@nayaro/database';
import { z } from 'zod';
import { ApiError } from '../../utils/apiError';
import { hashPassword } from '../auth/password';
import type { Mailer } from '../email/mailer';
import { verificationCodeEmail } from '../email/templates';
import { emailSchema, registerTenantSchema, type RegisterTenantInput } from './tenant.schema';
import { createTenant, type RegisterTenantResult } from './tenant.service';

/**
 * Verified sign-up, in two requests.
 *
 *   start   validate the whole form, hash the password, park it as a
 *           PendingRegistration and email a 6-digit code
 *   verify  check the code, then create the restaurant with the owner's email
 *           marked verified - the only way a public sign-up creates a tenant
 *
 * Nothing touches Restaurant or Staff until the code is proven, so a typo in
 * the address or an abandoned form leaves no half-made restaurant behind.
 */
export const CODE_TTL_MINUTES = 15;
export const RESEND_COOLDOWN_SECONDS = 60;
export const MAX_CODE_ATTEMPTS = 5;

export interface PendingRegistrationView {
  readonly email: string;
  readonly expiresAt: string;
  readonly resendAfterSeconds: number;
}

type StoredPayload = Omit<RegisterTenantInput, 'owner'> & {
  readonly owner: Omit<RegisterTenantInput['owner'], 'password'> & { readonly passwordHash: string };
};

const codeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'Enter the 6-digit code from the email.');

export const verifyRegistrationSchema = z.object({ email: emailSchema, code: codeSchema });
export const resendRegistrationSchema = z.object({ email: emailSchema });

function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/** Bound to the address, so a code is worthless for any other sign-up. */
function hashCode(email: string, code: string): string {
  return createHash('sha256').update(`${email}:${code}`).digest('hex');
}

function view(email: string, expiresAt: Date): PendingRegistrationView {
  return { email, expiresAt: expiresAt.toISOString(), resendAfterSeconds: RESEND_COOLDOWN_SECONDS };
}

function cooldownError(lastSentAt: Date, now: Date): ApiError | null {
  const waitMs = lastSentAt.getTime() + RESEND_COOLDOWN_SECONDS * 1000 - now.getTime();
  return waitMs > 0
    ? new ApiError(
        429,
        'RESEND_TOO_SOON',
        `A code was just sent. You can ask for another in ${String(Math.ceil(waitMs / 1000))} seconds.`,
      )
    : null;
}

async function sendCode(mailer: Mailer, payload: StoredPayload, code: string): Promise<void> {
  await mailer.send(
    verificationCodeEmail({
      to: payload.owner.email!,
      code,
      ownerName: payload.owner.name,
      restaurantName: payload.restaurant.name,
      expiresInMinutes: CODE_TTL_MINUTES,
    }),
  );
}

export async function startRegistration(
  prisma: NayaroPrismaClient,
  mailer: Mailer,
  rawInput: unknown,
  now = new Date(),
): Promise<PendingRegistrationView> {
  const input = registerTenantSchema.parse(rawInput);
  const email = input.owner.email;
  if (email === undefined) {
    throw new ApiError(400, 'EMAIL_REQUIRED', 'Enter the owner’s email address. We send a code to verify it.');
  }

  // Checked now so the person is told before waiting for an email; checked
  // again inside the creating transaction, which is the check that counts.
  const [workspaceTaken, emailTaken, existing] = await Promise.all([
    prisma.restaurant.findUnique({ where: { slug: input.restaurant.slug }, select: { id: true } }),
    prisma.staff.findUnique({ where: { email }, select: { id: true } }),
    prisma.pendingRegistration.findUnique({ where: { email } }),
  ]);
  if (workspaceTaken) {
    throw new ApiError(409, 'WORKSPACE_TAKEN', 'That workspace code is already in use. Choose another.');
  }
  if (emailTaken) {
    throw new ApiError(409, 'EMAIL_TAKEN', 'An account already uses that email. Sign in instead.');
  }
  if (existing) {
    const tooSoon = cooldownError(existing.lastSentAt, now);
    if (tooSoon) throw tooSoon;
  }

  const { password, ...owner } = input.owner;
  const payload: StoredPayload = { ...input, owner: { ...owner, passwordHash: await hashPassword(password) } };
  const code = newCode();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MINUTES * 60 * 1000);
  const data = {
    workspace: input.restaurant.slug,
    payload: JSON.stringify(payload),
    codeHash: hashCode(email, code),
    attempts: 0,
    expiresAt,
    lastSentAt: now,
  };
  // One pending sign-up per address: starting again replaces the old form and
  // invalidates its code.
  await prisma.pendingRegistration.upsert({ where: { email }, create: { email, ...data }, update: data });

  await sendCode(mailer, payload, code);
  return view(email, expiresAt);
}

export async function resendRegistrationCode(
  prisma: NayaroPrismaClient,
  mailer: Mailer,
  rawInput: unknown,
  now = new Date(),
): Promise<PendingRegistrationView> {
  const { email } = resendRegistrationSchema.parse(rawInput);
  const pending = await prisma.pendingRegistration.findUnique({ where: { email } });
  if (!pending) {
    throw new ApiError(404, 'REGISTRATION_NOT_FOUND', 'No sign-up is waiting for that email. Start again.');
  }
  const tooSoon = cooldownError(pending.lastSentAt, now);
  if (tooSoon) throw tooSoon;

  const code = newCode();
  const expiresAt = new Date(now.getTime() + CODE_TTL_MINUTES * 60 * 1000);
  await prisma.pendingRegistration.update({
    where: { email },
    data: { codeHash: hashCode(email, code), attempts: 0, expiresAt, lastSentAt: now },
  });
  await sendCode(mailer, JSON.parse(pending.payload) as StoredPayload, code);
  return view(email, expiresAt);
}

/** Confirms the code and creates the restaurant. Returns the new owner's ids. */
export async function verifyRegistration(
  prisma: NayaroPrismaClient,
  rawInput: unknown,
  now = new Date(),
): Promise<RegisterTenantResult> {
  const { email, code } = verifyRegistrationSchema.parse(rawInput);
  const pending = await prisma.pendingRegistration.findUnique({ where: { email } });
  if (!pending) {
    throw new ApiError(404, 'REGISTRATION_NOT_FOUND', 'No sign-up is waiting for that email. Start again.');
  }
  if (pending.expiresAt.getTime() <= now.getTime()) {
    throw new ApiError(410, 'CODE_EXPIRED', 'That code has expired. Ask for a new one.');
  }
  if (pending.attempts >= MAX_CODE_ATTEMPTS) {
    throw new ApiError(429, 'TOO_MANY_ATTEMPTS', 'Too many wrong codes. Ask for a new one.');
  }

  const expected = Buffer.from(pending.codeHash, 'hex');
  const given = Buffer.from(hashCode(email, code), 'hex');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    // Counted atomically, so parallel guesses cannot all slip in under the limit.
    const updated = await prisma.pendingRegistration.update({
      where: { email },
      data: { attempts: { increment: 1 } },
      select: { attempts: true },
    });
    const left = MAX_CODE_ATTEMPTS - updated.attempts;
    throw new ApiError(
      400,
      'CODE_INVALID',
      left > 0
        ? `That code is not right. ${String(left)} ${left === 1 ? 'try' : 'tries'} left.`
        : 'Too many wrong codes. Ask for a new one.',
    );
  }

  const payload = JSON.parse(pending.payload) as StoredPayload;
  const { passwordHash, ...owner } = payload.owner;
  const result = await createTenant(
    prisma,
    { ...payload, owner: { ...owner, password: '' } },
    passwordHash,
    email,
  );
  // Gone once used, so the same code can never create a second restaurant.
  await prisma.pendingRegistration.delete({ where: { email } }).catch(() => undefined);
  return result;
}
