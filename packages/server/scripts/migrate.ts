import { applyPendingMigrations } from '@nayaro/database';
import { loadEnvironment, resolveDatabaseLocation } from './env';

loadEnvironment();
const authToken = process.env['DATABASE_AUTH_TOKEN'];
const report = await applyPendingMigrations({
  databaseFilePath: resolveDatabaseLocation(),
  ...(authToken ? { authToken } : {}),
});
console.log(
  report.applied.length === 0
    ? 'Database is up to date.'
    : `Applied ${String(report.applied.length)} migration(s):\n  ${report.applied.join('\n  ')}`,
);
