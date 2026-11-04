import { Router, type Request } from 'express';
import type { NayaroPrismaClient } from '@nayaro/database';
import type { Logger } from '../../utils/logger';
import { createRateLimit } from '../../middleware/rateLimit';
import { recordHit, recordPing } from './siteAnalytics.service';

export interface SiteAnalyticsRouterDeps {
  readonly prisma: NayaroPrismaClient;
  readonly logger: Logger;
}

function ownHosts(req: Request): string[] {
  const hosts: string[] = [];
  for (const value of [req.header('origin'), req.header('referer')]) {
    try {
      if (value) hosts.push(new URL(value).hostname.replace(/^www\./, ''));
    } catch {
      // Not a URL; ignore.
    }
  }
  return hosts;
}

/**
 * Public collection endpoints for the site's own analytics. Always 204: a
 * tracking failure must never surface on a page, and a bad hit is dropped.
 */
export function createSiteAnalyticsRouter(deps: SiteAnalyticsRouterDeps): Router {
  const router = Router();
  const limit = createRateLimit({ windowMs: 60 * 1000, max: 120 });

  router.post('/analytics/hit', limit, async (req, res) => {
    try {
      await recordHit(deps.prisma, req.body, {
        userAgent: req.header('user-agent') ?? '',
        countryHeader: req.header('cf-ipcountry') ?? req.header('x-vercel-ip-country'),
        ownHosts: ownHosts(req),
      });
    } catch (error: unknown) {
      deps.logger.warn('Could not record a page view', error);
    }
    res.status(204).end();
  });

  router.post('/analytics/ping', limit, async (req, res) => {
    try {
      await recordPing(deps.prisma, req.body, req.header('user-agent') ?? '');
    } catch (error: unknown) {
      deps.logger.warn('Could not record a heartbeat', error);
    }
    res.status(204).end();
  });

  return router;
}
