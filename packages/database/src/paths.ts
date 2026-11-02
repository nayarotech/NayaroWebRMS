import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Where Nayaro RMS keeps a restaurant's data on disk.
 *
 * This module knows the *layout* but deliberately not the *root*. The root is
 * supplied by whoever owns the environment:
 *
 *   - production : Electron passes `app.getPath('userData')`
 *   - development: the Prisma CLI config and the dev app pass the repo-local
 *                  `packages/database/.nayaro-dev` folder
 *
 * Keeping the layout in one pure function means development exercises exactly
 * the same code path as a packaged install - only the root differs. It also
 * keeps `@nayaro/database` free of any dependency on Electron.
 */
export interface NayaroDataLayout {
  /** Root of everything Nayaro RMS writes for this installation. */
  readonly rootDir: string;
  /** Holds the live SQLite database. */
  readonly dataDir: string;
  /** Absolute path to the SQLite file itself. */
  readonly databaseFilePath: string;
  /** Reserved for automatic local backups (not implemented yet). */
  readonly backupsDir: string;
  /** Reserved for application logs (not implemented yet). */
  readonly logsDir: string;
}

const DATABASE_FILE_NAME = 'nayaro.db';

/**
 * Windows path separator, built from its char code on purpose.
 *
 * The Prisma CLI parses this file too (prisma7.config.ts imports it) and its
 * loader rejects both an escaped-backslash regex and an escaped-backslash
 * string literal with "Unterminated string constant". This avoids writing a
 * backslash in source at all.
 */
const WINDOWS_SEPARATOR = String.fromCharCode(92);

export function resolveDataLayout(rootDir: string): NayaroDataLayout {
  const dataDir = join(rootDir, 'data');
  return {
    rootDir,
    dataDir,
    databaseFilePath: join(dataDir, DATABASE_FILE_NAME),
    backupsDir: join(rootDir, 'backups'),
    logsDir: join(rootDir, 'logs'),
  };
}

/** Creates the directories if missing. Safe to call on every startup. */
export function ensureDataLayout(layout: NayaroDataLayout): NayaroDataLayout {
  mkdirSync(layout.dataDir, { recursive: true });
  mkdirSync(layout.backupsDir, { recursive: true });
  mkdirSync(layout.logsDir, { recursive: true });
  return layout;
}

/**
 * libSQL and the Prisma CLI both want a `file:` URL. On Windows an absolute
 * path contains backslashes, which the URL parser mangles, so normalise them
 * to forward slashes first.
 */
export function toDatabaseFileUrl(databaseFilePath: string): string {
  const normalised = databaseFilePath.split(WINDOWS_SEPARATOR).join('/');
  return `file:${normalised}`;
}

/**
 * Accepts either a filesystem path or a full libSQL URL (`file:`, `libsql:`,
 * `http(s):`, `ws(s):`). A URL is used as given, which is how the hosted
 * platform points at a managed libSQL server instead of a local file.
 */
export function toDatabaseUrl(pathOrUrl: string): string {
  return /^(file|libsql|https?|wss?):/i.test(pathOrUrl) ? pathOrUrl : toDatabaseFileUrl(pathOrUrl);
}
