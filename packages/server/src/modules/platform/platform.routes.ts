import { Router } from 'express';
import type { NayaroPrismaClient } from '@nayaro/database';
import type { Logger } from '../../utils/logger';
import { clientAddress } from '../../utils/clientAddress';
import { createRateLimit } from '../../middleware/rateLimit';
import { recordAudit } from '../audit/audit.service';
import { LoginThrottle, describeWait } from '../auth/loginThrottle';
import { ApiError } from '../../utils/apiError';
import {
  platformLogin,
  platformLogout,
  requirePlatformAdmin,
  requirePlatformContext,
} from './platform.auth';
import {
  applyTenantAction,
  platformActivity,
  platformOverview,
  platformPendingSignups,
  platformTenantDetail,
  platformTenants,
  startSupportView,
} from './platform.service';
import { siteAnalyticsReport } from '../siteAnalytics/siteAnalytics.service';

export interface PlatformRouterDeps {
  readonly prisma: NayaroPrismaClient;
  readonly logger: Logger;
}

/**
 * The Nayaro console API. Mounted at /platform; the restaurant authentication
 * wall lets these paths through and `requirePlatformAdmin` guards them instead.
 */
export function createPlatformRouter(deps: PlatformRouterDeps): Router {
  const router = Router();
  const throttle = new LoginThrottle();
  const guard = requirePlatformAdmin(deps.prisma);
  const loginLimit = createRateLimit({ windowMs: 15 * 60 * 1000, max: 30 });

  router.post('/platform/auth/login', loginLimit, async (req, res) => {
    const address = clientAddress(req);
    const key = `platform/${typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 64) : ''}`;
    const wait = throttle.retryAfterMs(address, key);
    if (wait !== null) {
      throw new ApiError(429, 'TOO_MANY_ATTEMPTS', `Too many sign-in attempts. Try again in ${describeWait(wait)}.`);
    }
    try {
      const result = await platformLogin(deps.prisma, req.body, {
        ipAddress: address,
        ...(req.header('user-agent') ? { userAgent: req.header('user-agent') } : {}),
      });
      throttle.recordSuccess(address, key);
      deps.logger.info(`Platform admin signed in: ${result.admin.email}`);
      res.json(result);
    } catch (error: unknown) {
      if (error instanceof ApiError && error.statusCode === 401) throttle.recordFailure(address, key);
      throw error;
    }
  });

  router.get('/platform/auth/me', guard, (req, res) => {
    res.json({ admin: requirePlatformContext(req).admin });
  });

  router.post('/platform/auth/logout', guard, async (req, res) => {
    await platformLogout(deps.prisma, requirePlatformContext(req).sessionId);
    res.status(204).end();
  });

  router.get('/platform/overview', guard, async (_req, res) => {
    res.json(await platformOverview(deps.prisma));
  });

  router.get('/platform/tenants', guard, async (_req, res) => {
    res.json({ tenants: await platformTenants(deps.prisma) });
  });

  router.get('/platform/tenants/:id', guard, async (req, res) => {
    res.json(await platformTenantDetail(deps.prisma, String(req.params['id'])));
  });

  router.post('/platform/tenants/:id/actions', guard, async (req, res) => {
    const { admin } = requirePlatformContext(req);
    const restaurantId = String(req.params['id']);
    const summary = await applyTenantAction(deps.prisma, restaurantId, req.body);
    await recordAudit(
      deps.prisma,
      {
        restaurantId,
        action: 'PLATFORM_ACCOUNT_CHANGED',
        summary: `Nayaro (${admin.name}): ${summary}`,
        ipAddress: clientAddress(req),
      },
      deps.logger,
    );
    res.json(await platformTenantDetail(deps.prisma, restaurantId));
  });

  router.post('/platform/tenants/:id/support-view', guard, async (req, res) => {
    const { admin } = requirePlatformContext(req);
    const restaurantId = String(req.params['id']);
    const view = await startSupportView(deps.prisma, restaurantId, admin, {
      ipAddress: clientAddress(req),
      ...(req.header('user-agent') ? { userAgent: req.header('user-agent') } : {}),
    });
    // Written to the restaurant's own log, which its owner can read.
    await recordAudit(
      deps.prisma,
      {
        restaurantId,
        action: 'SUPPORT_VIEW_STARTED',
        summary: `Nayaro support (${admin.name}) opened a read-only view of this account for one hour`,
        ipAddress: clientAddress(req),
      },
      deps.logger,
    );
    deps.logger.info(`Support view: ${admin.email} -> ${view.tenant.workspace}`);
    res.status(201).json(view);
  });

  router.get('/platform/site-analytics', guard, async (req, res) => {
    const range = typeof req.query['range'] === 'string' ? req.query['range'] : undefined;
    const timeZone = typeof req.query['tz'] === 'string' ? req.query['tz'] : undefined;
    res.json(
      await siteAnalyticsReport(deps.prisma, {
        ...(range === undefined ? {} : { range }),
        ...(timeZone === undefined ? {} : { timeZone }),
      }),
    );
  });

  router.get('/platform/signups', guard, async (_req, res) => {
    res.json({ signups: await platformPendingSignups(deps.prisma) });
  });

  router.get('/platform/activity', guard, async (req, res) => {
    const before = typeof req.query['before'] === 'string' ? req.query['before'] : undefined;
    const action = typeof req.query['action'] === 'string' ? req.query['action'] : undefined;
    res.json(
      await platformActivity(deps.prisma, {
        ...(before === undefined ? {} : { before }),
        ...(action === undefined ? {} : { action }),
      }),
    );
  });

  return router;
}
