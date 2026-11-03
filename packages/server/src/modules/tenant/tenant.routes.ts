import { Router, type Request } from 'express';
import type { NayaroPrismaClient } from '@nayaro/database';
import { ApiError } from '../../utils/apiError';
import type { Logger } from '../../utils/logger';
import { clientAddress } from '../../utils/clientAddress';
import { createRateLimit } from '../../middleware/rateLimit';
import { requireAuthContext } from '../../middleware/authentication';
import { recordAudit } from '../audit/audit.service';
import { workspaceSchema } from './tenant.schema';
import { getTenantSummary, lookupWorkspace, registerTenant, type RegisterTenantResult } from './tenant.service';
import { resendRegistrationCode, startRegistration, verifyRegistration } from './registration.service';
import type { Mailer } from '../email/mailer';
import { issueStaffSession } from '../auth/auth.service';

export interface TenantRouterDeps {
  readonly prisma: NayaroPrismaClient;
  readonly logger: Logger;
  /** Registrations allowed per address per hour. */
  readonly registrationsPerHour?: number;
  /** Sends the sign-up verification code. */
  readonly mailer: Mailer;
  /**
   * Enables the one-step POST /tenants/register, which skips email
   * verification. For tests and the demo seed only; the production start
   * script never turns it on.
   */
  readonly allowDirectRegistration?: boolean;
}

export function createTenantRouter(deps: TenantRouterDeps): Router {
  const router = Router();

  const registrationLimit = createRateLimit({
    windowMs: 60 * 60 * 1000,
    max: deps.registrationsPerHour ?? 5,
    message: 'Too many restaurants registered from this network. Try again later.',
  });
  const lookupLimit = createRateLimit({ windowMs: 60 * 1000, max: 30 });

  const resendLimit = createRateLimit({
    windowMs: 60 * 60 * 1000,
    max: 10,
    message: 'Too many codes requested from this network. Try again later.',
  });
  const verifyLimit = createRateLimit({
    windowMs: 15 * 60 * 1000,
    max: 30,
    message: 'Too many attempts from this network. Try again later.',
  });

  const audited = async (req: Request, result: RegisterTenantResult, how: string): Promise<void> => {
    await recordAudit(
      deps.prisma,
      {
        restaurantId: result.restaurantId,
        staffId: result.ownerStaffId,
        action: 'TENANT_REGISTERED',
        summary: `Restaurant "${result.restaurantName}" registered${how}`,
        ipAddress: clientAddress(req),
      },
      deps.logger,
    );
    deps.logger.info(`Tenant registered: ${result.workspace}${how}`);
  };

  router.post('/tenants/register', registrationLimit, async (req, res) => {
    if (deps.allowDirectRegistration !== true) {
      throw new ApiError(404, 'NOT_FOUND', 'Sign up at /tenants/register/start; the email must be verified.');
    }
    const result = await registerTenant(deps.prisma, req.body);
    await audited(req, result, '');
    res.status(201).json(result);
  });

  /** Step 1: validate the form and email a code. Nothing is created yet. */
  router.post('/tenants/register/start', registrationLimit, async (req, res) => {
    res.status(202).json(await startRegistration(deps.prisma, deps.mailer, req.body));
  });

  router.post('/tenants/register/resend', resendLimit, async (req, res) => {
    res.json(await resendRegistrationCode(deps.prisma, deps.mailer, req.body));
  });

  /**
   * Step 2: the code proves the address, the restaurant is created, and the
   * owner is signed in - the same response shape as POST /auth/login.
   */
  router.post('/tenants/register/verify', verifyLimit, async (req, res) => {
    const result = await verifyRegistration(deps.prisma, req.body);
    await audited(req, result, ' (email verified)');
    const owner = await deps.prisma.staff.findUniqueOrThrow({ where: { id: result.ownerStaffId } });
    const session = await issueStaffSession(deps.prisma, owner, {
      ipAddress: clientAddress(req),
      ...(req.header('user-agent') ? { userAgent: req.header('user-agent') } : {}),
    });
    res.status(201).json({
      token: session.token,
      expiresAt: session.expiresAt.toISOString(),
      staff: session.staff,
      tenant: await getTenantSummary(deps.prisma, result.restaurantId),
    });
  });

  router.get('/tenants/lookup', lookupLimit, async (req, res) => {
    const parsed = workspaceSchema.safeParse(req.query['workspace']);
    if (!parsed.success) {
      throw new ApiError(404, 'WORKSPACE_NOT_FOUND', 'No active restaurant uses that workspace code.');
    }
    res.json(await lookupWorkspace(deps.prisma, parsed.data));
  });

  router.get('/tenant', async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(await getTenantSummary(deps.prisma, staff.restaurantId));
  });

  return router;
}
