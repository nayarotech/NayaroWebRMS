import type { Request } from 'express';

/**
 * The caller's address as Express resolved it. Behind a reverse proxy this is
 * only meaningful when `trust proxy` is configured to that proxy; without it,
 * X-Forwarded-For is whatever the caller typed and is ignored.
 */
export function clientAddress(req: Request): string {
  return (req.ip ?? req.socket.remoteAddress ?? 'unknown').slice(0, 64);
}
