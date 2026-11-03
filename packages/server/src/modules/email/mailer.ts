import { ApiError } from '../../utils/apiError';
import type { Logger } from '../../utils/logger';

export interface OutgoingEmail {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

/**
 * Sends one transactional email. The server package never reads the
 * environment, so the deployment decides which implementation it gets
 * (scripts/env.ts): Resend in production, the log in development, a capture
 * in tests.
 */
export interface Mailer {
  send(email: OutgoingEmail): Promise<void>;
}

export const DEFAULT_EMAIL_FROM = 'Nayaro RMS <noreply@nayaro.tech>';

/**
 * Resend over its HTTP API. Plain `fetch` rather than the SDK: one endpoint,
 * no extra dependency, and nothing to keep patched.
 */
export function createResendMailer(options: {
  readonly apiKey: string;
  readonly from?: string;
  readonly logger: Logger;
}): Mailer {
  const from = options.from ?? DEFAULT_EMAIL_FROM;
  return {
    async send(email) {
      let response: Response;
      try {
        response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ from, to: [email.to], subject: email.subject, html: email.html, text: email.text }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error: unknown) {
        options.logger.error('Email provider unreachable', error);
        throw emailFailed();
      }
      if (!response.ok) {
        // The provider's message names the problem (unverified domain, bad
        // key) - useful in the log, never shown to the person signing up.
        options.logger.error(`Email provider refused (${String(response.status)}): ${await response.text()}`);
        throw emailFailed();
      }
    },
  };
}

/** Development: no provider, so the code is printed where the developer is looking. */
export function createLogMailer(logger: Logger): Mailer {
  return {
    send(email) {
      logger.info(`[email] to ${email.to} - ${email.subject}\n${email.text}`);
      return Promise.resolve();
    },
  };
}

/**
 * Production with no key configured. Sign-in and service keep working; only
 * the flows that must send an email refuse, with a message that says why.
 */
export function createUnconfiguredMailer(): Mailer {
  return {
    send() {
      return Promise.reject(
        new ApiError(503, 'EMAIL_NOT_CONFIGURED', 'Email sending is not set up yet. Contact Nayaro Technology.'),
      );
    },
  };
}

function emailFailed(): ApiError {
  return new ApiError(502, 'EMAIL_FAILED', 'We could not send the email. Check the address and try again.');
}
