// Turns prisma/migrations/**/migration.sql into a TypeScript module.
//
// Why not read the .sql files at runtime? Because the packaged application is
// a single bundled main.js inside an asar archive - there is no migrations
// folder to read. Compiling them into a module means the migrations travel
// with the code, work identically in development and production, and need no
// extra files in the package.
//
// Run automatically by `npm run db:migrate`.
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsDir = join(packageDir, 'prisma', 'migrations');
const outputFile = join(packageDir, 'src', 'migrations.generated.ts');

const names = existsSync(migrationsDir)
  ? readdirSync(migrationsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      // Prisma prefixes directories with a UTC timestamp, so a lexical sort is
      // chronological order.
      .sort()
      .filter((name) => existsSync(join(migrationsDir, name, 'migration.sql')))
  : [];

const migrations = names.map((name) => {
  const bytes = readFileSync(join(migrationsDir, name, 'migration.sql'));
  return {
    name,
    // Prisma records the SHA-256 of the migration file bytes in
    // _prisma_migrations.checksum. Computing it identically here lets the
    // runtime migrator write ledger rows the Prisma CLI accepts as its own.
    checksum: createHash('sha256').update(bytes).digest('hex'),
    sql: bytes.toString('utf8'),
  };
});

const entries = migrations
  .map((m) =>
    [
      '  {',
      `    name: ${JSON.stringify(m.name)},`,
      `    checksum: ${JSON.stringify(m.checksum)},`,
      `    sql: ${JSON.stringify(m.sql)},`,
      '  },',
    ].join('\n'),
  )
  .join('\n');

const contents = `// GENERATED FILE - do not edit by hand.
// Produced by scripts/bundle-migrations.mjs from prisma/migrations/.
// Regenerate with: npm run db:bundle-migrations --workspace @nayaro/database

export interface BundledMigration {
  readonly name: string;
  /** SHA-256 of migration.sql, matching Prisma's _prisma_migrations.checksum. */
  readonly checksum: string;
  readonly sql: string;
}

export const BUNDLED_MIGRATIONS: readonly BundledMigration[] = [
${entries}
];
`;

writeFileSync(outputFile, contents, 'utf8');
console.log(`Bundled ${migrations.length} migration(s) into src/migrations.generated.ts`);
for (const m of migrations) console.log(`  - ${m.name}  ${m.checksum.slice(0, 12)}...`);
