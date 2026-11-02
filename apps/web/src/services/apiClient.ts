import type { ApiErrorBody } from '@nayaro/shared';
import { API_BASE_URL } from '../config/env';

/**
 * The web application's single door to the Nayaro RMS API.
 *
 * No component, hook or feature may call `fetch` against the API directly.
 * Everything goes through here, which buys three things:
 *
 *  - the base URL comes from build configuration and is used in one place.
 *  - every failure arrives as one error type, so screens render states rather
 *    than decoding fetch semantics.
 *  - internal detail never reaches the UI: the server already refuses to put
 *    paths or stack traces in a response, and this layer keeps the raw
 *    Response object from escaping either.
 *
 * Native fetch, deliberately: Axios would add a dependency for interceptors
 * we do not need.
 */

export type ApiFailureKind =
  /** The request never got an answer - server down, or connection refused. */
  | 'network'
  /** The server answered with a non-2xx status. */
  | 'http'
  /** The server answered, but not with the JSON we expected. */
  | 'malformed';

export class ApiRequestError extends Error {
  readonly kind: ApiFailureKind;
  /** HTTP status, when there was a response. */
  readonly status: number | null;
  /** Machine-readable code from the server's error envelope, when present. */
  readonly code: string | null;

  constructor(
    kind: ApiFailureKind,
    message: string,
    options: { status?: number; code?: string; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ApiRequestError';
    this.kind = kind;
    this.status = options.status ?? null;
    this.code = options.code ?? null;
  }
}

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/**
 * Token access, registered once at start-up.
 *
 * The auth store OWNS the token; this client only borrows it per request. A
 * getter rather than a copy means there is exactly one place the session
 * lives, and `Authorization: Bearer ...` is written in exactly one place in
 * the whole renderer - here.
 */
let readAuthToken: () => string | null = () => null;
let onUnauthorized: ((code: string | null) => void) | null = null;

export function setAuthTokenGetter(getter: () => string | null): void {
  readAuthToken = getter;
}

/**
 * Called when the server rejects a request that DID carry a token - i.e. the
 * session expired, was revoked, or the account was deactivated. Never fires
 * for a failed login, which legitimately 401s without a token attached.
 */
export function setUnauthorizedHandler(handler: (code: string | null) => void): void {
  onUnauthorized = handler;
}

function isApiErrorBody(value: unknown): value is ApiErrorBody {
  if (typeof value !== 'object' || value === null || !('error' in value)) return false;
  const { error } = value as { error: unknown };
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    'message' in error &&
    typeof (error as { code: unknown }).code === 'string' &&
    typeof (error as { message: unknown }).message === 'string'
  );
}

async function request<TResponse>(
  method: HttpMethod,
  path: string,
  body?: unknown,
  requestKey?: string,
  anonymous = false,
): Promise<TResponse> {
  const token = anonymous ? null : readAuthToken();
  const headers: Record<string, string> = {};
  if (requestKey !== undefined) headers['Idempotency-Key'] = requestKey;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token !== null) headers['Authorization'] = `Bearer ${token}`;

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 12_000);
  let response: Response;
  let raw: string;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      method,
      headers,
      signal: abort.signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    raw = await response.text();
  } catch (cause: unknown) {
    throw new ApiRequestError('network', 'Could not reach Nayaro RMS. Check your internet connection and try again.', { cause });
  } finally {
    clearTimeout(timer);
  }

  let parsed: unknown = null;
  if (raw.length > 0) {
    try {
      parsed = JSON.parse(raw);
    } catch (cause: unknown) {
      throw new ApiRequestError('malformed', 'The server sent an unreadable response.', {
        status: response.status,
        cause,
      });
    }
  }

  const errorCode = isApiErrorBody(parsed) ? parsed.error.code : null;
  if (
    token !== null &&
    (response.status === 401 ||
      errorCode === 'TENANT_SUSPENDED' ||
      errorCode === 'SUBSCRIPTION_EXPIRED')
  ) {
    // Our token was rejected: expired, revoked, the account was switched off
    // or the restaurant can no longer operate. Drop the session so the router
    // falls back to sign-in rather than leaving a half-authenticated UI.
    onUnauthorized?.(errorCode);
  }

  if (!response.ok) {
    // The server's error envelope is a deliberate contract; if it is present we
    // surface its message, which is already safe to show.
    const message = isApiErrorBody(parsed)
      ? parsed.error.message
      : `The server returned ${String(response.status)}.`;
    throw new ApiRequestError('http', message, {
      status: response.status,
      ...(isApiErrorBody(parsed) ? { code: parsed.error.code } : {}),
    });
  }

  // Unchecked cast at the boundary: both sides of this contract are ours and
  // share the type from @nayaro/shared. When Phase 3 introduces domain payloads
  // that a stale client could misread, this is where Zod parsing belongs.
  return parsed as TResponse;
}

/** One immediate retry for receipt-backed endpoints only. Nothing is queued offline.
 * Keep the same key, payload and staff session across the two attempts.
 */
async function postWithReceipt<TResponse>(path: string, body: unknown): Promise<TResponse> {
  const key = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  const snapshot: unknown = JSON.parse(JSON.stringify(body));
  const token = readAuthToken();
  try {
    return await request<TResponse>('POST', path, snapshot, key);
  } catch (error: unknown) {
    if (
      !(error instanceof ApiRequestError) ||
      error.kind !== 'network' ||
      readAuthToken() !== token
    ) {
      throw error;
    }
    return request<TResponse>('POST', path, snapshot, key);
  }
}

export const apiClient = {
  postWithReceipt,
  get: <TResponse>(path: string): Promise<TResponse> => request<TResponse>('GET', path),
  /** Public endpoints: never sends the staff token. */
  getPublic: <TResponse>(path: string): Promise<TResponse> =>
    request<TResponse>('GET', path, undefined, undefined, true),
  post: <TResponse>(path: string, body?: unknown): Promise<TResponse> =>
    request<TResponse>('POST', path, body),
  patch: <TResponse>(path: string, body?: unknown): Promise<TResponse> =>
    request<TResponse>('PATCH', path, body),
  delete: <TResponse>(path: string): Promise<TResponse> => request<TResponse>('DELETE', path),
};
