import type { RequestHandler } from 'express';
import { ApiError } from '../utils/apiError';

/**
 * Terminal middleware: anything that reached here matched no route.
 *
 * It hands off to the error handler rather than responding directly, so every
 * error response in the application is produced in exactly one place.
 */
export function createNotFoundHandler(): RequestHandler {
  return (req, _res, next) => {
    next(ApiError.notFound(`No route matches ${req.method} ${req.path}`));
  };
}
