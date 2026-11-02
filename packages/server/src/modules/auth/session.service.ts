import { createHash, randomBytes } from 'node:crypto';
import type { NayaroPrismaClient } from '@nayaro/database';
import type { AuthenticatedStaff } from './auth.types';
import { tenantBlock, type TenantBlock } from '../tenant/tenant.service';

/**
 * Opaque server-side sessions.
 *
 * WHY NOT JWT
 *
 * A JWT's one real advantage is that a recipient can validate it without
 * asking the issuer - worth a great deal across a fleet of services, worth
 * nothing here, where the only thing that ever validates a token is the same
 * process that issued it, with the database already open.
 *
 * What we would pay for that non-benefit is exactly what a restaurant cannot
 * afford: revocation stops being instant. Sacking a cashier mid-shift, or
 * deactivating an account, would leave a valid token in the wild until it
 * expired, and the usual fix - short access tokens plus refresh tokens plus a
 * revocation list - reintroduces server-side state anyway, having added key
 * management and clock-skew handling on the way.
 *
 * An opaque random token looked up in the database revokes the instant the
 * row changes. On the hosted platform that matters even more: suspending a
 * tenant, deactivating a cashier or signing out a stolen device must take
 * effect on the very next request, not when a signed token happens to expire.
 *
 * A token is never trusted because it is well-formed or because the browser
 * holds it. Every request re-derives everything from the database: the
 * session row, its expiry and revocation, the staff account, and the tenant's
 * status and subscription.
 *
 * TOKEN HANDLING
 *
 * 32 bytes from the CSPRNG, base64url-encoded. Only its SHA-256 is stored, so
 * a stolen database backup yields nothing usable; the plaintext exists once,
 * in the login response. SHA-256 rather than scrypt is correct here: the token
 * already has 256 bits of entropy, so there is no guessing to slow down, and a
 * fast hash keeps per-request lookup cheap.
 */

const TOKEN_BYTES = 32;

/**
 * Sliding window. An actively used terminal stays logged in through a long
 * shift; an abandoned one stops working after twelve idle hours.
 */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Only refresh the window if the session has not been touched for this long.
 * Without it every authenticated request would be a database write.
 */
const SESSION_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export interface IssuedSession {
  /** Returned to the client exactly once. Never stored, never logged. */
  readonly token: string;
  readonly expiresAt: Date;
}

export interface SessionClientInfo {
  readonly deviceLabel?: string;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

export async function createSession(
  prisma: NayaroPrismaClient,
  staff: { id: string; restaurantId: string },
  client: SessionClientInfo = {},
): Promise<IssuedSession> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.session.create({
    data: {
      restaurantId: staff.restaurantId,
      staffId: staff.id,
      tokenHash: hashSessionToken(token),
      expiresAt,
      deviceLabel: client.deviceLabel ?? null,
      ipAddress: client.ipAddress?.slice(0, 64) ?? null,
      userAgent: client.userAgent?.slice(0, 256) ?? null,
    },
  });

  return { token, expiresAt };
}

export interface ResolvedSession {
  readonly sessionId: string;
  readonly staff: AuthenticatedStaff;
}

export type SessionCheck =
  | { readonly ok: true; readonly session: ResolvedSession }
  | { readonly ok: false; readonly reason: 'INVALID' }
  | { readonly ok: false; readonly reason: TenantBlock };

/** Tokens are 32 random bytes in base64url; anything else cannot be ours. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Checks a bearer token against the database.
 *
 * Re-reads the Staff and Restaurant rows on every request instead of trusting
 * anything copied at login, so deactivating an account or suspending a tenant
 * takes effect immediately.
 */
export async function checkSession(
  prisma: NayaroPrismaClient,
  token: string,
  /**
   * `touch: false` checks the session without extending it. The socket's
   * periodic recheck uses this: an idle connection is not activity, and must
   * not keep an abandoned session alive forever.
   */
  options: { readonly touch?: boolean } = {},
): Promise<SessionCheck> {
  if (!TOKEN_SHAPE.test(token)) return { ok: false, reason: 'INVALID' };

  const session = await prisma.session.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: {
      staff: true,
      restaurant: { select: { isActive: true, status: true, subscriptionEndsAt: true } },
    },
  });

  if (!session) return { ok: false, reason: 'INVALID' };
  if (session.revokedAt !== null) return { ok: false, reason: 'INVALID' };
  if (session.expiresAt.getTime() <= Date.now()) return { ok: false, reason: 'INVALID' };
  if (!session.staff.isActive) return { ok: false, reason: 'INVALID' };
  // Defence in depth: a session can only ever belong to its staff member's tenant.
  if (session.staff.restaurantId !== session.restaurantId) return { ok: false, reason: 'INVALID' };

  const block = tenantBlock(session.restaurant);
  if (block !== null) return { ok: false, reason: block };

  if (options.touch !== false) await touchSession(prisma, session.id, session.lastSeenAt);

  return {
    ok: true,
    session: {
      sessionId: session.id,
      staff: {
        id: session.staff.id,
        restaurantId: session.staff.restaurantId,
        name: session.staff.name,
        username: session.staff.username,
        role: session.staff.role,
        canTakeOrders: session.staff.canTakeOrders,
        canManageKitchen: session.staff.canManageKitchen,
      },
    },
  };
}

/** A live session, or null for every way a token can fail. */
export async function resolveSession(
  prisma: NayaroPrismaClient,
  token: string,
  options: { readonly touch?: boolean } = {},
): Promise<ResolvedSession | null> {
  const result = await checkSession(prisma, token, options);
  return result.ok ? result.session : null;
}

async function touchSession(
  prisma: NayaroPrismaClient,
  sessionId: string,
  lastSeenAt: Date,
): Promise<void> {
  if (Date.now() - lastSeenAt.getTime() < SESSION_TOUCH_INTERVAL_MS) return;

  const now = new Date();
  await prisma.session.update({
    where: { id: sessionId },
    data: { lastSeenAt: now, expiresAt: new Date(now.getTime() + SESSION_TTL_MS) },
  });
}

export async function revokeSession(
  prisma: NayaroPrismaClient,
  sessionId: string,
  reason: string,
): Promise<void> {
  await prisma.session.updateMany({
    where: { id: sessionId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
}

/**
 * Revokes every session belonging to one staff member.
 *
 * Used by password changes and staff deactivation.
 */
export async function revokeAllSessionsForStaff(
  prisma: NayaroPrismaClient,
  staffId: string,
  reason: string,
): Promise<number> {
  const result = await prisma.session.updateMany({
    where: { staffId, revokedAt: null },
    data: { revokedAt: new Date(), revokedReason: reason },
  });
  return result.count;
}

/** Housekeeping: drops rows that can never authenticate again. */
export async function pruneExpiredSessions(prisma: NayaroPrismaClient): Promise<number> {
  const result = await prisma.session.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  return result.count;
}
