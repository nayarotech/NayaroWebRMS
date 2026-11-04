import type { LoginResponse, TenantStatus } from './api';

/**
 * The Nayaro platform console (/admin): Nayaro Technology's own view across
 * every restaurant. Separate accounts and sessions from restaurant staff.
 */

export interface PlatformAdminDto {
  readonly id: string;
  readonly email: string;
  readonly name: string;
}

export interface PlatformLoginRequest {
  readonly email: string;
  readonly password: string;
}

export interface PlatformLoginResponse {
  readonly token: string;
  readonly expiresAt: string;
  readonly admin: PlatformAdminDto;
}

export interface PlatformDayPoint {
  /** YYYY-MM-DD (UTC). */
  readonly date: string;
  readonly value: number;
}

export interface PlatformTenantRow {
  readonly id: string;
  readonly workspace: string;
  readonly name: string;
  readonly status: TenantStatus;
  readonly plan: string;
  readonly isActive: boolean;
  readonly createdAt: string;
  readonly subscriptionEndsAt: string | null;
  /** Whole days until the trial or subscription ends; negative once past. Null when it never ends. */
  readonly daysLeft: number | null;
  readonly owner: { readonly name: string; readonly email: string | null; readonly username: string } | null;
  readonly contactEmail: string | null;
  readonly phone: string;
  readonly staffCount: number;
  /** Most recent request by anyone in this restaurant. */
  readonly lastActiveAt: string | null;
  readonly onlineNow: number;
  readonly ordersTotal: number;
  readonly bills30d: number;
  readonly sales30dPaisa: number;
}

export interface PlatformActivityEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly action: string;
  readonly summary: string;
  readonly ipAddress: string | null;
  readonly restaurant: { readonly id: string; readonly name: string; readonly workspace: string };
  readonly staffName: string | null;
}

export interface PlatformOverview {
  readonly generatedAt: string;
  readonly tenants: {
    readonly total: number;
    readonly trial: number;
    readonly active: number;
    readonly suspended: number;
    readonly cancelled: number;
    readonly trialEndingSoon: number;
    readonly trialExpired: number;
    readonly newThisWeek: number;
  };
  /** Restaurants with any staff activity in the window. */
  readonly activeRestaurants: { readonly today: number; readonly week: number };
  readonly onlineNow: { readonly people: number; readonly restaurants: number };
  readonly pendingSignups: number;
  readonly bills: { readonly today: number; readonly last30d: number; readonly sales30dPaisa: number };
  readonly signupsPerDay: readonly PlatformDayPoint[];
  readonly activeRestaurantsPerDay: readonly PlatformDayPoint[];
  readonly billsPerDay: readonly PlatformDayPoint[];
  readonly trialsEndingSoon: readonly PlatformTenantRow[];
  readonly recentSignups: readonly PlatformTenantRow[];
  readonly recentActivity: readonly PlatformActivityEntry[];
}

export interface PlatformTenantsResponse {
  readonly tenants: readonly PlatformTenantRow[];
}

export interface PlatformTenantDetail {
  readonly tenant: PlatformTenantRow & {
    readonly address: string;
    readonly panNumber: string;
    readonly statusReason: string | null;
  };
  readonly totals: {
    readonly orders: number;
    readonly bills: number;
    readonly salesPaisa: number;
    readonly menuItems: number;
    readonly tables: number;
    readonly customers: number;
  };
  readonly salesPerDay: readonly PlatformDayPoint[];
  readonly billsPerDay: readonly PlatformDayPoint[];
  readonly staff: readonly {
    readonly id: string;
    readonly name: string;
    readonly username: string;
    readonly email: string | null;
    readonly role: string;
    readonly isActive: boolean;
    readonly lastLoginAt: string | null;
  }[];
  readonly sessions: readonly {
    readonly id: string;
    readonly staffName: string;
    readonly deviceLabel: string | null;
    readonly ipAddress: string | null;
    readonly userAgent: string | null;
    readonly createdAt: string;
    readonly lastSeenAt: string;
    readonly supportView: string | null;
  }[];
  readonly activity: readonly PlatformActivityEntry[];
}

export type PlatformTenantAction =
  | { readonly action: 'extend'; readonly days: number }
  | { readonly action: 'activate'; readonly until: string | null }
  | { readonly action: 'suspend'; readonly reason: string }
  | { readonly action: 'reactivate' };

export interface PlatformPendingSignup {
  readonly email: string;
  readonly workspace: string;
  readonly restaurantName: string;
  readonly ownerName: string;
  readonly createdAt: string;
  readonly lastSentAt: string;
  readonly expiresAt: string;
  readonly attempts: number;
  readonly expired: boolean;
}

export interface PlatformActivityResponse {
  readonly entries: readonly PlatformActivityEntry[];
  /** Pass as `before` to load older entries; null at the end. */
  readonly nextBefore: string | null;
}

/** A read-only session as the restaurant's owner, for support. */
export type PlatformImpersonationResponse = LoginResponse & {
  readonly impersonation: { readonly adminName: string; readonly expiresAt: string };
};

// --- Website analytics (rms.nayaro.tech visitors) ---------------------------

export type SiteAnalyticsRange = 'today' | '7d' | '30d' | '90d';

export interface SiteAnalyticsTotals {
  readonly uniqueVisitors: number;
  readonly newVisitors: number;
  readonly visits: number;
  readonly pageViews: number;
  readonly pagesPerVisit: number;
}

export interface SiteAnalyticsRow {
  readonly key: string;
  readonly value: number;
}

export interface SiteAnalyticsReport {
  readonly range: SiteAnalyticsRange;
  readonly generatedAt: string;
  readonly live: {
    /** Browsers with the site open in the last few minutes. */
    readonly visitors: number;
    readonly signedIn: number;
    readonly restaurantsOnline: number;
    readonly staffOnline: number;
    readonly pages: readonly SiteAnalyticsRow[];
    readonly countries: readonly SiteAnalyticsRow[];
  };
  readonly current: SiteAnalyticsTotals;
  /** The same length of time just before; null when nothing was recorded then. */
  readonly previous: SiteAnalyticsTotals | null;
  /** Hourly for "today" (last 24 hours), daily otherwise. */
  readonly series: readonly { readonly key: string; readonly label: string; readonly visitors: number; readonly pageViews: number }[];
  readonly topPages: readonly SiteAnalyticsRow[];
  readonly referrers: readonly SiteAnalyticsRow[];
  readonly countries: readonly SiteAnalyticsRow[];
  readonly devices: readonly SiteAnalyticsRow[];
  readonly browsers: readonly SiteAnalyticsRow[];
  readonly os: readonly SiteAnalyticsRow[];
  /** Landing page, sign-in/registration, the restaurant app, guest QR menus. */
  readonly areas: readonly SiteAnalyticsRow[];
}

/** What the browser sends for each page view. */
export interface SiteHitRequest {
  readonly visitorId: string;
  readonly sessionId: string;
  readonly newSession: boolean;
  readonly path: string;
  readonly referrer?: string;
  readonly utmSource?: string | null;
  readonly timeZone?: string;
  readonly language?: string;
  readonly signedIn?: boolean;
}

// --- Enquiries (sent to the central Nayaro inbox at nayaro.tech) -----------

export type EnquiryKind = 'quote' | 'demo' | 'contact';

export interface EnquiryRequest {
  readonly kind: EnquiryKind;
  readonly name: string;
  readonly email: string;
  readonly phone?: string;
  /** The restaurant's name. */
  readonly company?: string;
  readonly outlets?: string;
  readonly message?: string;
  /** Page the form was opened from, e.g. "/#pricing". */
  readonly page?: string;
  /** Spam trap: a hidden field people never fill in. */
  readonly website?: string;
}
