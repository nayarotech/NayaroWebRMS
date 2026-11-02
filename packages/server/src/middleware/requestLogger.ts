import type { RequestHandler } from 'express';
import type { Logger } from '../utils/logger';

/**
 * One line per request, at debug level.
 *
 * Debug rather than info on purpose: once the renderer polls /health the info
 * stream would become unreadable. Raise the logger's level to 'debug' when you
 * actually want to watch traffic.
 */
export function createRequestLogger(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const startedAt = Date.now();

    res.once('finish', () => {
      const duration = Date.now() - startedAt;
      logger.debug(
        `${req.method} ${req.originalUrl} -> ${String(res.statusCode)} (${String(duration)}ms)`,
      );
    });

    next();
  };
}
