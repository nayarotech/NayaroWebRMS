import type { NayaroPrismaClient, TenantStatus } from '@nayaro/database';
import { ApiError } from '../../utils/apiError';
import type { Logger } from '../../utils/logger';
import { hashPassword, needsRehash, verifyPassword } from './password';
import { loginInputSchema } from './auth.schema';
import { createSession, revokeSession, type SessionClientInfo } from './session.service';
import type { AuthenticatedStaff } from './auth.types';
import { tenantBlock, tenantBlockedError } from '../tenant/tenant.service';

export interface LoginResult {
  readonly token: string;
  readonly expiresAt: Date;
  readonly staff: AuthenticatedStaff;
}

/** Raised for a wrong password, carrying the tenant so it can be audited. */
export class LoginFailedError extends ApiError {
  readonly restaurantId: string | null;
  readonly staffId: string | null;

  constructor(restaurantId: string | null, staffId: string | null) {
    super(401, 'INVALID_CREDENTIALS', 'Incorrect email, username or password.');
    this.restaurantId = restaurantId;
    this.staffId = staffId;
  }
}

/**
 * A real, fixed scrypt hash used only when the username does not exist.
 *
 * Without it, a missing username returns before scrypt runs at all, so a
 * failed login for "nobody" comes back in about a millisecond while a failed
 * login for a real staff member takes ~80ms. That difference is trivially
 * measurable over loopback and hands an attacker a username oracle - which
 * matters here because restaurant usernames are guessable first names.
 *
 * Embedded as a constant rather than derived at startup: generating it per
 * request would defeat the purpose, and computing it lazily would add startup
 * work and a cache to reason about. Its plaintext is irrelevant - the result
 * of verifying against it is discarded, and the caller always gets the same
 * generic failure.
 *
 * This equalises the obvious "no scrypt at all" gap. It does not claim
 * constant time: database lookup cost and V8 scheduling still vary.
 */
const DUMMY_PASSWORD_HASH =
  'scrypt$16384$8$1$Eyf3PW0W75S4sAtzU9RDHw==$neRXaAAzFcqEqqkFe514Di674QZ5MQq4iJjDQXaUe2A=';

export async function login(
  prisma: NayaroPrismaClient,
  rawInput: unknown,
  logger: Logger,
  client: Omit<SessionClientInfo, 'deviceLabel'> = {},
): Promise<LoginResult> {
  const input = loginInputSchema.parse(rawInput);

  // One error for an unknown workspace, an unknown user, a disabled account
  // and a wrong password, so the response is not an oracle for which
  // restaurants or staff usernames exist.
  // Two ways in: a verified email, which is unique across the platform and so
  // needs no workspace code, or a workspace code plus a username, which is
  // only unique inside one restaurant. Both end at the same checks below.
  const restaurantSelect = { id: true, isActive: true, status: true, subscriptionEndsAt: true } as const;
  let restaurant: { id: string; isActive: boolean; status: TenantStatus; subscriptionEndsAt: Date | null } | null;
  let staff: Awaited<ReturnType<typeof prisma.staff.findUnique>>;
  if (input.email !== undefined) {
    const byEmail = await prisma.staff.findUnique({
      where: { email: input.email },
      include: { restaurant: { select: restaurantSelect } },
    });
    // An unverified address must never sign in, even if one were stored.
    const usable = byEmail !== null && byEmail.emailVerifiedAt !== null ? byEmail : null;
    staff = usable;
    restaurant = usable?.restaurant ?? null;
  } else {
    restaurant = await prisma.restaurant.findUnique({ where: { slug: input.workspace }, select: restaurantSelect });
    staff = restaurant
      ? await prisma.staff.findUnique({
          where: { restaurantId_username: { restaurantId: restaurant.id, username: input.username } },
        })
      : null;
  }

  // Password verification runs on EVERY path, including a missing username -
  // see DUMMY_PASSWORD_HASH above. The three failure conditions are then
  // evaluated together, so no branch can return early and leak which one hit.
  const passwordOk = await verifyPassword(
    input.password,
    staff?.passwordHash ?? DUMMY_PASSWORD_HASH,
  );

  if (!restaurant || !staff || !staff.isActive || !passwordOk) {
    throw new LoginFailedError(restaurant?.id ?? null, staff?.id ?? null);
  }

  // Only revealed to someone who has just proven the password, so it leaks
  // nothing to a guesser.
  const block = tenantBlock(restaurant);
  if (block !== null) throw tenantBlockedError(block);

  // Transparent upgrade: the password is in hand and already proven correct,
  // so this is the only moment we can strengthen an old hash. Failure here
  // must never fail the login - the user typed the right password.
  if (needsRehash(staff.passwordHash)) {
    try {
      const upgraded = await hashPassword(input.password);
      await prisma.staff.update({ where: { id: staff.id }, data: { passwordHash: upgraded } });
      logger.info(`Upgraded stored password parameters for ${staff.username}`);
    } catch (error: unknown) {
      logger.warn('Could not upgrade password hash; continuing with login', error);
    }
  }

  const result = await issueStaffSession(prisma, staff, {
    ...client,
    ...(input.deviceLabel === undefined ? {} : { deviceLabel: input.deviceLabel }),
  });
  logger.info(`Login: ${staff.username} (${staff.role}) via ${input.email === undefined ? 'username' : 'email'}`);
  return result;
}

/** The staff fields a session is issued for. */
export interface SessionStaff {
  readonly id: string;
  readonly restaurantId: string;
  readonly name: string;
  readonly username: string;
  readonly role: AuthenticatedStaff['role'];
  readonly canTakeOrders: boolean;
  readonly canManageKitchen: boolean;
}

/**
 * Issues a session for someone who has already proven who they are - by
 * password at sign-in, or by the emailed code at the end of sign-up.
 */
export async function issueStaffSession(
  prisma: NayaroPrismaClient,
  staff: SessionStaff,
  client: SessionClientInfo = {},
): Promise<LoginResult> {
  const session = await createSession(prisma, { id: staff.id, restaurantId: staff.restaurantId }, client);
  await prisma.staff.update({ where: { id: staff.id }, data: { lastLoginAt: new Date() } });
  return {
    token: session.token,
    expiresAt: session.expiresAt,
    staff: {
      id: staff.id,
      restaurantId: staff.restaurantId,
      name: staff.name,
      username: staff.username,
      role: staff.role,
      canTakeOrders: staff.canTakeOrders,
      canManageKitchen: staff.canManageKitchen,
    },
  };
}

export async function logout(
  prisma: NayaroPrismaClient,
  sessionId: string,
  logger: Logger,
): Promise<void> {
  await revokeSession(prisma, sessionId, 'logout');
  logger.info('Session revoked by logout');
}
