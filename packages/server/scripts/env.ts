import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StartNayaroServerOptions } from '../src/server';
import type { Logger } from '../src/utils/logger';
import {
  DEFAULT_EMAIL_FROM,
  createLogMailer,
  createResendMailer,
  createUnconfiguredMailer,
  type Mailer,
} from '../src/modules/email/mailer';

const serverPackageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(serverPackageDir, '..', '..');

/** Loads the repository's .env (if present) into process.env, without overriding. */
export function loadEnvironment(): void {
  for (const candidate of [resolve(repoRoot, '.env'), resolve(serverPackageDir, '.env')]) {
    if (existsSync(candidate)) process.loadEnvFile(candidate);
  }
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseTrustProxy(value: string | undefined): boolean | number | string {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return true;
  const asNumber = Number(value);
  return Number.isInteger(asNumber) ? asNumber : value;
}

export function resolveDatabaseLocation(): string {
  const configured = process.env['DATABASE_URL'];
  if (process.env['VERCEL'] === '1' && process.env['VERCEL_ENV'] !== 'development') {
    if (!configured || !/^(?:libsql|https|wss):\/\//i.test(configured)) {
      throw new Error('Vercel requires DATABASE_URL pointing to a managed libSQL database.');
    }
  }
  if (configured) return configured;
  const file = resolve(serverPackageDir, '.data', 'nayaro.db');
  mkdirSync(dirname(file), { recursive: true });
  return file;
}

/**
 * Which mailer this deployment uses: Resend when RESEND_API_KEY is set; in
 * production without one, a mailer that refuses (sign-up says email is not set
 * up, everything else keeps working); in development, the log.
 */
export function mailerFromEnvironment(logger: Logger): Mailer {
  const apiKey = process.env['RESEND_API_KEY'];
  const from = process.env['EMAIL_FROM'] ?? DEFAULT_EMAIL_FROM;
  if (apiKey) return createResendMailer({ apiKey, from, logger: logger.child('email') });
  if (process.env['NODE_ENV'] === 'production') {
    logger.warn('RESEND_API_KEY is not set: restaurant sign-up cannot send verification codes.');
    return createUnconfiguredMailer();
  }
  logger.info('RESEND_API_KEY is not set: verification codes are printed to this log.');
  return createLogMailer(logger.child('email'));
}

/** Maps environment variables onto explicit server options. */
export function serverOptionsFromEnvironment(): StartNayaroServerOptions {
  const production = process.env['NODE_ENV'] === 'production';
  const webOrigins = list(process.env['WEB_ORIGINS']);
  // Preview deployments have their own origin; use Vercel's trusted environment
  // metadata instead of trusting arbitrary incoming Host headers.
  if (process.env['VERCEL'] === '1') {
    for (const name of ['VERCEL_URL', 'VERCEL_PROJECT_PRODUCTION_URL']) {
      const host = process.env[name];
      if (host) webOrigins.push(`https://${host}`);
    }
  }
  if (webOrigins.length === 0 && !production) webOrigins.push('http://localhost:5180');
  if (production && webOrigins.length === 0) {
    throw new Error('WEB_ORIGINS must list the web application origin(s) in production.');
  }

  const authToken = process.env['DATABASE_AUTH_TOKEN'];
  return {
    host: process.env['HOST'] ?? '0.0.0.0',
    port: Number(process.env['PORT'] ?? 4000),
    databaseFilePath: resolveDatabaseLocation(),
    ...(authToken ? { databaseAuthToken: authToken } : {}),
    webOrigins,
    trustProxy: parseTrustProxy(
      process.env['TRUST_PROXY'] ?? (process.env['VERCEL'] === '1' ? '1' : undefined),
    ),
    hsts: production,
    ...(process.env['API_RATE_LIMIT_PER_MINUTE']
      ? { apiRequestsPerMinute: Number(process.env['API_RATE_LIMIT_PER_MINUTE']) }
      : {}),
    ...(process.env['REGISTRATIONS_PER_HOUR']
      ? { registrationsPerHour: Number(process.env['REGISTRATIONS_PER_HOUR']) }
      : {}),
  };
}
