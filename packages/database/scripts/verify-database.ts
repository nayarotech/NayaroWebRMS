/**
 * Standalone proof that the Nayaro RMS database layer works, independent of
 * Express, Electron and React.
 *
 * Usage:
 *   npm run db:verify --workspace @nayaro/database              (dev root)
 *   npm run db:verify --workspace @nayaro/database -- <root>    (any root)
 *
 * The second form is how we rehearse the production layout: pass the same
 * directory Electron will pass from `app.getPath('userData')` and confirm the
 * whole pipeline builds it correctly.
 */
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { statSync } from 'node:fs';
import {
  applyPendingMigrations,
  createPrismaClient,
  ensureDataLayout,
  resolveDataLayout,
} from '../src/index';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEV_DATA_ROOT = resolve(packageDir, '.nayaro-dev');

async function main(): Promise<void> {
  const rootArg = process.argv[2];
  const rootDir = rootArg ? resolve(rootArg) : DEV_DATA_ROOT;
  const runtime = process.versions.electron
    ? `electron ${process.versions.electron} (ABI ${process.versions.modules})`
    : `node ${process.versions.node} (ABI ${process.versions.modules})`;

  console.log('Nayaro RMS - database verification');
  console.log('  runtime      :', runtime);
  console.log('  data root    :', rootDir);

  const layout = ensureDataLayout(resolveDataLayout(rootDir));
  console.log('  database     :', layout.databaseFilePath);
  console.log('  backups dir  :', layout.backupsDir);
  console.log('  logs dir     :', layout.logsDir);

  const report = await applyPendingMigrations({ databaseFilePath: layout.databaseFilePath });
  console.log('  journal mode :', report.journalMode);
  console.log('  applied      :', report.applied.length ? report.applied.join(', ') : '(none)');
  console.log('  already done :', report.skipped.length ? report.skipped.join(', ') : '(none)');

  const prisma = createPrismaClient({ databaseFilePath: layout.databaseFilePath });
  try {
    const versionRows = await prisma.$queryRaw<{ version: string }[]>`
      SELECT sqlite_version() AS version
    `;
    console.log('  sqlite       :', versionRows[0]?.version ?? 'unknown');
    console.log('  prisma query :', 'ok');
  } finally {
    await prisma.$disconnect();
  }

  console.log('  db file size :', statSync(layout.databaseFilePath).size, 'bytes');
  console.log('DATABASE OK');
}

main().catch((error: unknown) => {
  console.error('DATABASE FAILED:', error);
  process.exitCode = 1;
});
