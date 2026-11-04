import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server as SocketIOServer } from 'socket.io';
import express from 'express';
import {
  applyPendingMigrations,
  assertDatabaseIntegrity,
  createPrismaClient,
  type NayaroPrismaClient,
} from '@nayaro/database';
import { createNayaroApp } from './app';
import { createLogMailer, type Mailer } from './modules/email/mailer';
import type { EnquiryHubConfig } from './modules/enquiries/enquiries.routes';
import {
  resolveServerConfig,
  type ResolvedServerConfig,
  type ServerConfigInput,
} from './config/serverConfig';
import { createOriginPolicy } from './middleware/cors';
import { pruneExpiredSessions } from './modules/auth/session.service';
import { closeSocketServer, createSocketServer } from './socket/socketServer';
import { createRealtimeEmitter } from './socket/realtimeEmitter';
import { createLogger, type Logger } from './utils/logger';

/**
 * Owns the lifetime of everything the API needs: the database connection, the
 * HTTP listener and Socket.IO.
 *
 * Nothing here calls `process.exit()`; the caller owns the process. There is
 * deliberately no module-level Prisma singleton, which is what makes it safe
 * to start several servers in one process (the tests do).
 */
export interface NayaroServerHandle {
  readonly config: ResolvedServerConfig;
  readonly baseUrl: string;
  readonly httpServer: HttpServer;
  readonly io: SocketIOServer;
  readonly prisma: NayaroPrismaClient;
  readonly logger: Logger;
  readonly stopHousekeeping: () => void;
  /** Flipped by stopNayaroServer so a second call is a harmless no-op. */
  stopped: boolean;
}

export interface StartNayaroServerOptions extends ServerConfigInput {
  /** Overrides the default logger. Mostly useful in tests. */
  readonly logger?: Logger;
  /** How often open sockets have their session rechecked. Tests shorten it. */
  readonly socketSessionRecheckMs?: number;
  /** Managed platforms run migrations separately before deploying. */
  readonly applyMigrations?: boolean;
  /** Sends sign-up codes. Defaults to printing them to the log. */
  readonly mailer?: Mailer;
  /** The central Nayaro inbox for quote and demo requests; null leaves it off. */
  readonly enquiryHub?: EnquiryHubConfig | null;
}

const SESSION_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

export async function startNayaroServer(
  options: StartNayaroServerOptions,
): Promise<NayaroServerHandle> {
  const handle = await createNayaroServer(options);
  try {
    await listen(handle.httpServer, handle.config.host, handle.config.port);
    const boundPort = (handle.httpServer.address() as AddressInfo).port;
    const baseUrl = handle.config.baseUrl.replace(/:\d+$/, `:${String(boundPort)}`);
    handle.logger.info(`Listening on ${baseUrl}`);
    return { ...handle, baseUrl };
  } catch (error: unknown) {
    await stopNayaroServer(handle);
    throw error;
  }
}

/** Creates the API and WebSocket server without opening a listening port. */
export async function createNayaroServer(
  options: StartNayaroServerOptions,
): Promise<NayaroServerHandle> {
  const config = resolveServerConfig(options);
  const logger = options.logger ?? createLogger({ scope: 'nayaro:api', silent: config.silent });

  // Each step that acquires something registers how to release it, so a
  // failure part-way through startup leaves nothing open behind it.
  const unwind: Array<() => Promise<void>> = [];
  const rollback = async (): Promise<void> => {
    for (const undo of unwind.reverse()) {
      try {
        await undo();
      } catch (error: unknown) {
        logger.error('Cleanup step failed during rolled-back startup', error);
      }
    }
  };

  try {
    const database = {
      databaseFilePath: config.databaseFilePath,
      ...(config.databaseAuthToken ? { authToken: config.databaseAuthToken } : {}),
    };
    if (options.applyMigrations !== false) {
      const migrations = await applyPendingMigrations(database);
      if (migrations.applied.length > 0) {
        logger.info(
          `Applied ${String(migrations.applied.length)} migration(s)`,
          migrations.applied,
        );
      }
    }

    const prisma = createPrismaClient(database);
    unwind.push(() => prisma.$disconnect());

    await assertDatabaseIntegrity(prisma);
    await prisma.$queryRaw`SELECT 1`;
    logger.info('Database ready');

    const isAllowedOrigin = createOriginPolicy(config.webOrigins);
    let io: SocketIOServer | null = null;
    const startedAt = Date.now();
    const app = createNayaroApp({
      prisma,
      logger,
      startedAt,
      isAllowedOrigin,
      trustProxy: config.trustProxy,
      hsts: config.hsts,
      apiRequestsPerMinute: config.apiRequestsPerMinute,
      registrationsPerHour: config.registrationsPerHour,
      mailer: options.mailer ?? createLogMailer(logger.child('email')),
      allowDirectRegistration: config.allowDirectRegistration,
      enquiryHub: options.enquiryHub ?? null,
      realtimeReady: () => io !== null,
      realtime: createRealtimeEmitter(() => io),
    });

    const root = express();
    root.disable('x-powered-by');
    root.set('trust proxy', config.trustProxy);
    root.use(config.apiBasePath || '/', app);
    const httpServer = createServer(root);
    unwind.push(() => closeHttpServer(httpServer));

    io = createSocketServer(httpServer, {
      logger: logger.child('socket'),
      prisma,
      isAllowedOrigin,
      path: `${config.apiBasePath}/socket.io`,
      ...(options.socketSessionRecheckMs !== undefined
        ? { sessionRecheckMs: options.socketSessionRecheckMs }
        : {}),
    });
    const socketServer = io;
    unwind.push(() => closeSocketServer(socketServer));

    if (config.webOrigins.length === 0) {
      logger.warn('WEB_ORIGINS is empty: browsers on other origins cannot call this API.');
    }

    const prune = (): void => {
      void pruneExpiredSessions(prisma).catch((error: unknown) => {
        logger.warn('Expired session cleanup failed', error);
      });
    };
    prune();
    const pruneTimer = setInterval(prune, SESSION_PRUNE_INTERVAL_MS);
    pruneTimer.unref();

    return {
      config,
      baseUrl: config.baseUrl,
      httpServer,
      io: socketServer,
      prisma,
      logger,
      stopHousekeeping: () => clearInterval(pruneTimer),
      stopped: false,
    };
  } catch (error: unknown) {
    await rollback();
    throw error;
  }
}

export async function stopNayaroServer(handle: NayaroServerHandle): Promise<void> {
  if (handle.stopped) return;
  handle.stopped = true;

  handle.stopHousekeeping();
  await closeSocketServer(handle.io);
  await closeHttpServer(handle.httpServer);
  await handle.prisma.$disconnect();
  handle.logger.info('Stopped');
}

function listen(server: HttpServer, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening);
      if (error.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Nayaro RMS API cannot start: port ${String(port)} on ${host} is already in use. ` +
              `Stop the other process or set PORT to a free port.`,
          ),
        );
        return;
      }
      reject(error);
    };

    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * How long an in-flight request may take to finish during shutdown before we
 * drop its socket. A request that is mid-way through
 * writing an order should be allowed to commit, not severed.
 */
const SHUTDOWN_GRACE_MS = 3000;

/**
 * Closes the HTTP listener gracefully, but still releases the port promptly.
 *
 * Three phases, and each one exists for a reason:
 *
 *   1. `close()`                 stop accepting new connections. On its own
 *                                this waits forever for keep-alive clients,
 *                                which would leave the port held.
 *   2. `closeIdleConnections()`  drop keep-alive sockets that are sitting idle.
 *                                This is what actually frees the port, and it
 *                                does not interrupt any request in progress.
 *   3. `closeAllConnections()`   only after a grace period, and only for
 *                                connections still busy. A request that has
 *                                not finished in three seconds is not going to.
 *
 * Safe to call when the server is already closed, which happens because
 * `io.close()` closes the attached HTTP server as a side effect.
 */
function closeHttpServer(server: HttpServer): Promise<void> {
  if (!server.listening) {
    server.closeAllConnections();
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const forceTimer = setTimeout(() => {
      server.closeAllConnections();
    }, SHUTDOWN_GRACE_MS);
    // Do not let the grace timer itself keep the process alive.
    forceTimer.unref();

    server.close((error) => {
      clearTimeout(forceTimer);
      if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(error);
        return;
      }
      resolve();
    });

    server.closeIdleConnections();
  });
}
