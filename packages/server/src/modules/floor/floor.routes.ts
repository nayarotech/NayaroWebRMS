import { Router } from 'express';
import type { NayaroPrismaClient } from '@nayaro/database';
import type { Request } from 'express';
import { ApiError } from '../../utils/apiError';
import {
  requireAuthContext,
  requireRole,
  requireServicePermission,
} from '../../middleware/authentication';
import type { RealtimeEmitter } from '../../socket/realtimeEmitter';
import type { Logger } from '../../utils/logger';
import * as floorService from './floor.service';

export interface FloorRouterDeps {
  readonly prisma: NayaroPrismaClient;
  readonly logger: Logger;
  readonly realtime: RealtimeEmitter;
}

/**
 * Floor routes.
 *
 * Two rules hold for every handler and are worth stating once:
 *
 *  1. `restaurantId` comes from `requireAuthContext(req)`, never from the body,
 *     query or path. The renderer cannot address another restaurant's floor.
 *  2. Routes contain no Prisma. They read the session, call a service, emit,
 *     and respond.
 *
 * Reading the floor follows the order-taking permission, including kitchen
 * staff with that extra duty. Changing its shape remains a management action.
 */
const CAN_CONFIGURE = ['OWNER', 'MANAGER'] as const;

export function createFloorRouter(deps: FloorRouterDeps): Router {
  const router = Router();

  router.get('/floor', requireServicePermission('TAKE_ORDERS'), async (req, res) => {
    const { staff } = requireAuthContext(req);
    // Managers configuring the floor need to see what they have switched off;
    // cashiers must not, or a deactivated table would still look bookable.
    const includeInactive =
      req.query['includeInactive'] === 'true' &&
      (staff.role === 'OWNER' || staff.role === 'MANAGER');
    res.json(await floorService.getFloor(deps.prisma, staff.restaurantId, { includeInactive }));
  });

  router.post('/floor/areas', requireRole(...CAN_CONFIGURE), async (req, res) => {
    const { staff } = requireAuthContext(req);
    const floor = await floorService.createArea(deps.prisma, staff.restaurantId, req.body);
    announce(deps, staff.restaurantId, 'area created');
    res.status(201).json(floor);
  });

  router.patch('/floor/areas/:areaId', requireRole(...CAN_CONFIGURE), async (req, res) => {
    const { staff } = requireAuthContext(req);
    const floor = await floorService.updateArea(
      deps.prisma,
      staff.restaurantId,
      pathParam(req, 'areaId'),
      req.body,
    );
    announce(deps, staff.restaurantId, 'area updated');
    res.json(floor);
  });

  router.post('/floor/tables', requireRole(...CAN_CONFIGURE), async (req, res) => {
    const { staff } = requireAuthContext(req);
    const floor = await floorService.createTable(deps.prisma, staff.restaurantId, req.body);
    announce(deps, staff.restaurantId, 'table created');
    res.status(201).json(floor);
  });

  router.patch('/floor/tables/:tableId', requireRole(...CAN_CONFIGURE), async (req, res) => {
    const { staff } = requireAuthContext(req);
    const floor = await floorService.updateTable(
      deps.prisma,
      staff.restaurantId,
      pathParam(req, 'tableId'),
      req.body,
    );
    announce(deps, staff.restaurantId, 'table updated');
    res.json(floor);
  });

  return router;
}

/**
 * Express 5 types path params as `string | string[] | undefined`. Rather than
 * casting the doubt away, this narrows it and turns the impossible case into a
 * normal 400.
 */
function pathParam(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ApiError(400, 'BAD_REQUEST', 'Malformed request path.');
  }
  return value;
}

/**
 * Emitted only after the service has returned, i.e. after the write committed.
 * Announcing a change that then rolls back would leave every other terminal
 * refetching to find nothing different - or worse, trusting the announcement.
 */
function announce(deps: FloorRouterDeps, restaurantId: string, what: string): void {
  deps.realtime.floorUpdated({ restaurantId });
  deps.logger.debug(`floor:updated (${what})`);
}
