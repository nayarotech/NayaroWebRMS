import { Router, type Request } from 'express';
import type { NayaroPrismaClient } from '@nayaro/database';
import { ApiError } from '../../utils/apiError';
import { requireAuthContext, requireRole } from '../../middleware/authentication';
import type { Logger } from '../../utils/logger';
import * as drawerService from '../drawer/drawer.service';
import * as dailyReport from './dailyReport.service';
import { getSalesOverview } from './overview.service';

export interface ReportsRouterDeps {
  readonly prisma: NayaroPrismaClient;
  readonly logger: Logger;
}

/**
 * The cash drawer and the end-of-day report.
 *
 * THE DRAWER is the cashier's: whoever takes money opens the till, pays out
 * petty cash and counts it at close. Each of those writes their name down, and
 * the count cannot be edited afterwards - so letting a cashier do it costs
 * nothing in control and saves a manager being called to the counter at
 * midnight.
 *
 * THE REPORT is the owner's and manager's. It lists every correction made
 * that day and by whom, which is precisely the information a cashier should
 * not be able to read before deciding whether to make one.
 */
const CAN_HANDLE_CASH = ['OWNER', 'MANAGER', 'CASHIER'] as const;
const CAN_READ_REPORTS = ['OWNER', 'MANAGER'] as const;

export function createReportsRouter(deps: ReportsRouterDeps): Router {
  const router = Router();

  /** `{ shift: null }` is a normal answer: the drawer is closed. */
  router.get('/shifts/current', requireRole(...CAN_HANDLE_CASH), async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json({ shift: await drawerService.getCurrentShift(deps.prisma, staff.restaurantId) });
  });

  router.post('/shifts', requireRole(...CAN_HANDLE_CASH), async (req, res) => {
    const { staff } = requireAuthContext(req);
    const shift = await drawerService.openShift(
      deps.prisma,
      staff.restaurantId,
      staff.id,
      req.body,
    );
    deps.logger.info(`drawer opened by ${staff.username}`);
    res.status(201).json({ shift });
  });

  /** A pay-in or pay-out. There is no edit or delete: a mistake gets an opposite entry. */
  router.post('/shifts/:shiftId/movements', requireRole(...CAN_HANDLE_CASH), async (req, res) => {
    const { staff } = requireAuthContext(req);
    const shift = await drawerService.recordMovement(
      deps.prisma,
      staff.restaurantId,
      staff.id,
      pathParam(req, 'shiftId'),
      req.body,
    );
    res.status(201).json({ shift });
  });

  router.post('/shifts/:shiftId/close', requireRole(...CAN_HANDLE_CASH), async (req, res) => {
    const { staff } = requireAuthContext(req);
    const shift = await drawerService.closeShift(
      deps.prisma,
      staff.restaurantId,
      staff.id,
      pathParam(req, 'shiftId'),
      req.body,
    );
    deps.logger.info(
      `drawer closed by ${staff.username}, variance ${String(shift.close?.variancePaisa ?? 0)} paisa`,
    );
    res.json({ shift });
  });

  router.get('/reports/overview', requireRole(...CAN_READ_REPORTS), async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(await getSalesOverview(deps.prisma, staff.restaurantId, req.query));
  });

  router.get('/reports/daily', requireRole(...CAN_READ_REPORTS), async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(await dailyReport.getDailyReport(deps.prisma, staff.restaurantId, req.query));
  });

  return router;
}

function pathParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Malformed request path.');
  }
  return value;
}
