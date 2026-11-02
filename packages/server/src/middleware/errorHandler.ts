import type { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { ApiError, toApiErrorBody } from '../utils/apiError';
import type { Logger } from '../utils/logger';

/**
 * The only place the API turns a thrown value into a response.
 *
 * Express 5 forwards rejected promises from async handlers here automatically,
 * so route code can simply throw and does not need a wrapper.
 *
 * The rule enforced here: an ApiError is something we chose to tell the client
 * about, and its message is safe to send. Anything else is a bug - it is
 * logged in full on the server and the client gets a generic 500 with no
 * stack, no paths, and no internal detail.
 */
export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    // If headers are already sent, Express must close the connection itself.
    if (res.headersSent) {
      next(error);
      return;
    }

    if (error instanceof ApiError) {
      logger.warn(`${req.method} ${req.path} -> ${String(error.statusCode)} ${error.code}`);
      res.status(error.statusCode).json(toApiErrorBody(error));
      return;
    }

    if (error instanceof ZodError) {
      // Validation failures are the caller's fault, but Zod's issue list can
      // describe internal shapes, so we log it and send a flat message.
      logger.warn(`${req.method} ${req.path} -> 400 validation failed`, error.issues);
      // Issue messages come from our own schemas and never echo the input, so
      // the first one is safe to show and tells the user what to fix.
      const message = error.issues[0]?.message ?? 'Request validation failed';
      res.status(400).json(toApiErrorBody(new ApiError(400, 'BAD_REQUEST', message)));
      return;
    }

    logger.error(`Unhandled error on ${req.method} ${req.path}`, error);
    res
      .status(500)
      .json(toApiErrorBody(new ApiError(500, 'INTERNAL_ERROR', 'Internal server error')));
  };
}
