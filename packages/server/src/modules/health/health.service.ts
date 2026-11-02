import type { NayaroPrismaClient } from '@nayaro/database';
import type { Logger } from '../../utils/logger';
import type { DependencyStatus, HealthResponse, RealtimeStatus } from '@nayaro/shared';

export interface HealthServiceDeps {
  readonly prisma: NayaroPrismaClient;
  readonly logger: Logger;
  /** Wall-clock ms when the server finished starting. */
  readonly startedAt: number;
  /** Set false if Socket.IO failed to initialise. */
  readonly realtimeReady: () => boolean;
}

/**
 * Checks the database with the cheapest possible round trip.
 *
 * `SELECT 1` is deliberate: it proves the connection and the query path
 * without depending on any table. In particular it does NOT use the temporary
 * HealthProbe model - that folder is scheduled for deletion in Phase 3, and
 * wiring the health endpoint to it would turn a clean delete into a breakage.
 */
async function checkDatabase(deps: HealthServiceDeps): Promise<DependencyStatus> {
  try {
    await deps.prisma.$queryRaw`SELECT 1`;
    return 'connected';
  } catch (error: unknown) {
    // Full detail server-side; the response body says only "error".
    deps.logger.error('Database health check failed', error);
    return 'error';
  }
}

export async function getHealth(deps: HealthServiceDeps): Promise<HealthResponse> {
  const database = await checkDatabase(deps);
  const realtime: RealtimeStatus = deps.realtimeReady() ? 'ready' : 'error';

  return {
    status: database === 'connected' && realtime === 'ready' ? 'ok' : 'degraded',
    database,
    realtime,
    uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000),
  };
}
