import type { RequestHandler } from 'express';

/**
 * Headers for an API that only ever returns JSON. The policy is as tight as it
 * can be because nothing here should render: no scripts, no frames, no
 * embedding. The web application sets its own, page-appropriate policy.
 */
export function createSecurityHeaders(options: { readonly hsts: boolean }): RequestHandler {
  return (_req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // Authenticated responses carry restaurant data; never let a shared cache keep them.
    res.setHeader('Cache-Control', 'no-store');
    if (options.hsts) {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  };
}
