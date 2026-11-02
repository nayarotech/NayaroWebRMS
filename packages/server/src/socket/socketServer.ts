import type { Server as HttpServer } from 'node:http';
import { Server as SocketIOServer, type Socket } from 'socket.io';
import type { NayaroPrismaClient } from '@nayaro/database';
import { resolveSession } from '../modules/auth/session.service';
import type { Logger } from '../utils/logger';

/**
 * Socket.IO attached to the same HTTP server as the REST API.
 *
 * One port, one origin policy, one thing for Electron to start and stop.
 *
 * AUTHENTICATED, LIKE EVERY OTHER ROUTE. Events are only invalidation
 * signals, but "table 6 just paid" reaching another restaurant is still a
 * tenant leak. A socket presents the same bearer token the REST API takes, in
 * the handshake's `auth` field, and is refused without one - or when its
 * tenant is suspended.
 *
 * Each socket then joins its restaurant's room and events go to that room
 * only - never `io.emit` to everyone connected.
 *
 * A session can end while its socket stays open: logout on another terminal,
 * a password change, an owner switching the account off. The REST API notices
 * on the next request; a socket makes no requests, so it is rechecked on a
 * timer and dropped when its session no longer resolves.
 */
export interface CreateSocketServerDeps {
  readonly logger: Logger;
  readonly prisma: NayaroPrismaClient;
  readonly isAllowedOrigin: (origin: string | undefined) => boolean;
  /** How often a connected socket's session is rechecked. Tests shorten it. */
  readonly sessionRecheckMs?: number;
}

/** Long enough to cost nothing; short enough that a revoked phone goes dark promptly. */
export const SOCKET_SESSION_RECHECK_MS = 60 * 1000;

/** The refusal a client sees. One message for every reason, as with REST. */
export const SOCKET_UNAUTHENTICATED = 'UNAUTHENTICATED';

/** The room every socket of one restaurant joins, and the only target events go to. */
export function restaurantRoom(restaurantId: string): string {
  return `restaurant:${restaurantId}`;
}

interface SocketAuthData {
  readonly token: string;
  readonly restaurantId: string;
  readonly username: string;
}

function readHandshakeToken(auth: unknown): string | null {
  if (typeof auth !== 'object' || auth === null) return null;
  const token = (auth as Record<string, unknown>)['token'];
  return typeof token === 'string' && token.length > 0 ? token : null;
}

export function createSocketServer(
  httpServer: HttpServer,
  deps: CreateSocketServerDeps,
): SocketIOServer {
  const recheckMs = deps.sessionRecheckMs ?? SOCKET_SESSION_RECHECK_MS;

  const io = new SocketIOServer(httpServer, {
    // Socket.IO does its own CORS check, so it needs the same policy the REST
    // middleware applies - not a second, looser one.
    cors: {
      origin: (origin, callback) => {
        callback(null, deps.isAllowedOrigin(origin));
      },
      credentials: false,
    },
  });

  io.use((socket, next) => {
    const token = readHandshakeToken(socket.handshake.auth);
    if (token === null) {
      next(new Error(SOCKET_UNAUTHENTICATED));
      return;
    }

    resolveSession(deps.prisma, token)
      .then((resolved) => {
        if (!resolved) {
          next(new Error(SOCKET_UNAUTHENTICATED));
          return;
        }
        const data: SocketAuthData = {
          token,
          restaurantId: resolved.staff.restaurantId,
          username: resolved.staff.username,
        };
        socket.data = data;
        next();
      })
      .catch((error: unknown) => {
        deps.logger.error('Socket authentication failed', error);
        next(new Error(SOCKET_UNAUTHENTICATED));
      });
  });

  io.on('connection', (socket: Socket) => {
    const auth = socket.data as SocketAuthData;
    void socket.join(restaurantRoom(auth.restaurantId));
    deps.logger.info(`client connected (${socket.id}, ${auth.username})`);

    const recheck = setInterval(() => {
      void resolveSession(deps.prisma, auth.token, { touch: false })
        .then((resolved) => {
          if (resolved) return;
          deps.logger.info(`session ended; dropping socket (${socket.id}, ${auth.username})`);
          socket.disconnect(true);
        })
        .catch(() => {
          // A database hiccup is not a revoked session. Keep the socket and
          // try again on the next tick.
        });
    }, recheckMs);
    recheck.unref();

    socket.on('disconnect', (reason) => {
      clearInterval(recheck);
      deps.logger.info(`client disconnected (${socket.id}): ${reason}`);
    });
  });

  return io;
}

/**
 * Closes Socket.IO and waits for it to finish.
 *
 * Note: `io.close()` also closes the HTTP server it was attached to, which is
 * why server.ts guards its own close afterwards instead of assuming the
 * listener is still up.
 */
export function closeSocketServer(io: SocketIOServer): Promise<void> {
  return new Promise((resolve) => {
    io.close(() => {
      resolve();
    });
  });
}
