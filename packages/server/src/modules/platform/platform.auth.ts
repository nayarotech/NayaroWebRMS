import { randomBytes } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { NayaroPrismaClient } from '@nayaro/database';
import type { PlatformAdminDto, PlatformLoginResponse } from '@nayaro/shared';
import { z } from 'zod';
import { ApiError } from '../../utils/apiError';
import { hashPassword, verifyPassword } from '../auth/password';
import { hashSessionToken } from '../auth/session.service';
import { emailSchema, passwordSchema } from '../tenant/tenant.schema';

/**
 * Nayaro platform admins: Nayaro Technology's own operators.
 *
 * Kept apart from restaurant Staff on purpose - different table, different
 * sessions, different guard - so no restaurant account, however senior, can
 * ever reach the console, and no console token can be used as a restaurant
 * session.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Present on /platform routes once the admin's session is checked. */
      platform?: { readonly sessionId: string; readonly admin: PlatformAdminDto };
    }
  }
}

const PLATFORM_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
/** Verified against when the email is unknown, so timing does not reveal accounts. */
const DUMMY_HASH = 'scrypt$16384$8$1$Eyf3PW0W75S4sAtzU9RDHw==$neRXaAAzFcqEqqkFe514Di674QZ5MQq4iJjDQXaUe2A=';

export const platformLoginSchema = z.object({ email: emailSchema, password: z.string().min(1).max(200) });

export async function platformLogin(
  prisma: NayaroPrismaClient,
  rawInput: unknown,
  client: { readonly ipAddress?: string; readonly userAgent?: string },
): Promise<PlatformLoginResponse> {
  const { email, password } = platformLoginSchema.parse(rawInput);
  const admin = await prisma.platformAdmin.findUnique({ where: { email } });
  const ok = await verifyPassword(password, admin?.passwordHash ?? DUMMY_HASH);
  if (!admin || !admin.isActive || !ok) {
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password.');
  }

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + PLATFORM_SESSION_TTL_MS);
  await prisma.platformSession.create({
    data: {
      adminId: admin.id,
      tokenHash: hashSessionToken(token),
      expiresAt,
      ipAddress: client.ipAddress?.slice(0, 64) ?? null,
      userAgent: client.userAgent?.slice(0, 256) ?? null,
    },
  });
  await prisma.platformAdmin.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
  return { token, expiresAt: expiresAt.toISOString(), admin: { id: admin.id, email: admin.email, name: admin.name } };
}

export async function platformLogout(prisma: NayaroPrismaClient, sessionId: string): Promise<void> {
  await prisma.platformSession.update({ where: { id: sessionId }, data: { revokedAt: new Date() } });
}

/** Guards every /platform route except login. */
export function requirePlatformAdmin(prisma: NayaroPrismaClient): RequestHandler {
  return (req, _res, next) => {
    const header = req.header('authorization') ?? '';
    const [scheme, token] = header.split(' ');
    if (scheme?.toLowerCase() !== 'bearer' || token === undefined || !TOKEN_SHAPE.test(token)) {
      next(new ApiError(401, 'UNAUTHENTICATED', 'Sign in to the Nayaro console.'));
      return;
    }
    prisma.platformSession
      .findUnique({ where: { tokenHash: hashSessionToken(token) }, include: { admin: true } })
      .then(async (session) => {
        if (
          !session ||
          session.revokedAt !== null ||
          session.expiresAt.getTime() <= Date.now() ||
          !session.admin.isActive
        ) {
          next(new ApiError(401, 'UNAUTHENTICATED', 'Your console session has ended. Sign in again.'));
          return;
        }
        if (Date.now() - session.lastSeenAt.getTime() > 60_000) {
          await prisma.platformSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
        }
        req.platform = {
          sessionId: session.id,
          admin: { id: session.admin.id, email: session.admin.email, name: session.admin.name },
        };
        next();
      })
      .catch((error: unknown) => {
        next(error);
      });
  };
}

export function requirePlatformContext(req: { platform?: Express.Request['platform'] }): NonNullable<
  Express.Request['platform']
> {
  if (!req.platform) throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to the Nayaro console.');
  return req.platform;
}

/** Operator CLI: create or reset a platform admin. */
export async function upsertPlatformAdmin(
  prisma: NayaroPrismaClient,
  input: { readonly email: string; readonly name: string; readonly password: string },
): Promise<PlatformAdminDto> {
  const email = emailSchema.parse(input.email);
  const password = passwordSchema.parse(input.password);
  const name = z.string().trim().min(1).max(120).parse(input.name);
  const passwordHash = await hashPassword(password);
  const admin = await prisma.platformAdmin.upsert({
    where: { email },
    create: { email, name, passwordHash },
    update: { name, passwordHash, isActive: true },
  });
  return { id: admin.id, email: admin.email, name: admin.name };
}
