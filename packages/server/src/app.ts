import { createPayrollRouter } from './modules/payroll/payroll.routes';
import express, { type Express } from 'express';
import type { NayaroPrismaClient } from '@nayaro/database';
import { createCorsMiddleware } from './middleware/cors';
import { createSecurityHeaders } from './middleware/securityHeaders';
import { createRateLimit } from './middleware/rateLimit';
import { createTenantRouter } from './modules/tenant/tenant.routes';
import type { Mailer } from './modules/email/mailer';
import { createAuditRouter } from './modules/audit/audit.routes';
import { createErrorHandler } from './middleware/errorHandler';
import { createNotFoundHandler } from './middleware/notFound';
import { createRequestLogger } from './middleware/requestLogger';
import { createAuthenticationMiddleware } from './middleware/authentication';
import { createLoyaltyRouter } from './modules/loyalty/loyalty.routes';
import { createOffersRouter } from './modules/offers/offers.routes';
import { createCustomerMenuRouter } from './modules/menu/customerMenu.routes';
import { createHealthRouter } from './modules/health/health.routes';
import { createAuthRouter } from './modules/auth/auth.routes';
import { createFloorRouter } from './modules/floor/floor.routes';
import { createOrdersRouter } from './modules/orders/orders.routes';
import { createManagementRouter } from './modules/management/management.routes';
import { createCreditRouter } from './modules/credit/credit.routes';
import { createReportsRouter } from './modules/reports/reports.routes';
import { createRefundsRouter } from './modules/refunds/refunds.routes';
import { createExpensesRouter } from './modules/expenses/expenses.routes';
import { createInventoryRouter } from './modules/inventory/inventory.routes';
import { noopRealtimeEmitter, type RealtimeEmitter } from './socket/realtimeEmitter';
import type { Logger } from './utils/logger';

/**
 * Builds the Express application - and nothing else.
 *
 * This file opens no ports, creates no database client and owns no lifecycle.
 * That separation is what makes the API testable: a test can call
 * `createNayaroApp()` with a fake Prisma client and drive it with supertest,
 * without a listening socket or a real SQLite file anywhere.
 *
 * Everything it needs arrives as an argument. There is no module-level client,
 * no singleton, and no import that reaches sideways for shared state.
 */
export interface CreateNayaroAppDeps {
  readonly prisma: NayaroPrismaClient;
  readonly logger: Logger;
  /** Wall-clock ms when startup completed, for uptime reporting. */
  readonly startedAt: number;
  /** Read at request time, so the app can be built before Socket.IO exists. */
  readonly realtimeReady: () => boolean;
  /** Announces domain changes. Defaults to a no-op so tests need no socket. */
  readonly realtime?: RealtimeEmitter;
  /** Decides which browser origins may read API responses. */
  readonly isAllowedOrigin: (origin: string | undefined) => boolean;
  /** Express `trust proxy` setting: the reverse proxy in front of the API. */
  readonly trustProxy?: boolean | number | string;
  /** Send HSTS. On when the API is served over HTTPS. */
  readonly hsts?: boolean;
  /** Authenticated requests per address per minute. */
  readonly apiRequestsPerMinute?: number;
  readonly registrationsPerHour?: number;
  /** Sends transactional email (sign-up codes). */
  readonly mailer: Mailer;
  /** See TenantRouterDeps.allowDirectRegistration. */
  readonly allowDirectRegistration?: boolean;
}

export function createNayaroApp(deps: CreateNayaroAppDeps): Express {
  const app = express();

  // Do not advertise the framework.
  app.disable('x-powered-by');
  app.set('trust proxy', deps.trustProxy ?? false);

  app.use(createSecurityHeaders({ hsts: deps.hsts ?? false }));
  app.use(createCorsMiddleware(deps.isAllowedOrigin));
  app.use(createRateLimit({ windowMs: 60 * 1000, max: deps.apiRequestsPerMinute ?? 600 }));
  app.use(express.json({ limit: '4mb' }));
  app.use(createRequestLogger(deps.logger));

  // --- authentication wall ------------------------------------------------
  // Mounted BEFORE every router, so protected-by-default is structural rather
  // than a habit. Only the routes in PUBLIC_ROUTES get past it.
  app.use(createAuthenticationMiddleware({ prisma: deps.prisma }));

  // --- routes -------------------------------------------------------------
  app.use(
    createHealthRouter({
      prisma: deps.prisma,
      logger: deps.logger.child('health'),
      startedAt: deps.startedAt,
      realtimeReady: deps.realtimeReady,
    }),
  );
  app.use(
    createTenantRouter({
      prisma: deps.prisma,
      logger: deps.logger.child('tenant'),
      mailer: deps.mailer,
      allowDirectRegistration: deps.allowDirectRegistration === true,
      ...(deps.registrationsPerHour === undefined
        ? {}
        : { registrationsPerHour: deps.registrationsPerHour }),
    }),
  );
  app.use(createAuditRouter(deps.prisma));
  app.use(createAuthRouter({ prisma: deps.prisma, logger: deps.logger.child('auth') }));
  app.use(
    createFloorRouter({
      prisma: deps.prisma,
      logger: deps.logger.child('floor'),
      realtime: deps.realtime ?? noopRealtimeEmitter,
    }),
  );
  app.use(
    createOrdersRouter({
      prisma: deps.prisma,
      logger: deps.logger.child('orders'),
      realtime: deps.realtime ?? noopRealtimeEmitter,
    }),
  );
  app.use(createCustomerMenuRouter(deps.prisma));
  app.use(createOffersRouter(deps.prisma, deps.realtime ?? noopRealtimeEmitter));
  app.use(createCreditRouter(deps.prisma));
  app.use(createLoyaltyRouter(deps.prisma, deps.realtime ?? noopRealtimeEmitter));
  app.use(createRefundsRouter(deps.prisma));
  app.use(createExpensesRouter(deps.prisma));
  app.use(createPayrollRouter(deps.prisma));
  app.use(createInventoryRouter(deps.prisma, deps.realtime ?? noopRealtimeEmitter));
  app.use(createReportsRouter({ prisma: deps.prisma, logger: deps.logger.child('reports') }));
  app.use(
    createManagementRouter({
      prisma: deps.prisma,
      logger: deps.logger.child('management'),
      realtime: deps.realtime ?? noopRealtimeEmitter,
    }),
  );

  // --- terminal handlers --------------------------------------------------
  // Order matters: unmatched routes become an ApiError, and the error handler
  // is the single place that turns any thrown value into a response.
  app.use(createNotFoundHandler());
  app.use(createErrorHandler(deps.logger));

  return app;
}
