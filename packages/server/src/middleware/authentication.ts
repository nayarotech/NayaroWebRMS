import { hasServicePermission, type ServicePermission } from '@nayaro/shared';
import type { RequestHandler } from 'express';
import type { NayaroPrismaClient, StaffRole } from '@nayaro/database';
import { ApiError } from '../utils/apiError';
import { checkSession, type SessionImpersonation } from '../modules/auth/session.service';
import { tenantBlockedError } from '../modules/tenant/tenant.service';
import type { AuthenticatedStaff } from '../modules/auth/auth.types';

/**
 * Authentication, applied as a wall rather than a series of gates.
 *
 * This middleware is mounted once, before every router, and rejects anything
 * that is not on the allowlist below. The alternative - remembering to attach
 * `requireAuth` to each new route - fails the first time someone forgets, and
 * the failure is silent: an unprotected endpoint looks exactly like a
 * protected one until somebody notices. Here, forgetting produces a 401, which
 * is the safe direction to be wrong in.
 */

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Present on every request that passed authentication. */
      auth?: {
        readonly sessionId: string;
        readonly staff: AuthenticatedStaff;
        readonly impersonation?: SessionImpersonation;
      };
    }
  }
}

/**
 * The complete unauthenticated surface, and why each is public:
 *
 *   GET  /health             - load balancers probe it before anyone signs in.
 *   POST /tenants/register   - creates a restaurant and its first owner; there
 *                              is nobody to authenticate as yet. Rate limited.
 *   GET  /tenants/lookup     - the sign-in screen confirms a workspace code.
 *   POST /auth/login         - the only way to obtain a token.
 *   GET  /public/menu        - a restaurant's guest menu, only when enabled.
 *
 * Everything else requires a valid staff session.
 */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  'GET /health',
  'POST /tenants/register',
  'POST /tenants/register/start',
  'POST /tenants/register/resend',
  'POST /tenants/register/verify',
  'GET /tenants/lookup',
  'POST /auth/login',
  'GET /public/menu',
]);

function isPublic(method: string, path: string): boolean {
  // Normalise a trailing slash so "/health/" cannot slip past as non-public
  // and, more importantly, so it cannot be treated as a *different* route.
  const normalised = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return PUBLIC_ROUTES.has(`${method.toUpperCase()} ${normalised}`);
}

function readBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer') return null;
  const token = rest.join(' ').trim();
  // Real tokens are 43 characters; refuse anything absurd before hashing it.
  return token.length > 0 && token.length <= 256 ? token : null;
}

export interface AuthenticationDeps {
  readonly prisma: NayaroPrismaClient;
}

export function createAuthenticationMiddleware(deps: AuthenticationDeps): RequestHandler {
  return (req, _res, next) => {
    // CORS preflight carries no credentials by design.
    if (req.method === 'OPTIONS') {
      next();
      return;
    }

    if (isPublic(req.method, req.path)) {
      next();
      return;
    }

    // The platform console has its own accounts and its own guard
    // (modules/platform/platform.auth.ts); restaurant tokens never open it.
    if (req.path === '/platform' || req.path.startsWith('/platform/')) {
      next();
      return;
    }

    const token = readBearerToken(req.header('authorization'));
    if (token === null) {
      next(new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.'));
      return;
    }

    checkSession(deps.prisma, token)
      .then((result) => {
        if (result.ok) {
          req.auth = result.session;
          // A support view is look-only: nothing it does can change the
          // restaurant's data. Signing out (ending the view) is the exception.
          if (
            result.session.impersonation !== undefined &&
            !['GET', 'HEAD'].includes(req.method.toUpperCase()) &&
            req.path !== '/auth/logout'
          ) {
            next(new ApiError(403, 'READ_ONLY_SUPPORT_VIEW', 'This is a read-only support view. Nothing can be changed.'));
            return;
          }
          next();
          return;
        }
        if (result.reason === 'INVALID') {
          // One response for unknown, malformed, expired, revoked, and
          // belonging-to-a-deactivated-account. The client cannot tell them
          // apart, and does not need to.
          next(new ApiError(401, 'UNAUTHENTICATED', 'Your session has ended. Sign in again.'));
          return;
        }
        next(tenantBlockedError(result.reason));
      })
      .catch((error: unknown) => {
        next(error);
      });
  };
}

/**
 * Role gate for individual routes.
 *
 * Financial and management authority stays role based. Operational duties
 * use requireServicePermission below.
 */
export function requireRole(...allowed: readonly StaffRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) {
      // Only reachable if a route is mistakenly on the public allowlist.
      next(new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.'));
      return;
    }
    if (!allowed.includes(req.auth.staff.role)) {
      next(new ApiError(403, 'FORBIDDEN', 'Your role does not allow this action.'));
      return;
    }
    next();
  };
}

/** Reads the authenticated context, or throws. For use inside route handlers. */
export function requireAuthContext(req: {
  auth?: { sessionId: string; staff: AuthenticatedStaff };
}): { sessionId: string; staff: AuthenticatedStaff } {
  if (!req.auth) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
  }
  return req.auth;
}

/** Extra service duties are checked against the freshly resolved staff record. */
export function requireServicePermission(permission: ServicePermission): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) return next(new ApiError(401, 'UNAUTHENTICATED', 'Sign in to continue.'));
    if (!hasServicePermission(req.auth.staff, permission)) {
      return next(new ApiError(403, 'FORBIDDEN', 'Your account does not allow this action.'));
    }
    next();
  };
}
