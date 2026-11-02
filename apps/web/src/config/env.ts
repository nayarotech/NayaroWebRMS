/**
 * Where the API lives. Set VITE_API_URL at build time for each deployment; the
 * value is public (it is in the browser bundle) and must never carry secrets.
 */
export const API_BASE_URL: string = (
  (import.meta.env?.['VITE_API_URL'] as string | undefined) ?? 'http://localhost:4000'
).replace(/\/+$/, '');
