import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'prisma/config';
import { ensureDataLayout, resolveDataLayout, toDatabaseFileUrl } from './src/paths.ts';

/**
 * Prisma CLI configuration - development only.
 *
 * The running application NEVER reads this file and never reads DATABASE_URL.
 * At runtime Electron resolves an absolute path and passes it explicitly to
 * `createPrismaClient({ databaseFilePath })`.
 *
 * We deliberately derive the CLI's database path from the same
 * `resolveDataLayout()` used at runtime, so `prisma migrate dev` and the dev
 * app can never drift apart, and there is no .env file to forget to update.
 */
const packageDir = dirname(fileURLToPath(import.meta.url));

/** Development root. Mirrors the production userData layout exactly. */
export const DEV_DATA_ROOT = resolve(packageDir, '.nayaro-dev');

const layout = ensureDataLayout(resolveDataLayout(DEV_DATA_ROOT));

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: toDatabaseFileUrl(layout.databaseFilePath),
  },
});
