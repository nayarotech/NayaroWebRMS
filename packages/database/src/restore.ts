import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createClient } from '@libsql/client';
import { BUNDLED_MIGRATIONS } from './migrations.generated';
import { toDatabaseFileUrl } from './paths';

/**
 * Restoring a backup, in two halves that never overlap.
 *
 * The live database cannot be swapped while it is open: in WAL mode its state
 * is spread over three files, and replacing one under a running connection is
 * how a restore turns into a corruption. So:
 *
 *   1. STAGE, while the server runs. The chosen backup is copied next to the
 *      live database as `restore-pending.db` and checked there - integrity, a
 *      restaurant inside, and nothing from a newer version of the app. Nothing
 *      live is touched; a bad backup is refused here, with the till still
 *      serving.
 *
 *   2. APPLY, at startup, before anything opens the database. The live files
 *      are moved aside (never deleted) and the staged file takes their place.
 *      The migrator then runs as on any boot, bringing an older backup up to
 *      the current schema.
 *
 * Between the two, the restore is a single file on disk. If the app is quit
 * rather than restarted, it applies on the next launch - which is what the
 * owner asked for.
 *
 * WHY "AT STARTUP" MEANS A NEW PROCESS. On Windows, libSQL keeps a database
 * file locked for the life of the process, even after its client is closed.
 * A file this process has ever opened cannot be renamed or deleted until it
 * exits. So the desktop applies a restore by relaunching the app, never by
 * restarting the server in place - and staging below never renames a file it
 * has opened, only copies of it.
 */

const PENDING_FILE_NAME = 'restore-pending.db';
/** Checked copies. Unique per attempt, because an earlier one may still be locked. */
const STAGING_PREFIX = 'restore-staging-';
const INCOMING_SUFFIX = '.incoming';
/** The live files, moved aside rather than deleted: the last way back. */
const REPLACED_SUFFIX = '.before-restore';
const SQLITE_SIDE_FILES = ['-wal', '-shm', '-journal'] as const;

export class RestoreRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RestoreRejectedError';
  }
}

function pendingPath(databaseFilePath: string): string {
  return join(dirname(databaseFilePath), PENDING_FILE_NAME);
}

/** True when a staged restore will be applied at the next start. */
export function hasStagedRestore(databaseFilePath: string): boolean {
  return existsSync(pendingPath(databaseFilePath));
}

/** Withdraws a staged restore that has not been applied yet. */
export function cancelStagedRestore(databaseFilePath: string): void {
  rmSync(pendingPath(databaseFilePath), { force: true });
}

/**
 * Copies `sourceFilePath` into place as the pending restore, after proving it
 * is a database this build can open. Throws RestoreRejectedError, with words
 * an owner can read, for a backup that would not work.
 */
export async function stageRestore(
  databaseFilePath: string,
  sourceFilePath: string,
): Promise<void> {
  const dir = dirname(databaseFilePath);
  const nonce = `${String(Date.now())}-${randomBytes(4).toString('hex')}`;
  const staging = join(dir, `${STAGING_PREFIX}${nonce}.db`);
  const incoming = join(dir, `${PENDING_FILE_NAME}.${nonce}${INCOMING_SUFFIX}`);

  try {
    // Checked as a COPY, so even reading the backup cannot alter the original.
    copyFileSync(sourceFilePath, staging);
    await assertRestorable(staging);

    // The checked copy has been opened, so on Windows it is locked until this
    // process exits and cannot be renamed. Copy it once more to a file nothing
    // has opened, and rename THAT - same directory, so atomic: the pending
    // file is either the whole checked copy or absent, never half of one.
    copyFileSync(staging, incoming);
    renameSync(incoming, pendingPath(databaseFilePath));
  } finally {
    removeQuietly(staging);
    removeQuietly(incoming);
  }
}

/**
 * Best effort. A locked staging copy stays until the next launch, which
 * sweeps it - and it must never turn a clear refusal into a disk error.
 */
function removeQuietly(filePath: string): void {
  try {
    rmSync(filePath, { force: true });
  } catch {
    /* swept at the next startup */
  }
}

/** Clears staging leftovers from earlier attempts. Runs at startup, when nothing holds them. */
function sweepLeftovers(dir: string): void {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(STAGING_PREFIX) || name.endsWith(INCOMING_SUFFIX)) {
      removeQuietly(join(dir, name));
    }
  }
}

async function assertRestorable(filePath: string): Promise<void> {
  const client = createClient({ url: toDatabaseFileUrl(filePath) });
  try {
    let verdict: string;
    try {
      const check = await client.execute('PRAGMA quick_check');
      verdict = String(check.rows[0]?.['quick_check'] ?? 'unknown');
    } catch {
      throw new RestoreRejectedError('That file is not a Nayaro RMS database.');
    }
    if (verdict !== 'ok') {
      throw new RestoreRejectedError('That backup is damaged and cannot be restored.');
    }

    let applied: string[];
    try {
      const ledger = await client.execute(
        'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
      );
      applied = ledger.rows.map((row) => String(row['migration_name']));
    } catch {
      throw new RestoreRejectedError('That file is not a Nayaro RMS database.');
    }

    // A backup from a NEWER version has tables this build does not know how
    // to keep consistent. Opening it would quietly ignore them at best.
    const known = new Set(BUNDLED_MIGRATIONS.map((migration) => migration.name));
    if (applied.some((name) => !known.has(name))) {
      throw new RestoreRejectedError(
        'That backup was made by a newer version of Nayaro RMS. Update this app first.',
      );
    }

    let restaurants = 0;
    try {
      const count = await client.execute('SELECT COUNT(*) AS n FROM "Restaurant"');
      restaurants = Number(count.rows[0]?.['n'] ?? 0);
    } catch {
      restaurants = 0;
    }
    if (restaurants === 0) {
      throw new RestoreRejectedError(
        'That backup has no restaurant in it, so there is nothing to restore.',
      );
    }
  } finally {
    client.close();
  }
}

export interface AppliedRestore {
  /** Where the replaced live database now sits. */
  readonly replacedFilePath: string;
}

/**
 * Swaps a staged restore into place. Must run before anything opens the
 * database - startNayaroServer calls it ahead of the migrator. Returns null
 * when nothing was staged.
 */
export function applyStagedRestore(databaseFilePath: string): AppliedRestore | null {
  sweepLeftovers(dirname(databaseFilePath));
  const pending = pendingPath(databaseFilePath);
  if (!existsSync(pending)) return null;

  const replacedFilePath = `${databaseFilePath}${REPLACED_SUFFIX}`;
  // Only the most recent replaced copy is kept here. The safety backup taken
  // when the restore was staged is the durable one, in the backups folder.
  for (const suffix of ['', ...SQLITE_SIDE_FILES]) {
    rmSync(`${replacedFilePath}${suffix}`, { force: true });
  }

  if (existsSync(databaseFilePath)) {
    renameSync(databaseFilePath, replacedFilePath);
  }
  // A -wal left beside the restored file would be replayed INTO it - someone
  // else's transactions applied to the backup. Move every side file aside too.
  for (const suffix of SQLITE_SIDE_FILES) {
    const side = `${databaseFilePath}${suffix}`;
    if (existsSync(side)) renameSync(side, `${replacedFilePath}${suffix}`);
  }

  renameSync(pending, databaseFilePath);
  return { replacedFilePath };
}
