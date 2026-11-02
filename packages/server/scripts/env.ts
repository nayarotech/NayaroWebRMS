import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StartNayaroServerOptions } from '../src/server';

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
  if (configured) return configured;
  const file = resolve(serverPackageDir, '.data', 'nayaro.db');
  mkdirSync(dirname(file), { recursive: true });
  return file;
}

/** Maps environment variables onto explicit server options. */
export function serverOptionsFromEnvironment(): StartNayaroServerOptions {
  const production = process.env['NODE_ENV'] === 'production';
  const webOrigins = list(process.env['WEB_ORIGINS']);
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
    trustProxy: parseTrustProxy(process.env['TRUST_PROXY']),
    hsts: production,
    ...(process.env['API_RATE_LIMIT_PER_MINUTE']
      ? { apiRequestsPerMinute: Number(process.env['API_RATE_LIMIT_PER_MINUTE']) }
      : {}),
    ...(process.env['REGISTRATIONS_PER_HOUR']
      ? { registrationsPerHour: Number(process.env['REGISTRATIONS_PER_HOUR']) }
      : {}),
  };
}
