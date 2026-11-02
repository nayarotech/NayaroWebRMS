import { parseArgs } from 'node:util';
import { applyPendingMigrations, createPrismaClient, type TenantStatus } from '@nayaro/database';
import { setTenantStatus } from '../src/modules/tenant/tenant.service';
import { loadEnvironment, resolveDatabaseLocation } from './env';

/**
 * Platform operator CLI. Tenant lifecycle is never exposed through the tenant
 * API; until a platform console exists, operators manage it here.
 *
 *   npm run tenant -- list
 *   npm run tenant -- status <workspace> --set ACTIVE [--until 2027-01-31] [--reason "..."]
 */
const USAGE = `Usage:
  npm run tenant -- list
  npm run tenant -- status <workspace> --set TRIAL|ACTIVE|SUSPENDED|CANCELLED [--until YYYY-MM-DD|never] [--reason text]`;

const STATUSES: readonly TenantStatus[] = ['TRIAL', 'ACTIVE', 'SUSPENDED', 'CANCELLED'];

loadEnvironment();
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { set: { type: 'string' }, until: { type: 'string' }, reason: { type: 'string' } },
});

const databaseFilePath = resolveDatabaseLocation();
const authToken = process.env['DATABASE_AUTH_TOKEN'];
const database = { databaseFilePath, ...(authToken ? { authToken } : {}) };
await applyPendingMigrations(database);
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
