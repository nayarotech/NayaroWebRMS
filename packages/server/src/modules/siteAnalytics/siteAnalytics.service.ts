import type { NayaroPrismaClient } from '@nayaro/database';
import type {
  SiteAnalyticsRange,
  SiteAnalyticsReport,
  SiteAnalyticsRow,
  SiteAnalyticsTotals,
} from '@nayaro/shared';
import { z } from 'zod';
import { resolveCountry } from './geo';
import { isBot, parseUserAgent } from './userAgent';

/**
 * First-party analytics for rms.nayaro.tech: who visits, from where, and what
 * they look at. Modelled on nayaro.tech's own analytics - a random visitor id
 * in the browser, a visit ends after 30 idle minutes - with no cookies, no
 * third parties and no stored IP addresses.
 */
const ID = /^[a-zA-Z0-9_-]{8,40}$/;
const LIVE_WINDOW_MS = 3 * 60 * 1000;
const STAFF_ONLINE_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const clip = (value: string | null | undefined, max: number): string | null =>
  typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null;

const hitSchema = z.object({
  visitorId: z.string().regex(ID),
  sessionId: z.string().regex(ID),
  newSession: z.boolean(),
  path: z.string().min(1).max(300),
  referrer: z.string().max(1000).optional(),
  utmSource: z.string().max(100).nullable().optional(),
  timeZone: z.string().max(64).optional(),
  language: z.string().max(35).optional(),
  signedIn: z.boolean().optional(),
});

const pingSchema = z.object({
  visitorId: z.string().regex(ID),
  path: z.string().min(1).max(300),
  signedIn: z.boolean().optional(),
});

/** Ids and query strings never reach the database: "/orders/ckx..." becomes "/orders/:id". */
export function normalisePath(path: string): string {
  const clean = path.split(/[?#]/)[0] ?? '/';
  return (
    clean
      .split('/')
      .map((segment) =>
        segment.length >= 16 && /\d/.test(segment) && /^[a-zA-Z0-9_-]+$/.test(segment)
          ? ':id'
          : segment,
      )
      .join('/')
      .slice(0, 200) || '/'
  );
}

function referrerHost(value: string | undefined, ownHosts: readonly string[]): string | null {
  if (!value) return null;
  try {
    const host = new URL(value).hostname.replace(/^www\./, '');
    return host && !ownHosts.includes(host) ? host.slice(0, 200) : null;
  } catch {
    return null;
  }
}

export interface HitContext {
  readonly userAgent: string;
  readonly countryHeader: string | undefined;
  /** This deployment's own hosts, so moving between its pages is not a "referrer". */
  readonly ownHosts: readonly string[];
}

/** Records one page view. Bots and malformed hits are ignored, never errors. */
export async function recordHit(
  prisma: NayaroPrismaClient,
  rawInput: unknown,
  context: HitContext,
): Promise<void> {
  if (isBot(context.userAgent)) return;
  const parsed = hitSchema.safeParse(rawInput);
  if (!parsed.success) return;
  const hit = parsed.data;
  const path = normalisePath(hit.path);
  if (path === '/admin' || path.startsWith('/admin/')) return; // Our own console is not traffic.

  const { device, browser, os } = parseUserAgent(context.userAgent);
  const country = resolveCountry({
    header: context.countryHeader,
    timeZone: clip(hit.timeZone, 64),
    language: clip(hit.language, 35),
  });
  const now = new Date();
  const existing = await prisma.siteVisitor.findUnique({
    where: { id: hit.visitorId },
    select: { id: true },
  });
  const signedIn = hit.signedIn === true;

  await prisma.siteVisitor.upsert({
    where: { id: hit.visitorId },
    create: {
      id: hit.visitorId,
      firstSeenAt: now,
      lastSeenAt: now,
      currentPath: path,
      signedIn,
      country,
      device,
      browser,
      os,
    },
    update: {
      lastSeenAt: now,
      currentPath: path,
      signedIn,
      ...(hit.newSession ? { sessions: { increment: 1 } } : {}),
      ...(country === null ? {} : { country }),
      device,
      browser,
      os,
    },
  });
  await prisma.sitePageView.create({
    data: {
      visitorId: hit.visitorId,
      sessionId: hit.sessionId,
      path,
      // Where a visitor came from only matters for the first page of a visit.
      referrer: hit.newSession ? referrerHost(hit.referrer, context.ownHosts) : null,
      utmSource: clip(hit.utmSource, 100),
      country,
      device,
      browser,
      os,
      signedIn,
      isNewSession: hit.newSession || existing === null,
      isNewVisitor: existing === null,
      createdAt: now,
    },
  });
}

/** Keeps "on the site now" true while the tab stays open between page views. */
export async function recordPing(
  prisma: NayaroPrismaClient,
  rawInput: unknown,
  userAgent: string,
): Promise<void> {
  if (isBot(userAgent)) return;
  const parsed = pingSchema.safeParse(rawInput);
  if (!parsed.success) return;
  await prisma.siteVisitor.updateMany({
    where: { id: parsed.data.visitorId },
    data: {
      lastSeenAt: new Date(),
      currentPath: normalisePath(parsed.data.path),
      signedIn: parsed.data.signedIn === true,
    },
  });
}

// --- report -----------------------------------------------------------------

const RANGE_DAYS: Record<SiteAnalyticsRange, number> = { today: 1, '7d': 7, '30d': 30, '90d': 90 };

interface ViewRow {
  readonly visitorId: string;
  readonly sessionId: string;
  readonly path: string;
  readonly referrer: string | null;
  readonly country: string | null;
  readonly device: string | null;
  readonly browser: string | null;
  readonly os: string | null;
  readonly isNewSession: boolean;
  readonly isNewVisitor: boolean;
  readonly createdAt: Date;
}

function totals(rows: readonly ViewRow[]): SiteAnalyticsTotals {
  const visitors = new Set(rows.map((row) => row.visitorId));
  const visits = new Set(rows.map((row) => row.sessionId)).size;
  return {
    uniqueVisitors: visitors.size,
    newVisitors: new Set(rows.filter((row) => row.isNewVisitor).map((row) => row.visitorId)).size,
    visits,
    pageViews: rows.length,
    pagesPerVisit: visits === 0 ? 0 : Math.round((rows.length / visits) * 10) / 10,
  };
}

/** Distinct visitors per key, biggest first. */
function top(
  rows: readonly ViewRow[],
  keyOf: (row: ViewRow) => string,
  limit: number,
): SiteAnalyticsRow[] {
  const byKey = new Map<string, Set<string>>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!byKey.has(key)) byKey.set(key, new Set());
    byKey.get(key)!.add(row.visitorId);
  }
  return [...byKey.entries()]
    .map(([key, set]) => ({ key, value: set.size }))
    .sort((a, b) => b.value - a.value || a.key.localeCompare(b.key))
    .slice(0, limit);
}

export function areaOf(path: string): string {
  if (path === '/') return 'Landing page';
  if (path === '/login' || path.startsWith('/register')) return 'Sign-in and registration';
  if (path.startsWith('/m/')) return 'Guest QR menu';
  return 'Restaurant app';
}

/** Hour or calendar-day key in the viewer's time zone. */
function bucketFormatter(range: SiteAnalyticsRange, timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(range === 'today' ? { hour: '2-digit', hourCycle: 'h23' as const } : {}),
  });
}

function safeTimeZone(value: string | undefined): string {
  if (!value) return 'Asia/Kathmandu';
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return value;
  } catch {
    return 'Asia/Kathmandu';
  }
}

export async function siteAnalyticsReport(
  prisma: NayaroPrismaClient,
  options: { readonly range?: string; readonly timeZone?: string },
  now = new Date(),
): Promise<SiteAnalyticsReport> {
  const range: SiteAnalyticsRange =
    (['today', '7d', '30d', '90d'] as const).find((r) => r === options.range) ?? '7d';
  const timeZone = safeTimeZone(options.timeZone);
  const span = RANGE_DAYS[range] * DAY_MS;
  const start = new Date(now.getTime() - span);
  const previousStart = new Date(start.getTime() - span);

  const select = {
    visitorId: true,
    sessionId: true,
    path: true,
    referrer: true,
    country: true,
    device: true,
    browser: true,
    os: true,
    isNewSession: true,
    isNewVisitor: true,
    createdAt: true,
  } as const;
  const [rows, previousRows, liveVisitors, liveStaff] = await Promise.all([
    prisma.sitePageView.findMany({ where: { createdAt: { gte: start } }, select }),
    prisma.sitePageView.findMany({
      where: { createdAt: { gte: previousStart, lt: start } },
      select,
    }),
    prisma.siteVisitor.findMany({
      where: { lastSeenAt: { gte: new Date(now.getTime() - LIVE_WINDOW_MS) } },
      select: { currentPath: true, signedIn: true, country: true },
    }),
    prisma.session.findMany({
      where: {
        impersonatedByAdminId: null,
        revokedAt: null,
        expiresAt: { gt: now },
        lastSeenAt: { gte: new Date(now.getTime() - STAFF_ONLINE_MS) },
      },
      select: { staffId: true, restaurantId: true },
    }),
  ]);

  // Every bucket in the window, so quiet hours and days show as zero.
  const format = bucketFormatter(range, timeZone);
  const keyOf = (date: Date): string => {
    const parts = Object.fromEntries(
      format.formatToParts(date).map((part) => [part.type, part.value]),
    );
    return range === 'today'
      ? `${parts['year']!}-${parts['month']!}-${parts['day']!} ${parts['hour']!}`
      : `${parts['year']!}-${parts['month']!}-${parts['day']!}`;
  };
  const step = range === 'today' ? HOUR_MS : DAY_MS;
  const count = range === 'today' ? 24 : RANGE_DAYS[range];
  const buckets = new Map<string, { visitors: Set<string>; pageViews: number }>();
  for (let index = count - 1; index >= 0; index--) {
    buckets.set(keyOf(new Date(now.getTime() - index * step)), {
      visitors: new Set(),
      pageViews: 0,
    });
  }
  for (const row of rows) {
    const bucket = buckets.get(keyOf(row.createdAt));
    if (bucket === undefined) continue;
    bucket.visitors.add(row.visitorId);
    bucket.pageViews += 1;
  }

  const liveCountries = new Map<string, number>();
  const livePages = new Map<string, number>();
  for (const visitor of liveVisitors) {
    const country = visitor.country ?? '??';
    liveCountries.set(country, (liveCountries.get(country) ?? 0) + 1);
    const page = visitor.currentPath ?? '/';
    livePages.set(page, (livePages.get(page) ?? 0) + 1);
  }
  const ranked = (map: Map<string, number>): SiteAnalyticsRow[] =>
    [...map.entries()]
      .map(([key, value]) => ({ key, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);

  return {
    range,
    generatedAt: now.toISOString(),
    live: {
      visitors: liveVisitors.length,
      signedIn: liveVisitors.filter((visitor) => visitor.signedIn).length,
      restaurantsOnline: new Set(liveStaff.map((session) => session.restaurantId)).size,
      staffOnline: new Set(liveStaff.map((session) => session.staffId)).size,
      pages: ranked(livePages),
      countries: ranked(liveCountries),
    },
    current: totals(rows),
    previous: previousRows.length === 0 ? null : totals(previousRows),
    series: [...buckets.entries()].map(([key, bucket]) => ({
      key,
      label: range === 'today' ? `${key.slice(11)}:00` : key.slice(5),
      visitors: bucket.visitors.size,
      pageViews: bucket.pageViews,
    })),
    topPages: top(rows, (row) => row.path, 10),
    referrers: top(
      rows.filter((row) => row.isNewSession),
      (row) => row.referrer ?? 'Direct',
      10,
    ),
    countries: top(rows, (row) => row.country ?? '??', 12),
    devices: top(rows, (row) => row.device ?? 'unknown', 5),
    browsers: top(rows, (row) => row.browser ?? 'Other', 8),
    os: top(rows, (row) => row.os ?? 'Other', 8),
    areas: top(rows, (row) => areaOf(row.path), 4),
  };
}
