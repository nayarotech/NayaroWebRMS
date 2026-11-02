import type { Request, RequestHandler } from 'express';
import { ApiError } from '../utils/apiError';
import { clientAddress } from '../utils/clientAddress';

export interface RateLimitOptions {
  readonly windowMs: number;
  readonly max: number;
  /** Defaults to the client address. */
  readonly key?: (req: Request) => string;
  readonly message?: string;
  readonly now?: () => number;
}

interface Window {
  count: number;
  startedAt: number;
}

const MAX_TRACKED_KEYS = 50_000;

/**
 * Fixed-window limiter held in memory.
 *
 * Suitable for a single API instance. Running several instances behind a load
 * balancer needs a shared store (Redis) behind this same interface, otherwise
 * each instance grants its own allowance.
 */
export function createRateLimit(options: RateLimitOptions): RequestHandler {
  const windows = new Map<string, Window>();
  const now = options.now ?? Date.now;
  const keyOf = options.key ?? clientAddress;

  return (req, res, next) => {
    const at = now();
    const key = keyOf(req);
    let window = windows.get(key);
    if (window === undefined || at - window.startedAt >= options.windowMs) {
      if (windows.size >= MAX_TRACKED_KEYS) {
        for (const [candidate, state] of windows) {
          if (at - state.startedAt >= options.windowMs) windows.delete(candidate);
        }
        if (windows.size >= MAX_TRACKED_KEYS) {
          const oldest = windows.keys().next().value;
          if (oldest !== undefined) windows.delete(oldest);
        }
      }
      window = { count: 0, startedAt: at };
      windows.set(key, window);
    }
    window.count += 1;

    if (window.count > options.max) {
      const retryAfter = Math.ceil((window.startedAt + options.windowMs - at) / 1000);
      res.setHeader('Retry-After', String(Math.max(1, retryAfter)));
      next(
        new ApiError(
          429,
          'RATE_LIMITED',
          options.message ?? 'Too many requests. Please wait a moment and try again.',
        ),
      );
      return;
    }
    next();
  };
}
