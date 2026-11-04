/** Website analytics: collection, privacy rules, countries, live visitors and the console report. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PlatformLoginResponse, SiteAnalyticsReport } from '@nayaro/shared';
import { ensureDataLayout, resolveDataLayout } from '@nayaro/database';
import { startNayaroServer, stopNayaroServer } from '../src/server';
import { upsertPlatformAdmin } from '../src/modules/platform/platform.auth';

const root = mkdtempSync(join(tmpdir(), 'nayaro-site-analytics-'));
const layout = ensureDataLayout(resolveDataLayout(root));
let handle: Awaited<ReturnType<typeof startNayaroServer>> | undefined;
let checks = 0;
const CHROME_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<number> {
  const response = await fetch(`${handle!.baseUrl}${path}`, {
    method: 'POST',
    headers: { Connection: 'close', 'Content-Type': 'application/json', 'User-Agent': CHROME_MAC, ...headers },
    body: JSON.stringify(body),
  });
  await response.text();
  checks++;
  return response.status;
}

const hit = (visitorId: string, sessionId: string, path: string, extra: Record<string, unknown> = {}) => ({
  visitorId,
  sessionId,
  newSession: false,
  path,
  timeZone: 'Asia/Kathmandu',
  language: 'en-US',
  ...extra,
});

try {
  handle = await startNayaroServer({ host: '127.0.0.1', port: 0, databaseFilePath: layout.databaseFilePath, silent: true });
  await upsertPlatformAdmin(handle.prisma, { email: 'ops@nayaro.tech', name: 'Ops', password: 'analytics-test-password' });

  // A visitor from Nepal: landing page from Facebook, then the app.
  assert.equal(
    await post('/analytics/hit', hit('visitor_nepal_01', 'session_np_0001', '/', {
      newSession: true,
      referrer: 'https://lm.facebook.com/l.php?u=x',
      utmSource: 'facebook',
    })),
    204,
  );
  await post('/analytics/hit', hit('visitor_nepal_01', 'session_np_0001', '/register?ref=fb'));
  await post('/analytics/hit', hit('visitor_nepal_01', 'session_np_0001', '/orders/cmvz2vccz000czyv8v2fsh4gl', { signedIn: true }));
  // A visitor in Japan on an iPhone, arriving directly.
  await post(
    '/analytics/hit',
    hit('visitor_japan_01', 'session_jp_0001', '/', { newSession: true, timeZone: 'Asia/Tokyo', language: 'ja-JP' }),
    { 'User-Agent': SAFARI_IPHONE },
  );
  // An edge country header wins over the time zone.
  await post(
    '/analytics/hit',
    hit('visitor_edge_001', 'session_edge_01', '/', { newSession: true, timeZone: 'Asia/Tokyo' }),
    { 'cf-ipcountry': 'AU' },
  );

  // Never recorded: bots, our own console, malformed hits. All still answer 204.
  assert.equal(await post('/analytics/hit', hit('visitor_bot_0001', 'session_bot_01', '/'), { 'User-Agent': 'Googlebot/2.1' }), 204);
  assert.equal(await post('/analytics/hit', hit('visitor_nepal_01', 'session_np_0001', '/admin/restaurants')), 204);
  assert.equal(await post('/analytics/hit', { visitorId: 'x', path: '/' }), 204);
  assert.equal(await post('/analytics/ping', { visitorId: 'visitor_nepal_01', path: '/tables', signedIn: true }), 204);

  const prisma = handle.prisma;
  assert.equal(await prisma.sitePageView.count(), 5, 'bots, console and malformed hits are dropped');
  const paths = (await prisma.sitePageView.findMany({ select: { path: true } })).map((row) => row.path);
  assert.ok(paths.includes('/orders/:id'), 'ids are hidden');
  assert.ok(paths.includes('/register'), 'query strings are dropped');
  assert.ok(!paths.some((path) => path.startsWith('/admin')));
  const nepal = await prisma.siteVisitor.findUniqueOrThrow({ where: { id: 'visitor_nepal_01' } });
  assert.equal(nepal.country, 'NP');
  assert.equal(nepal.currentPath, '/tables', 'the heartbeat updates where they are');
  assert.equal((await prisma.siteVisitor.findUniqueOrThrow({ where: { id: 'visitor_japan_01' } })).device, 'mobile');
  assert.equal((await prisma.siteVisitor.findUniqueOrThrow({ where: { id: 'visitor_edge_001' } })).country, 'AU');
  checks += 8;

  // The report is for console admins only.
  const denied = await fetch(`${handle.baseUrl}/platform/site-analytics`);
  assert.equal(denied.status, 401);
  const login = (await (
    await fetch(`${handle.baseUrl}/platform/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'ops@nayaro.tech', password: 'analytics-test-password' }),
    })
  ).json()) as PlatformLoginResponse;
  const report = (await (
    await fetch(`${handle.baseUrl}/platform/site-analytics?range=today&tz=Asia/Kathmandu`, {
      headers: { Authorization: `Bearer ${login.token}` },
    })
  ).json()) as SiteAnalyticsReport;

  assert.equal(report.current.uniqueVisitors, 3);
  assert.equal(report.current.newVisitors, 3);
  assert.equal(report.current.visits, 3);
  assert.equal(report.current.pageViews, 5);
  assert.equal(report.current.pagesPerVisit, 1.7);
  assert.equal(report.previous, null);
  assert.equal(report.series.length, 24, 'hourly for today');
  assert.equal(report.series.reduce((sum, bucket) => sum + bucket.pageViews, 0), 5);
  assert.deepEqual(report.countries.find((row) => row.key === 'JP'), { key: 'JP', value: 1 });
  assert.ok(report.referrers.some((row) => row.key === 'lm.facebook.com'));
  assert.ok(report.referrers.some((row) => row.key === 'Direct'));
  assert.equal(report.topPages[0]!.key, '/');
  assert.equal(report.live.visitors, 3);
  assert.equal(report.live.signedIn, 1);
  assert.ok(report.devices.some((row) => row.key === 'mobile'));
  assert.ok(report.areas.some((row) => row.key === 'Restaurant app'));
  checks += 16;

  const week = (await (
    await fetch(`${handle.baseUrl}/platform/site-analytics?range=30d`, { headers: { Authorization: `Bearer ${login.token}` } })
  ).json()) as SiteAnalyticsReport;
  assert.equal(week.series.length, 30, 'daily otherwise');
  checks++;

  console.log(`PASS: ${String(checks)} checks - collection, privacy rules, countries, live visitors and the report.`);
} finally {
  if (handle) await stopNayaroServer(handle);
  rmSync(root, { recursive: true, force: true });
}
