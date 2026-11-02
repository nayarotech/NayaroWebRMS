import { Router, type Request } from 'express';
import type { NayaroPrismaClient } from '@nayaro/database';
import { ApiError } from '../../utils/apiError';
import { requireAuthContext, requireRole } from '../../middleware/authentication';
import type { RealtimeEmitter } from '../../socket/realtimeEmitter';
import type { Logger } from '../../utils/logger';
import { auditFromRequest } from '../audit/audit.service';
import * as menuManagement from '../menu/menu.management';
import * as settingsService from '../settings/settings.service';
import * as staffService from '../staff/staff.service';

export interface ManagementRouterDeps {
  readonly prisma: NayaroPrismaClient;
  readonly logger: Logger;
  readonly realtime: RealtimeEmitter;
}

/**
 * Management: menu, staff and settings.
 *
 * The same rules as every other router - `restaurantId` from the session,
 * never from the request; no Prisma in a handler; validated DTOs mapped
 * deliberately by services rather than spread into an update.
 *
 * Authorisation here is coarser than it looks. `requireRole` decides who may
 * reach an endpoint; the services decide whom they may reach THROUGH it. A
 * manager passes the role check on staff routes and is still refused when the
 * target is an owner, because otherwise the lowest-privileged manager could
 * promote themselves by editing the owner's account.
 */
const MANAGE = ['OWNER', 'MANAGER'] as const;
const OWNER_ONLY = ['OWNER'] as const;
const ANY_STAFF = ['OWNER', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN'] as const;

export function createManagementRouter(deps: ManagementRouterDeps): Router {
  const router = Router();

  // ---------------------------------------------------------------- menu
  router.get('/management/menu', requireRole(...MANAGE), async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(await menuManagement.getManagedMenu(deps.prisma, staff.restaurantId));
  });

  router.post('/management/menu/categories', requireRole(...MANAGE), async (req, res) => {
    const { staff } = requireAuthContext(req);
    const menu = await menuManagement.createCategory(deps.prisma, staff.restaurantId, req.body);
    announceMenu(deps, staff.restaurantId, 'category created');
    res.status(201).json(menu);
  });

  router.patch(
    '/management/menu/categories/:categoryId',
    requireRole(...MANAGE),
    async (req, res) => {
      const { staff } = requireAuthContext(req);
      const menu = await menuManagement.updateCategory(
        deps.prisma,
        staff.restaurantId,
        pathParam(req, 'categoryId'),
        req.body,
      );
      announceMenu(deps, staff.restaurantId, 'category updated');
      res.json(menu);
    },
  );

  router.post('/management/menu/items', requireRole(...MANAGE), async (req, res) => {
    const { staff } = requireAuthContext(req);
    const menu = await menuManagement.createItem(deps.prisma, staff.restaurantId, req.body);
    announceMenu(deps, staff.restaurantId, 'item created');
    res.status(201).json(menu);
  });

  router.patch('/management/menu/items/:itemId', requireRole(...MANAGE), async (req, res) => {
    const { staff } = requireAuthContext(req);
    const menu = await menuManagement.updateItem(
      deps.prisma,
      staff.restaurantId,
      pathParam(req, 'itemId'),
      req.body,
    );
    // The one management change worth broadcasting: a till holding a cached
    // menu would otherwise keep selling a dish just marked sold out.
    announceMenu(deps, staff.restaurantId, 'item updated');
    res.json(menu);
  });

  // --------------------------------------------------------------- staff
  router.get('/management/staff', requireRole(...MANAGE), async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(await staffService.listStaff(deps.prisma, staff.restaurantId, staff.id));
  });

  router.post('/management/staff', requireRole(...MANAGE), async (req, res) => {
    const { staff } = requireAuthContext(req);
    const result = await staffService.createStaff(deps.prisma, staff.restaurantId, staff, req.body);
    const body = req.body as { username?: unknown; role?: unknown };
    await auditFromRequest(
      deps.prisma,
      req,
      {
        action: 'STAFF_CREATED',
        summary: `Created staff account "${String(body.username ?? '')}" (${String(body.role ?? '')})`,
        entityType: 'Staff',
      },
      deps.logger,
    );
    res.status(201).json(result);
  });

  router.patch('/management/staff/:staffId', requireRole(...MANAGE), async (req, res) => {
    const { staff } = requireAuthContext(req);
    const targetId = pathParam(req, 'staffId');
    const result = await staffService.updateStaff(
      deps.prisma,
      staff.restaurantId,
      staff,
      targetId,
      req.body,
    );
    await auditFromRequest(
      deps.prisma,
      req,
      {
        action: 'STAFF_UPDATED',
        summary: `Updated staff account (${Object.keys(req.body as object).join(', ')})`,
        entityType: 'Staff',
        entityId: targetId,
      },
      deps.logger,
    );
    res.json(result);
  });

  router.post('/management/staff/:staffId/password', requireRole(...MANAGE), async (req, res) => {
    const { staff } = requireAuthContext(req);
    await staffService.resetStaffPassword(
      deps.prisma,
      staff.restaurantId,
      staff,
      pathParam(req, 'staffId'),
      req.body,
    );
    deps.logger.info(`Password reset for staff ${pathParam(req, 'staffId')} by ${staff.username}`);
    await auditFromRequest(
      deps.prisma,
      req,
      {
        action: 'STAFF_PASSWORD_RESET',
        summary: 'Reset a staff member’s password',
        entityType: 'Staff',
        entityId: pathParam(req, 'staffId'),
      },
      deps.logger,
    );
    res.status(204).end();
  });

  /**
   * Changing your OWN password. Open to every role, including waiter and
   * kitchen: anyone with an account should be able to change their own
   * credential, and this route can only ever affect the caller.
   */
  router.post('/auth/password', requireRole(...ANY_STAFF), async (req, res) => {
    const { staff } = requireAuthContext(req);
    await staffService.changeOwnPassword(deps.prisma, staff.id, req.body);
    deps.logger.info(`Password changed by ${staff.username}`);
    await auditFromRequest(
      deps.prisma,
      req,
      { action: 'AUTH_PASSWORD_CHANGED', summary: `${staff.name} changed their password` },
      deps.logger,
    );
    // Every session was revoked, including this one. The client signs in again,
    // which is honest: the credential it holds no longer exists.
    res.status(204).end();
  });

  // ------------------------------------------------------------ settings
  router.get('/management/settings', requireRole(...MANAGE), async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(await settingsService.getSettings(deps.prisma, staff.restaurantId));
  });

  /** Identity printed on every invoice as the seller. Owner only. */
  router.patch('/management/settings/restaurant', requireRole(...OWNER_ONLY), async (req, res) => {
    const { staff } = requireAuthContext(req);
    const result = await settingsService.updateRestaurant(
      deps.prisma,
      staff.restaurantId,
      staff.id,
      req.body,
    );
    await auditFromRequest(
      deps.prisma,
      req,
      { action: 'SETTINGS_RESTAURANT_UPDATED', summary: 'Updated restaurant details' },
      deps.logger,
    );
    res.json(result);
  });

  /**
   * Tax and invoice configuration. Owner only, because each switch is a claim
   * about the business: enabling VAT asserts the restaurant is registered,
   * and enabling abbreviated invoices asserts the tax office authorised it.
   */
  router.patch('/management/settings/financial', requireRole(...OWNER_ONLY), async (req, res) => {
    const { staff } = requireAuthContext(req);
    const settings = await settingsService.updateFinancialSettings(
      deps.prisma,
      staff.restaurantId,
      staff.id,
      req.body,
    );
    deps.logger.info(`Financial settings changed by ${staff.username}`);
    await auditFromRequest(
      deps.prisma,
      req,
      {
        action: 'SETTINGS_FINANCIAL_UPDATED',
        summary: `Updated tax and invoice settings (${Object.keys(req.body as object).join(', ')})`,
      },
      deps.logger,
    );
    res.json(settings);
  });

  /** Day-to-day operational and display settings. A manager may change these. */
  router.patch('/management/settings/operational', requireRole(...MANAGE), async (req, res) => {
    const { staff } = requireAuthContext(req);
    const result = await settingsService.updateOperationalSettings(
      deps.prisma,
      staff.restaurantId,
      staff.id,
      req.body,
    );
    await auditFromRequest(
      deps.prisma,
      req,
      { action: 'SETTINGS_OPERATIONAL_UPDATED', summary: 'Updated operational settings' },
      deps.logger,
    );
    res.json(result);
  });

  return router;
}

function announceMenu(deps: ManagementRouterDeps, restaurantId: string, what: string): void {
  deps.realtime.menuUpdated({ restaurantId });
  deps.logger.debug(`menu:updated (${what})`);
}

function pathParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Malformed request path.');
  }
  return value;
}
