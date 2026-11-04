import { Router } from 'express';
import type { NayaroPrismaClient } from '@nayaro/database';
import { ApiError } from '../../utils/apiError';
import type { Logger } from '../../utils/logger';
import { requireAuthContext, requireRole } from '../../middleware/authentication';
import { LoginFailedError, login, logout } from './auth.service';
import { LoginThrottle, describeWait } from './loginThrottle';
import { clientAddress } from '../../utils/clientAddress';
import { auditFromRequest, recordAudit } from '../audit/audit.service';
import { getTenantSummary } from '../tenant/tenant.service';

export interface AuthRouterDeps {
  readonly prisma: NayaroPrismaClient;
  readonly logger: Logger;
  /** One per server. Injectable so a test can control the clock. */
  readonly loginThrottle?: LoginThrottle;
}

export function createAuthRouter(deps: AuthRouterDeps): Router {
  const router = Router();
  const throttle = deps.loginThrottle ?? new LoginThrottle();

  /**
   * Public. The only way to obtain a token - and so the one place password
   * guessing happens. See loginThrottle.ts for why it is keyed the way it is.
   */
  router.post('/auth/login', async (req, res) => {
    // Express resolves the address; X-Forwarded-For is only honoured when
    // `trust proxy` names the deployment's own reverse proxy.
    const address = clientAddress(req);
    const username = throttleUsername(req.body);

    const wait = throttle.retryAfterMs(address, username);
    if (wait !== null) {
      res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
      throw new ApiError(
        429,
        'TOO_MANY_ATTEMPTS',
        `Too many sign-in attempts. Try again in ${describeWait(wait)}.`,
      );
    }

    let result: Awaited<ReturnType<typeof login>>;
    try {
      result = await login(deps.prisma, req.body, deps.logger, {
        ipAddress: address,
        ...(req.header('user-agent') ? { userAgent: req.header('user-agent') } : {}),
      });
    } catch (error: unknown) {
      if (error instanceof LoginFailedError) {
        if (error.restaurantId !== null) {
          await recordAudit(
            deps.prisma,
            {
              restaurantId: error.restaurantId,
              staffId: error.staffId,
              action: 'AUTH_LOGIN_FAILED',
              summary: `Failed sign-in for "${username.split('/')[1] ?? ''}"`,
              ipAddress: address,
            },
            deps.logger,
          );
        }
        throttle.recordFailure(address, username);
        if (throttle.retryAfterMs(address, username) !== null) {
          deps.logger.warn(`Sign-in attempts throttled for "${username}" from ${address}`);
        }
      }
      throw error;
    }
    throttle.recordSuccess(address, username);
    await recordAudit(
      deps.prisma,
      {
        restaurantId: result.staff.restaurantId,
        staffId: result.staff.id,
        action: 'AUTH_LOGIN',
        summary: `${result.staff.name} signed in`,
        ipAddress: address,
      },
      deps.logger,
    );

    res.json({
      token: result.token,
      expiresAt: result.expiresAt.toISOString(),
      staff: result.staff,
      tenant: await getTenantSummary(deps.prisma, result.staff.restaurantId),
    });
  });

  /** Authenticated. Confirms the token and drives which UI is shown. */
  router.get('/auth/me', async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json({
      staff,
      tenant: await getTenantSummary(deps.prisma, staff.restaurantId),
      // Drives the "read-only support view" banner.
      impersonation: req.auth?.impersonation ?? null,
    });
  });

  router.post('/auth/logout', async (req, res) => {
    const { sessionId, staff } = requireAuthContext(req);
    await logout(deps.prisma, sessionId, deps.logger);
    await auditFromRequest(
      deps.prisma,
      req,
      { action: 'AUTH_LOGOUT', summary: `${staff.name} signed out` },
      deps.logger,
    );
    res.status(204).send();
  });

  /** Ends one of this restaurant's sessions, e.g. a lost tablet. */
  router.delete('/auth/sessions/:sessionId', requireRole('OWNER', 'MANAGER'), async (req, res) => {
    const { staff } = requireAuthContext(req);
    const sessionId = req.params['sessionId'];
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new ApiError(400, 'BAD_REQUEST', 'Malformed request path.');
    }
    // Scoped by restaurant: another tenant's session id simply matches nothing.
    const result = await deps.prisma.session.updateMany({
      where: { id: sessionId, restaurantId: staff.restaurantId, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: `Signed out by ${staff.username}` },
    });
    if (result.count === 0) throw new ApiError(404, 'SESSION_NOT_FOUND', 'Session not found.');
    await auditFromRequest(
      deps.prisma,
      req,
      { action: 'AUTH_LOGOUT', summary: 'Signed out a device remotely', entityType: 'Session', entityId: sessionId },
      deps.logger,
    );
    res.status(204).send();
  });

  /**
   * Which terminals are currently signed in. Restricted to OWNER and MANAGER:
   * a cashier has no business seeing the estate.
   *
   * This is also the route that proves the role mechanism end to end, and it
   * is a real feature rather than a test stub - "who is logged in where" is a
   * question a restaurant owner genuinely asks.
   */
  router.get('/auth/sessions', requireRole('OWNER', 'MANAGER'), async (req, res) => {
    const { staff } = requireAuthContext(req);
    const sessions = await deps.prisma.session.findMany({
      where: { restaurantId: staff.restaurantId, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { lastSeenAt: 'desc' },
      select: {
        id: true,
        deviceLabel: true,
        ipAddress: true,
        userAgent: true,
        createdAt: true,
        lastSeenAt: true,
        expiresAt: true,
        staff: { select: { name: true, username: true, role: true } },
      },
    });
    // Note what is absent: tokenHash. It never leaves the database.
    res.json({ sessions });
  });

  return router;
}

/**
 * The account as the throttle keys it - "workspace/username", trimmed and
 * lower-cased the way login normalises them, so "Rajan.S" and "rajan.s" share
 * one counter. Read from the raw body because the throttle runs before
 * validation.
 */
function throttleUsername(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '/';
  const record = body as Record<string, unknown>;
  const part = (value: unknown): string =>
    // Capped: caller-supplied, and it becomes a map key and a log line.
    typeof value === 'string' ? value.trim().toLowerCase().slice(0, 64) : '';
  // An email sign-in is keyed by the address, so guessing passwords for one
  // owner is throttled whichever way they are attempted.
  const email = part(record['email']);
  return email.length > 0 ? `@/${email}` : `${part(record['workspace'])}/${part(record['username'])}`;
}
