import { z } from 'zod';

export const DEFAULT_SERVER_HOST = '0.0.0.0';
export const DEFAULT_SERVER_PORT = 4000;

/**
 * Explicit server configuration. The package itself never reads the
 * environment; scripts/start.ts maps environment variables onto this, so tests
 * can start a server with exactly the configuration they need.
 */
const serverConfigSchema = z.object({
  host: z.string().min(1).default(DEFAULT_SERVER_HOST),
  port: z.int().min(0).max(65535).default(DEFAULT_SERVER_PORT),
  /** A filesystem path or a libSQL URL. */
  databaseFilePath: z.string().min(1),
  databaseAuthToken: z.string().min(1).optional(),
  /** Public mount point; standalone deployments keep their existing root routes. */
  apiBasePath: z
    .string()
    .regex(/^(?:\/[a-zA-Z0-9_-]+)*$/)
    .default(''),
  /** Browser origins allowed to call the API, e.g. https://app.nayaro.tech */
  webOrigins: z.array(z.string().min(1)).default([]),
  trustProxy: z.union([z.boolean(), z.number(), z.string()]).default(false),
  hsts: z.boolean().default(false),
  apiRequestsPerMinute: z.int().min(1).default(600),
  registrationsPerHour: z.int().min(1).default(5),
  silent: z.boolean().default(false),
});

export type ServerConfigInput = z.input<typeof serverConfigSchema>;

export type ResolvedServerConfig = z.output<typeof serverConfigSchema> & {
  readonly baseUrl: string;
};

export function resolveServerConfig(input: ServerConfigInput): ResolvedServerConfig {
  const parsed = serverConfigSchema.parse(input);
  const localHost = parsed.host === '0.0.0.0' || parsed.host === '::' ? '127.0.0.1' : parsed.host;
  return { ...parsed, baseUrl: `http://${localHost}:${String(parsed.port)}` };
}
