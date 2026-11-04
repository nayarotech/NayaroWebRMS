import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  applyPendingMigrations,
  createPrismaClient,
  toDatabaseUrl,
  type TenantStatus,
} from '@nayaro/database';
import { setTenantStatus } from '../src/modules/tenant/tenant.service';
import { upsertPlatformAdmin } from '../src/modules/platform/platform.auth';
import { loadEnvironment, resolveDatabaseLocation } from './env';
import { resetTenantData } from './reset-tenant-data';

/**
 * Platform operator CLI. Tenant lifecycle is never exposed through the tenant
 * API; until a platform console exists, operators manage it here.
 *
 *   npm run tenant -- list
 *   npm run tenant -- status <workspace> --set ACTIVE [--until 2027-01-31] [--reason "..."]
 */
const USAGE = `Usage:
  npm run tenant -- list
  npm run tenant -- status <workspace> --set TRIAL|ACTIVE|SUSPENDED|CANCELLED [--until YYYY-MM-DD|never] [--reason text]
  npm run tenant -- reset-data <workspace> [--execute]
  npm run tenant -- admin <email> --name "Full Name" --password "..."   (create or reset a Nayaro console admin)

reset-data previews by default. Stop the API before --execute.
Keeps staff, menu, floor plan, settings, offers, recipes, payroll profiles and security logs.
Clears transaction history and customers, zeros stock and restarts numbering.
Local SQLite databases only; a full backup is created before clearing data.`;

const STATUSES: readonly TenantStatus[] = ['TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED'];

loadEnvironment();
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    set: { type: 'string' },
    until: { type: 'string' },
    reason: { type: 'string' },
    name: { type: 'string' },
    password: { type: 'string' },
    execute: { type: 'boolean', default: false },
  },
});

const databaseFilePath = resolveDatabaseLocation();
const authToken = process.env['DATABASE_AUTH_TOKEN'];
const database = { databaseFilePath, ...(authToken ? { authToken } : {}) };
// Preview/reset should not run migrations against an operator's database.
if (positionals[0] !== 'reset-data') await applyPendingMigrations(database);
const prisma = createPrismaClient(database);

try {
  const [command, workspace] = positionals;
  if (command === 'list') {
    const tenants = await prisma.restaurant.findMany({
      orderBy: { createdAt: 'asc' },
      select: {
        slug: true,
        name: true,
        status: true,
        plan: true,
        subscriptionEndsAt: true,
        _count: { select: { staff: true, orders: true } },
      },
    });
    console.table(
      tenants.map((tenant) => ({
        workspace: tenant.slug,
        name: tenant.name,
        status: tenant.status,
        plan: tenant.plan,
        endsAt: tenant.subscriptionEndsAt?.toISOString().slice(0, 10) ?? 'never',
        staff: tenant._count.staff,
        orders: tenant._count.orders,
      })),
    );
  } else if (command === 'admin' && workspace) {
    // `workspace` is the email here: the second positional.
    if (!values.name || !values.password) throw new Error('admin needs --name and --password.');
    const admin = await upsertPlatformAdmin(prisma, { email: workspace, name: values.name, password: values.password });
    console.log(`Console admin ready: ${admin.name} <${admin.email}>. Sign in at /admin/login.`);
  } else if (command === 'reset-data' && workspace) {
    if (!toDatabaseUrl(databaseFilePath).startsWith('file:')) {
      throw new Error('reset-data supports local SQLite databases only.');
    }
    const tenant = await prisma.restaurant.findUniqueOrThrow({
      where: { slug: workspace },
      select: {
        name: true,
        _count: { select: { orders: true, invoices: true, payments: true, customers: true } },
      },
    });
    console.log(`Reset transaction data for ${tenant.name} (${workspace}):`);
    console.table(tenant._count);
    console.log('Keeps staff, menu, tables, settings, recipes, offers and payroll profiles.');
    console.log(
      'Clears transactions and customers, zeros stock, restarts numbering and signs out staff.',
    );
    if (values.execute) {
      const backupDir = fileURLToPath(new URL('../.data/backups/', import.meta.url));
      mkdirSync(backupDir, { recursive: true });
      const backupPath = `${backupDir}before-reset-${randomUUID()}.db`;
      await resetTenantData(prisma, workspace, backupPath);
      console.log(`Reset complete. Backup: ${backupPath}`);
    } else {
      console.log(
        'Preview only. Stop the API, then repeat with --execute to reset this restaurant.',
      );
    }
  } else if (command === 'status' && workspace && values.set) {
    const status = values.set.toUpperCase() as TenantStatus;
    if (!STATUSES.includes(status)) throw new Error(USAGE);
    const until =
      values.until === undefined
        ? undefined
        : values.until === 'never'
          ? null
          : new Date(`${values.until}T23:59:59Z`);
    const summary = await setTenantStatus(prisma, workspace, {
      status,
      ...(until === undefined ? {} : { subscriptionEndsAt: until }),
      ...(values.reason ? { reason: values.reason } : {}),
    });
    console.log(summary);
  } else {
    console.log(USAGE);
    process.exitCode = 1;
  }
} finally {
  await prisma.$disconnect();
}
