import { randomUUID } from 'node:crypto';
import { createClient, type Client } from '@libsql/client';
import { BUNDLED_MIGRATIONS } from './migrations.generated';
import { toDatabaseUrl } from './paths';

/**
 * Applies Prisma-authored migrations at application startup.
 *
 * Why not `prisma migrate deploy`? That is a CLI, and shipping the Prisma CLI
 * plus its Rust migration engine inside a desktop app is not reasonable.
 * Migrations are still *authored* with `prisma migrate dev` in development;
 * this runner only *applies* the resulting SQL, which is compiled into the
 * build by scripts/bundle-migrations.mjs.
 *
 * Crucially it writes to Prisma's OWN `_prisma_migrations` ledger, in Prisma's
 * own row format, rather than keeping a private one. In development
 * `prisma migrate dev` writes those rows; in production this runner does. One
 * ledger means the two can never disagree about what has been applied, and
 * `prisma migrate status` still reports the truth if a developer runs it.
 *
 * We talk to libSQL directly rather than through Prisma because
 * `executeMultiple` runs a whole migration file in one call - no fragile
 * splitting of SQL on semicolons - and because migrations must complete before
 * a Prisma client is ever constructed.
 */

const LEDGER_TABLE = '_prisma_migrations';

/** Prisma's exact DDL, so a database we create is indistinguishable from one the CLI created. */
const LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id"                    TEXT PRIMARY KEY NOT NULL,
    "checksum"              TEXT NOT NULL,
    "finished_at"           DATETIME,
    "migration_name"        TEXT NOT NULL,
    "logs"                  TEXT,
    "rolled_back_at"        DATETIME,
    "started_at"            DATETIME NOT NULL DEFAULT current_timestamp,
    "applied_steps_count"   INTEGER UNSIGNED NOT NULL DEFAULT 0
);
`;

export interface MigrationReport {
  readonly databaseFilePath: string;
  /** Migrations applied during this call. */
  readonly applied: readonly string[];
  /** Migrations already recorded as applied before this call. */
  readonly skipped: readonly string[];
  readonly journalMode: string;
}

export interface ApplyMigrationsOptions {
  readonly databaseFilePath: string;
  readonly authToken?: string;
}

export async function applyPendingMigrations(
  options: ApplyMigrationsOptions,
): Promise<MigrationReport> {
  const client = createClient({
    url: toDatabaseUrl(options.databaseFilePath),
    ...(options.authToken ? { authToken: options.authToken } : {}),
  });

  try {
    // WAL lets a reader (kitchen screen) run while a writer (cashier saving an
    // order) commits. It is a persistent database-level setting, so it
    // survives restarts, but re-asserting it on boot is cheap and explicit.
    // Journal mode is a local-file concern; a managed libSQL server owns its own.
    let journalMode = 'remote';
    if (toDatabaseUrl(options.databaseFilePath).startsWith('file:')) {
      const journal = await client.execute('PRAGMA journal_mode=WAL');
      journalMode = String(journal.rows[0]?.['journal_mode'] ?? 'unknown');
    }

    await client.executeMultiple(LEDGER_DDL);

    const ledger = await client.execute(
      `SELECT migration_name, checksum, finished_at, rolled_back_at FROM ${LEDGER_TABLE}`,
    );

    const interrupted = ledger.rows.find(
      (row) => row['finished_at'] === null && row['rolled_back_at'] === null,
    );
    if (interrupted) {
      throw new Error(
        `Migration "${String(interrupted['migration_name'])}" did not finish on a previous run. ` +
          `The database at ${options.databaseFilePath} may be inconsistent and needs ` +
          `inspection before Nayaro RMS can start.`,
      );
    }

    const appliedChecksums = new Map<string, string>();
    for (const row of ledger.rows) {
      if (row['rolled_back_at'] !== null) continue;
      appliedChecksums.set(String(row['migration_name']), String(row['checksum']));
    }

    const applied: string[] = [];
    const skipped: string[] = [];

    for (const migration of BUNDLED_MIGRATIONS) {
      const recorded = appliedChecksums.get(migration.name);

      if (recorded !== undefined) {
        // An edited migration file that has already run is a silent data bug
        // waiting to happen, so refuse to start instead of ignoring it.
        if (recorded !== migration.checksum) {
          throw new Error(
            `Migration "${migration.name}" has already been applied to ` +
              `${options.databaseFilePath} but its contents have changed since ` +
              `(checksum ${recorded} on disk vs ${migration.checksum} in this build). ` +
              `Applied migrations must never be edited - add a new migration instead.`,
          );
        }
        skipped.push(migration.name);
        continue;
      }

      await runMigration(client, migration.name, migration.checksum, migration.sql);
      applied.push(migration.name);
    }

    return { databaseFilePath: options.databaseFilePath, applied, skipped, journalMode };
  } finally {
    client.close();
  }
}

async function runMigration(
  client: Client,
  name: string,
  checksum: string,
  sql: string,
): Promise<void> {
  // Claim the migration first. If the process dies part-way through, the
  // unfinished row survives and the next startup refuses to continue rather
  // than silently re-running half a migration.
  await client.execute({
    sql:
      `INSERT INTO ${LEDGER_TABLE} ` +
      '(id, checksum, migration_name, started_at, applied_steps_count) VALUES (?, ?, ?, ?, 0)',
    args: [randomUUID(), checksum, name, Date.now()],
  });

  await client.executeMultiple(sql);

  await client.execute({
    sql: `UPDATE ${LEDGER_TABLE} SET finished_at = ?, applied_steps_count = 1 WHERE migration_name = ?`,
    args: [Date.now(), name],
  });
}
