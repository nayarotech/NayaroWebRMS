export { startNayaroServer, stopNayaroServer } from './server';
export type { NayaroServerHandle, StartNayaroServerOptions } from './server';

export { DEFAULT_SERVER_HOST, DEFAULT_SERVER_PORT, resolveServerConfig } from './config/serverConfig';
export type { ResolvedServerConfig, ServerConfigInput } from './config/serverConfig';

export { createNayaroApp } from './app';
export type { CreateNayaroAppDeps } from './app';

export { ApiError, toApiErrorBody } from './utils/apiError';
export { createLogger, silentLogger } from './utils/logger';
export type { Logger, LogLevel } from './utils/logger';

export {
  registerTenant,
  setTenantStatus,
  getTenantSummary,
  tenantBlock,
  NEW_TENANT_SETTINGS,
  TRIAL_DAYS,
} from './modules/tenant/tenant.service';
export type { RegisterTenantResult, TenantBlock } from './modules/tenant/tenant.service';
export { registerTenantSchema } from './modules/tenant/tenant.schema';

export { hashPassword, verifyPassword, needsRehash } from './modules/auth/password';
export { login, logout } from './modules/auth/auth.service';
export type { LoginResult } from './modules/auth/auth.service';
export {
  createSession,
  checkSession,
  resolveSession,
  revokeSession,
  revokeAllSessionsForStaff,
  pruneExpiredSessions,
  hashSessionToken,
  SESSION_TTL_MS,
} from './modules/auth/session.service';
export type { AuthenticatedStaff } from './modules/auth/auth.types';
export {
  createAuthenticationMiddleware,
  requireRole,
  requireAuthContext,
  PUBLIC_ROUTES,
} from './middleware/authentication';

export { recordAudit } from './modules/audit/audit.service';

export {
  resolveNepaliFiscalYear,
  formatNepaliFiscalYear,
  fiscalYearStartDate,
  toBikramSambat,
  NepaliCalendarError,
  CORROBORATED_FISCAL_YEAR_STARTS,
} from './utils/nepaliCalendar';
export type { BikramSambatDate } from './utils/nepaliCalendar';

export * as floorService from './modules/floor/floor.service';
export { deriveTableStatus } from './modules/floor/floor.mapper';
export { createRealtimeEmitter, noopRealtimeEmitter } from './socket/realtimeEmitter';
export type { RealtimeEmitter } from './socket/realtimeEmitter';

export * as menuService from './modules/menu/menu.service';
export * as ordersService from './modules/orders/orders.service';
export { resolveBusinessDate } from './utils/businessDate';
export * as kitchenService from './modules/kitchen/kitchen.service';
export * as billingService from './modules/billing/billing.service';
export { calculateBill } from './modules/billing/billing.calc';
export { applyRateBp, roundToRupee } from './utils/money';
export * as paymentsService from './modules/payments/payments.service';
export * as printService from './modules/billing/print.service';
export * as menuManagement from './modules/menu/menu.management';
export * as staffService from './modules/staff/staff.service';
export * as settingsService from './modules/settings/settings.service';
