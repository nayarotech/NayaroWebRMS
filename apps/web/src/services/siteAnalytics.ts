import type { SiteHitRequest } from '@nayaro/shared';
import { API_BASE_URL } from '@/config/env';
import { useAuthStore } from '@/stores/authStore';

/**
 * First-party page-view tracking for the Nayaro console's Website analytics,
 * the same way nayaro.tech does it: a random id in localStorage tells
 * returning visitors apart, a visit ends after 30 idle minutes, and a light
 * heartbeat while the tab is visible powers "on the site now".
 *
 * No cookies and no third parties. The server drops query strings, hides ids
 * in paths, ignores bots and never stores an IP address. The Nayaro console
 * itself (/admin) is never tracked.
 */
const SESSION_IDLE_MS = 30 * 60 * 1000;
const HEARTBEAT_MS = 60 * 1000;
const VISITOR_KEY = 'ny_vid';
const SESSION_KEY = 'ny_sid';

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode or blocked storage: tracking simply treats each page as new.
  }
}

const randomId = (prefix: string): string =>
  `${prefix}${(crypto.randomUUID?.() ?? `${String(Date.now())}${String(Math.random())}`).replace(/[^a-z0-9]/gi, '').slice(0, 24)}`;

function send(path: '/analytics/hit' | '/analytics/ping', body: unknown): void {
  // keepalive lets the last hit of a visit survive the tab closing.
  void fetch(`${API_BASE_URL}${path}`, {
    method: 'POST',
    keepalive: true,
    credentials: 'omit',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => undefined);
}

const tracked = (pathname: string): boolean =>
  !(pathname === '/admin' || pathname.startsWith('/admin/'));
// A stored session counts: on a fresh page load the app is still confirming
// it with the server when the first page view is sent.
const signedIn = (): boolean => useAuthStore.getState().token !== null;

let lastPath: string | null = null;

export function trackPageView(pathname: string): void {
  if (!tracked(pathname) || pathname === lastPath) return;
  lastPath = pathname;

  let visitorId = read(VISITOR_KEY);
  if (visitorId === null) {
    visitorId = randomId('v_');
    write(VISITOR_KEY, visitorId);
  }
  const now = Date.now();
  let session: { id: string; last: number } | null;
  try {
    session = JSON.parse(read(SESSION_KEY) ?? 'null') as { id: string; last: number } | null;
  } catch {
    session = null;
  }
  const newSession = session === null || now - session.last > SESSION_IDLE_MS;
  const sessionId = newSession ? randomId('s_') : session!.id;
  write(SESSION_KEY, JSON.stringify({ id: sessionId, last: now }));

  const params = new URLSearchParams(window.location.search);
  const hit: SiteHitRequest = {
    visitorId,
    sessionId,
    newSession,
    path: pathname,
    referrer: newSession ? document.referrer : '',
    utmSource: params.get('utm_source'),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    language: navigator.language,
    signedIn: signedIn(),
  };
  send('/analytics/hit', hit);
}

/** Starts tracking: the current page now, every navigation after, and the heartbeat. */
export function startSiteAnalytics(
  subscribe: (listener: (pathname: string) => void) => () => void,
): () => void {
  trackPageView(window.location.pathname);
  const unsubscribe = subscribe(trackPageView);
  const timer = setInterval(() => {
    const visitorId = read(VISITOR_KEY);
    const pathname = window.location.pathname;
    if (document.visibilityState !== 'visible' || visitorId === null || !tracked(pathname)) return;
    // Activity keeps the visit open, so a long shift is one visit, not many.
    const raw = read(SESSION_KEY);
    try {
      const session = JSON.parse(raw ?? 'null') as { id: string; last: number } | null;
      if (session !== null)
        write(SESSION_KEY, JSON.stringify({ id: session.id, last: Date.now() }));
    } catch {
      // Ignore a corrupted value; the next page view starts a fresh visit.
    }
    send('/analytics/ping', { visitorId, path: pathname, signedIn: signedIn() });
  }, HEARTBEAT_MS);
  return () => {
    unsubscribe();
    clearInterval(timer);
  };
}
