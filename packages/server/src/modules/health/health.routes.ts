import { Router } from 'express';
import { getHealth, type HealthServiceDeps } from './health.service';

/**
 * Routes are created by a factory that takes its dependencies, rather than
 * importing a shared client from somewhere. That is what keeps the server
 * independently testable and keeps Prisma's lifecycle owned by server.ts.
 */
export function createHealthRouter(deps: HealthServiceDeps): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const health = await getHealth(deps);
    // 503 when degraded so a caller can rely on the status code alone.
    res.status(health.status === 'ok' ? 200 : 503).json(health);
  });

  return router;
}
