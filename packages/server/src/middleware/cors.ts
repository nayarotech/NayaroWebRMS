import cors, { type CorsOptions } from 'cors';
import type { RequestHandler } from 'express';

/**
 * Cross-origin policy for the API: an explicit allowlist of web application
 * origins, configured per deployment (WEB_ORIGINS).
 *
 * CORS decides whose JavaScript may READ our responses. It is not access
 * control - every allowed origin still has to present a valid bearer token -
 * and because authentication is a header rather than a cookie, a cross-site
 * page cannot ride on a signed-in user's credentials (no CSRF exposure).
 * Credentials mode is therefore off.
 */
export function createOriginPolicy(allowedOrigins: readonly string[]): (origin: string | undefined) => boolean {
  const allowed = new Set(allowedOrigins.map((origin) => origin.replace(/\/+$/, '')));
  return (origin) => origin === undefined || allowed.has(origin);
}

export function createCorsMiddleware(isAllowedOrigin: (origin: string | undefined) => boolean): RequestHandler {
  const options: CorsOptions = {
    origin: (origin, callback) => {
      callback(null, isAllowedOrigin(origin));
    },
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
    maxAge: 600,
  };
  return cors(options);
}
