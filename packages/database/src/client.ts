import { PrismaLibSql } from '@prisma/adapter-libsql';
import { PrismaClient } from './generated/prisma/client';
import { toDatabaseUrl } from './paths';

/**
 * Builds the Prisma client for a specific database file.
 *
 * The path is always an explicit argument - never DATABASE_URL, never a
 * default, never inferred from the working directory. Electron resolves it
 * from `app.getPath('userData')` in production and from the repo-local dev
 * root in development, then hands it in. That keeps this package free of
 * ambient environment state and makes it trivially testable.
 *
 * Prisma 7 has no Rust query engine: `@prisma/client` is pure TypeScript and a
 * driver adapter supplies the actual connection. Ours is libSQL, whose native
 * binding is N-API and therefore loads unchanged in both Node and Electron -
 * no electron-rebuild, no per-ABI prebuilds.
 */
export interface CreatePrismaClientOptions {
  /** A filesystem path or a libSQL URL. */
  readonly databaseFilePath: string;
  /** Auth token for a remote libSQL server. Unused for local files. */
  readonly authToken?: string;
}

export type NayaroPrismaClient = PrismaClient;

export function createPrismaClient(options: CreatePrismaClientOptions): NayaroPrismaClient {
  const adapter = new PrismaLibSql({
    url: toDatabaseUrl(options.databaseFilePath),
    ...(options.authToken ? { authToken: options.authToken } : {}),
  });
  return new PrismaClient({ adapter });
}
