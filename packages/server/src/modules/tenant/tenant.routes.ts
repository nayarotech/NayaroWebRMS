import { Router } from 'express';
import type { NayaroPrismaClient } from '@nayaro/database';
import { ApiError } from '../../utils/apiError';
import type { Logger } from '../../utils/logger';
import { clientAddress } from '../../utils/clientAddress';
import { createRateLimit } from '../../middleware/rateLimit';
import { requireAuthContext } from '../../middleware/authentication';
import { recordAudit } from '../audit/audit.service';
import { workspaceSchema } from './tenant.schema';
import { getTenantSummary, lookupWorkspace, registerTenant } from './tenant.service';

export interface TenantRouterDeps {
  readonly prisma: NayaroPrismaClient;
  readonly logger: Logger;
  /** Registrations allowed per address per hour. */
  readonly registrationsPerHour?: number;
}

export function createTenantRouter(deps: TenantRouterDeps): Router {
  const router = Router();

  const registrationLimit = createRateLimit({
    windowMs: 60 * 60 * 1000,
    max: deps.registrationsPerHour ?? 5,
    message: 'Too many restaurants registered from this network. Try again later.',
  });
  const lookupLimit = createRateLimit({ windowMs: 60 * 1000, max: 30 });

  router.post('/tenants/register', registrationLimit, async (req, res) => {
    const result = await registerTenant(deps.prisma, req.body);
    await recordAudit(
      deps.prisma,
      {
        restaurantId: result.restaurantId,
        staffId: result.ownerStaffId,
        action: 'TENANT_REGISTERED',
        summary: `Restaurant "${result.restaurantName}" registered`,
        ipAddress: clientAddress(req),
      },
      deps.logger,
    );
    deps.logger.info(`Tenant registered: ${result.workspace}`);
    res.status(201).json(result);
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
