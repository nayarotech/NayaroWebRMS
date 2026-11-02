/**
 * Browser requests use the public /api route on this deployment by default.
 * VITE_API_URL can override it for a separately hosted API. Runtime-only service
 * binding URLs must never be embedded in this static browser bundle.
 */
export const API_BASE_URL: string = (
  (import.meta.env?.['VITE_API_URL'] as string | undefined) ?? '/api'
).replace(/\/+$/, '');
