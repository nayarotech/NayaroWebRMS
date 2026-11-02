import type { ApiErrorBody } from '@nayaro/shared';

/**
 * The one error type the API speaks.
 *
 * Anything thrown that is not an ApiError is treated as a bug: the error
 * handler logs it in full server-side and returns a generic 500 to the client.
 * That split is deliberate - internal detail (stack traces, file paths, SQL)
 * must never reach a response body.
 */
export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
  }

  static notFound(message = 'Resource not found'): ApiError {
    return new ApiError(404, 'NOT_FOUND', message);
  }

  static badRequest(message = 'Invalid request'): ApiError {
    return new ApiError(400, 'BAD_REQUEST', message);
  }

  static serviceUnavailable(message = 'Service unavailable'): ApiError {
    return new ApiError(503, 'SERVICE_UNAVAILABLE', message);
  }
}

// The response shape lives in @nayaro/shared: the renderer parses it too.

export function toApiErrorBody(error: ApiError): ApiErrorBody {
  return { error: { code: error.code, message: error.message } };
}
