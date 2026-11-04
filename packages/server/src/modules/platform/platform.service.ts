import type { NayaroPrismaClient } from '@nayaro/database';
import type {
  PlatformActivityEntry,
  PlatformActivityResponse,
  PlatformDayPoint,
  PlatformImpersonationResponse,
  PlatformOverview,
  PlatformPendingSignup,
  PlatformTenantDetail,
  PlatformTenantRow,
} from '@nayaro/shared';
import { z } from 'zod';
import { ApiError } from '../../utils/apiError';
import { randomBytes } from 'node:crypto';
import { hashSessionToken } from '../auth/session.service';
import { getTenantSummary, setTenantStatus } from '../tenant/tenant.service';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Sessions refresh lastSeenAt at most every 5 minutes, so "online" allows 10. */
const ONLINE_WINDOW_MS = 10 * 60 * 1000;
const SUPPORT_VIEW_TTL_MS = 60 * 60 * 1000;

const utcDay = (date: Date): string => date.toISOString().slice(0, 10);

function lastDays(days: number, now: Date): string[] {
  return Array.from({ length: days }, (_, index) => utcDay(new Date(now.getTime() - (days - 1 - index) * DAY_MS)));
}

function series(days: string[], counts: Map<string, number>): PlatformDayPoint[] {
  return days.map((date) => ({ date, value: counts.get(date) ?? 0 }));
}

function bump(map: Map<string, number>, key: string, by = 1): void {
  map.set(key, (map.get(key) ?? 0) + by);
}

function daysLeft(endsAt: Date | null, now: Date): number | null {
  return endsAt === null ? null : Math.ceil((endsAt.getTime() - now.getTime()) / DAY_MS);
}

/**
 * One row per restaurant with its owner and recent numbers. Built from a few
 * grouped queries rather than one query per restaurant, because the console's
 * database may be a continent away and round trips are the cost.
 */
async function tenantRows(
  prisma: NayaroPrismaClient,
  where: { id?: string | { in: string[] } } = {},
  now = new Date(),
): Promise<PlatformTenantRow[]> {
  const since30 = new Date(now.getTime() - 30 * DAY_MS);
  const onlineSince = new Date(now.getTime() - ONLINE_WINDOW_MS);
  const restaurantWhere = where.id === undefined ? {} : { id: where.id };
  const scoped = where.id === undefined ? {} : { restaurantId: where.id };

  const [restaurants, owners, lastSeen, lastLogin, online, bills, orders] = await Promise.all([
    prisma.restaurant.findMany({
      where: restaurantWhere,
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { staff: true } } },
    }),
    prisma.staff.findMany({
      where: { ...scoped, role: 'OWNER' },
      orderBy: { createdAt: 'asc' },
      select: { restaurantId: true, name: true, email: true, username: true },
    }),
    prisma.session.groupBy({
      by: ['restaurantId'],
      where: { ...scoped, impersonatedByAdminId: null },
      _max: { lastSeenAt: true },
    }),
    // Expired sessions are pruned, so sign-in times (kept forever) back them up.
    prisma.staff.groupBy({ by: ['restaurantId'], where: scoped, _max: { lastLoginAt: true } }),
    prisma.session.groupBy({
      by: ['restaurantId'],
      where: {
        ...scoped,
        impersonatedByAdminId: null,
        revokedAt: null,
        lastSeenAt: { gte: onlineSince },
        expiresAt: { gt: now },
      },
      _count: { _all: true },
    }),
    prisma.invoice.groupBy({
      by: ['restaurantId'],
      where: { ...scoped, status: 'ACTIVE', issuedAt: { gte: since30 } },
      _count: { _all: true },
      _sum: { grandTotalPaisa: true },
    }),
    prisma.order.groupBy({ by: ['restaurantId'], where: scoped, _count: { _all: true } }),
  ]);

  const ownerBy = new Map<string, (typeof owners)[number]>();
  for (const owner of owners) if (!ownerBy.has(owner.restaurantId)) ownerBy.set(owner.restaurantId, owner);
  const lastSeenBy = new Map<string, Date>();
  for (const row of [
    ...lastSeen.map((entry) => ({ id: entry.restaurantId, at: entry._max.lastSeenAt })),
    ...lastLogin.map((entry) => ({ id: entry.restaurantId, at: entry._max.lastLoginAt })),
  ]) {
    const current = lastSeenBy.get(row.id);
    if (row.at !== null && (current === undefined || row.at > current)) lastSeenBy.set(row.id, row.at);
  }
  const onlineBy = new Map(online.map((row) => [row.restaurantId, row._count._all]));
  const billsBy = new Map(bills.map((row) => [row.restaurantId, row]));
  const ordersBy = new Map(orders.map((row) => [row.restaurantId, row._count._all]));

  return restaurants.map((restaurant) => {
    const owner = ownerBy.get(restaurant.id);
    const bill = billsBy.get(restaurant.id);
    return {
      id: restaurant.id,
      workspace: restaurant.slug,
      name: restaurant.name,
      status: restaurant.status,
      plan: restaurant.plan,
      isActive: restaurant.isActive,
      createdAt: restaurant.createdAt.toISOString(),
      subscriptionEndsAt: restaurant.subscriptionEndsAt?.toISOString() ?? null,
      daysLeft: daysLeft(restaurant.subscriptionEndsAt, now),
      owner: owner ? { name: owner.name, email: owner.email, username: owner.username } : null,
      contactEmail: restaurant.contactEmail,
      phone: restaurant.phone,
      staffCount: restaurant._count.staff,
      lastActiveAt: lastSeenBy.get(restaurant.id)?.toISOString() ?? null,
      onlineNow: onlineBy.get(restaurant.id) ?? 0,
      ordersTotal: ordersBy.get(restaurant.id) ?? 0,
      bills30d: bill?._count._all ?? 0,
      sales30dPaisa: bill?._sum.grandTotalPaisa ?? 0,
    };
  });
}

async function activity(
  prisma: NayaroPrismaClient,
  options: { readonly restaurantId?: string; readonly before?: Date; readonly take: number; readonly action?: string },
): Promise<PlatformActivityEntry[]> {
  const rows = await prisma.auditLog.findMany({
    where: {
      ...(options.restaurantId === undefined ? {} : { restaurantId: options.restaurantId }),
      ...(options.before === undefined ? {} : { createdAt: { lt: options.before } }),
      ...(options.action === undefined ? {} : { action: options.action }),
    },
    orderBy: { createdAt: 'desc' },
    take: options.take,
    include: { restaurant: { select: { id: true, name: true, slug: true } }, staff: { select: { name: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    action: row.action,
    summary: row.summary,
    ipAddress: row.ipAddress,
    restaurant: { id: row.restaurant.id, name: row.restaurant.name, workspace: row.restaurant.slug },
    staffName: row.staff?.name ?? null,
  }));
}

export async function platformOverview(prisma: NayaroPrismaClient, now = new Date()): Promise<PlatformOverview> {
  const days = lastDays(30, now);
  const since30 = new Date(now.getTime() - 30 * DAY_MS);
  const startOfToday = new Date(`${utcDay(now)}T00:00:00.000Z`);

  const [rows, sessions30, invoices30, pendingSignups, recent] = await Promise.all([
    tenantRows(prisma, {}, now),
    prisma.session.findMany({
      where: { lastSeenAt: { gte: since30 }, impersonatedByAdminId: null },
      select: { restaurantId: true, staffId: true, createdAt: true, lastSeenAt: true, revokedAt: true, expiresAt: true },
    }),
    prisma.invoice.findMany({
      where: { status: 'ACTIVE', issuedAt: { gte: since30 } },
      select: { issuedAt: true, grandTotalPaisa: true },
    }),
    prisma.pendingRegistration.count({ where: { expiresAt: { gt: now } } }),
    activity(prisma, { take: 12 }),
  ]);

  // A session counts as activity on the days between its start and last use.
  const activeByDay = new Map<string, Set<string>>();
  const onlinePeople = new Set<string>();
  const onlineRestaurants = new Set<string>();
  for (const session of sessions30) {
    const first = Math.max(session.createdAt.getTime(), since30.getTime());
    for (let t = first; t <= session.lastSeenAt.getTime() + 1; t += DAY_MS) {
      const day = utcDay(new Date(t));
      if (!activeByDay.has(day)) activeByDay.set(day, new Set());
      activeByDay.get(day)!.add(session.restaurantId);
    }
    activeByDay.get(utcDay(session.lastSeenAt))?.add(session.restaurantId);
    if (
      session.revokedAt === null &&
      session.expiresAt > now &&
      now.getTime() - session.lastSeenAt.getTime() <= ONLINE_WINDOW_MS
    ) {
      onlinePeople.add(session.staffId);
      onlineRestaurants.add(session.restaurantId);
    }
  }
  const activeWeek = new Set<string>();
  for (const day of days.slice(-7)) for (const id of activeByDay.get(day) ?? []) activeWeek.add(id);

  const signups = new Map<string, number>();
  for (const row of rows) bump(signups, row.createdAt.slice(0, 10));
  const billsByDay = new Map<string, number>();
  let billsToday = 0;
  let sales30 = 0;
  for (const invoice of invoices30) {
    bump(billsByDay, utcDay(invoice.issuedAt));
    sales30 += invoice.grandTotalPaisa;
    if (invoice.issuedAt >= startOfToday) billsToday += 1;
  }

  const count = (status: PlatformTenantRow['status']): number => rows.filter((row) => row.status === status).length;
  const trials = rows.filter((row) => row.status === 'TRIAL');
  const weekAgo = now.getTime() - 7 * DAY_MS;

  return {
    generatedAt: now.toISOString(),
    tenants: {
      total: rows.length,
      trial: count('TRIAL'),
      active: count('ACTIVE'),
      suspended: count('SUSPENDED'),
      cancelled: count('CANCELLED'),
      trialEndingSoon: trials.filter((row) => row.daysLeft !== null && row.daysLeft >= 0 && row.daysLeft <= 7).length,
      trialExpired: trials.filter((row) => row.daysLeft !== null && row.daysLeft < 0).length,
      newThisWeek: rows.filter((row) => Date.parse(row.createdAt) >= weekAgo).length,
    },
    activeRestaurants: { today: activeByDay.get(utcDay(now))?.size ?? 0, week: activeWeek.size },
    onlineNow: { people: onlinePeople.size, restaurants: onlineRestaurants.size },
    pendingSignups,
    bills: { today: billsToday, last30d: invoices30.length, sales30dPaisa: sales30 },
    signupsPerDay: series(days, signups),
    activeRestaurantsPerDay: days.map((date) => ({ date, value: activeByDay.get(date)?.size ?? 0 })),
    billsPerDay: series(days, billsByDay),
    trialsEndingSoon: trials
      .filter((row) => row.daysLeft !== null && row.daysLeft <= 7)
      .sort((a, b) => (a.daysLeft ?? 0) - (b.daysLeft ?? 0))
      .slice(0, 8),
    recentSignups: rows.slice(0, 6),
    recentActivity: recent,
  };
}

export async function platformTenants(prisma: NayaroPrismaClient): Promise<PlatformTenantRow[]> {
  return tenantRows(prisma);
}

export async function platformTenantDetail(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  now = new Date(),
): Promise<PlatformTenantDetail> {
  const [row] = await tenantRows(prisma, { id: restaurantId }, now);
  if (!row) throw new ApiError(404, 'TENANT_NOT_FOUND', 'No restaurant with that id.');
  const days = lastDays(30, now);
  const since30 = new Date(now.getTime() - 30 * DAY_MS);

  const [restaurant, totals, staff, sessions, invoices30, recent] = await Promise.all([
    prisma.restaurant.findUniqueOrThrow({
      where: { id: restaurantId },
      select: { address: true, panNumber: true, statusReason: true },
    }),
    Promise.all([
      prisma.order.count({ where: { restaurantId } }),
      prisma.invoice.aggregate({
        where: { restaurantId, status: 'ACTIVE' },
        _count: { _all: true },
        _sum: { grandTotalPaisa: true },
      }),
      prisma.menuItem.count({ where: { restaurantId, isActive: true } }),
      prisma.restaurantTable.count({ where: { restaurantId, isActive: true } }),
      prisma.customer.count({ where: { restaurantId } }),
    ]),
    prisma.staff.findMany({
      where: { restaurantId },
      orderBy: [{ role: 'asc' }, { name: 'asc' }],
      select: { id: true, name: true, username: true, email: true, role: true, isActive: true, lastLoginAt: true },
    }),
    prisma.session.findMany({
      where: { restaurantId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { lastSeenAt: 'desc' },
      take: 20,
      include: { staff: { select: { name: true } } },
    }),
    prisma.invoice.findMany({
      where: { restaurantId, status: 'ACTIVE', issuedAt: { gte: since30 } },
      select: { issuedAt: true, grandTotalPaisa: true },
    }),
    activity(prisma, { restaurantId, take: 40 }),
  ]);

  const salesByDay = new Map<string, number>();
  const billsByDay = new Map<string, number>();
  for (const invoice of invoices30) {
    bump(salesByDay, utcDay(invoice.issuedAt), invoice.grandTotalPaisa);
    bump(billsByDay, utcDay(invoice.issuedAt));
  }
  const [orders, bills, menuItems, tables, customers] = totals;

  return {
    tenant: { ...row, address: restaurant.address, panNumber: restaurant.panNumber, statusReason: restaurant.statusReason },
    totals: {
      orders,
      bills: bills._count._all,
      salesPaisa: bills._sum.grandTotalPaisa ?? 0,
      menuItems,
      tables,
      customers,
    },
    salesPerDay: series(days, salesByDay),
    billsPerDay: series(days, billsByDay),
    staff: staff.map((member) => ({ ...member, lastLoginAt: member.lastLoginAt?.toISOString() ?? null })),
    sessions: sessions.map((session) => ({
      id: session.id,
      staffName: session.staff.name,
      deviceLabel: session.deviceLabel,
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      createdAt: session.createdAt.toISOString(),
      lastSeenAt: session.lastSeenAt.toISOString(),
      supportView: session.impersonatorName,
    })),
    activity: recent,
  };
}

const tenantActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('extend'), days: z.int().min(1).max(365) }),
  z.object({
    action: z.literal('activate'),
    until: z.union([z.null(), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]),
  }),
  z.object({ action: z.literal('suspend'), reason: z.string().trim().min(3).max(300) }),
  z.object({ action: z.literal('reactivate') }),
]);

/** Trial extensions, activation and suspension. Returns a one-line summary for the audit log. */
export async function applyTenantAction(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  rawInput: unknown,
  now = new Date(),
): Promise<string> {
  const input = tenantActionSchema.parse(rawInput);
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: { slug: true, status: true, subscriptionEndsAt: true },
  });
  if (!restaurant) throw new ApiError(404, 'TENANT_NOT_FOUND', 'No restaurant with that id.');

  if (input.action === 'extend' && restaurant.subscriptionEndsAt === null) {
    // Extending would GIVE an end date to an account that has none.
    throw new ApiError(409, 'NO_END_DATE', 'This account has no end date, so there is nothing to extend.');
  }
  if (input.action === 'extend') {
    // Extends from today if the period has already run out, otherwise from its end.
    const from = Math.max(now.getTime(), restaurant.subscriptionEndsAt?.getTime() ?? now.getTime());
    const until = new Date(from + input.days * DAY_MS);
    await setTenantStatus(prisma, restaurant.slug, {
      status: restaurant.status === 'ACTIVE' ? 'ACTIVE' : 'TRIAL',
      subscriptionEndsAt: until,
    });
    return `Extended by ${String(input.days)} days, to ${utcDay(until)}`;
  }
  if (input.action === 'activate') {
    const until = input.until === null ? null : new Date(`${input.until}T23:59:59.000Z`);
    await setTenantStatus(prisma, restaurant.slug, { status: 'ACTIVE', subscriptionEndsAt: until });
    return `Activated as a paying restaurant${until === null ? '' : ` until ${input.until!}`}`;
  }
  if (input.action === 'suspend') {
    await setTenantStatus(prisma, restaurant.slug, { status: 'SUSPENDED', reason: input.reason });
    return `Suspended: ${input.reason}`;
  }
  const backTo = restaurant.subscriptionEndsAt === null ? 'ACTIVE' : 'TRIAL';
  await setTenantStatus(prisma, restaurant.slug, { status: backTo });
  return `Reactivated (${backTo.toLowerCase()})`;
}

export async function platformPendingSignups(
  prisma: NayaroPrismaClient,
  now = new Date(),
): Promise<PlatformPendingSignup[]> {
  const rows = await prisma.pendingRegistration.findMany({ orderBy: { createdAt: 'desc' }, take: 200 });
  return rows.map((row) => {
    // Only display fields are read from the parked form; the password hash
    // inside it never leaves the server.
    const payload = JSON.parse(row.payload) as { restaurant?: { name?: string }; owner?: { name?: string } };
    return {
      email: row.email,
      workspace: row.workspace,
      restaurantName: payload.restaurant?.name ?? row.workspace,
      ownerName: payload.owner?.name ?? '',
      createdAt: row.createdAt.toISOString(),
      lastSentAt: row.lastSentAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      attempts: row.attempts,
      expired: row.expiresAt <= now,
    };
  });
}

export async function platformActivity(
  prisma: NayaroPrismaClient,
  query: { readonly before?: string; readonly action?: string },
): Promise<PlatformActivityResponse> {
  const take = 50;
  const before = query.before === undefined ? undefined : new Date(query.before);
  if (before !== undefined && Number.isNaN(before.getTime())) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid "before" timestamp.');
  }
  const entries = await activity(prisma, {
    take,
    ...(before === undefined ? {} : { before }),
    ...(query.action ? { action: query.action } : {}),
  });
  return { entries, nextBefore: entries.length === take ? entries[entries.length - 1]!.createdAt : null };
}

/**
 * A read-only, one-hour session as the restaurant's owner, for support.
 * The restaurant's own activity log records it, so the owner can always see
 * when Nayaro looked and who it was.
 */
export async function startSupportView(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  admin: { readonly id: string; readonly name: string },
  client: { readonly ipAddress?: string; readonly userAgent?: string },
): Promise<PlatformImpersonationResponse> {
  const owner = await prisma.staff.findFirst({
    where: { restaurantId, role: 'OWNER', isActive: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!owner) throw new ApiError(404, 'OWNER_NOT_FOUND', 'This restaurant has no active owner account to view as.');

  // Created read-only in a single write, so there is never a moment where
  // this token is an ordinary, full-power owner session.
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SUPPORT_VIEW_TTL_MS);
  await prisma.session.create({
    data: {
      restaurantId,
      staffId: owner.id,
      tokenHash: hashSessionToken(token),
      expiresAt,
      deviceLabel: `Nayaro support view (${admin.name})`.slice(0, 64),
      ipAddress: client.ipAddress?.slice(0, 64) ?? null,
      userAgent: client.userAgent?.slice(0, 256) ?? null,
      impersonatedByAdminId: admin.id,
      impersonatorName: admin.name,
    },
  });

  return {
    token,
    expiresAt: expiresAt.toISOString(),
    staff: {
      id: owner.id,
      restaurantId,
      name: owner.name,
      username: owner.username,
      role: owner.role,
      canTakeOrders: owner.canTakeOrders,
      canManageKitchen: owner.canManageKitchen,
    },
    tenant: await getTenantSummary(prisma, restaurantId),
    impersonation: { adminName: admin.name, expiresAt: expiresAt.toISOString() },
  };
}
