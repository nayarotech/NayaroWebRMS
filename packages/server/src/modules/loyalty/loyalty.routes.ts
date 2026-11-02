import { readIdempotencyAttempt } from '../../utils/idempotency';
import { Router } from 'express';
import type { NayaroPrismaClient } from '@nayaro/database';
import { requireAuthContext, requireRole } from '../../middleware/authentication';
import type { RealtimeEmitter } from '../../socket/realtimeEmitter';
import {
  getOrderLoyalty,
  getProgram,
  getStatement,
  selectLoyalty,
  updateProgram,
  returnRewardOnly,
} from './loyalty.service';

export function createLoyaltyRouter(prisma: NayaroPrismaClient, realtime: RealtimeEmitter) {
  const router = Router();
  const billing = requireRole('OWNER', 'MANAGER', 'CASHIER');
  router.get('/loyalty/settings', billing, async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(await getProgram(prisma, staff.restaurantId));
  });
  router.patch('/loyalty/settings', requireRole('OWNER'), async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(await updateProgram(prisma, staff.restaurantId, staff.id, req.body));
  });
  router.get('/customers/:customerId/loyalty', billing, async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(await getStatement(prisma, staff.restaurantId, String(req.params['customerId'])));
  });
  router.get('/orders/:orderId/loyalty', billing, async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(await getOrderLoyalty(prisma, staff.restaurantId, String(req.params['orderId'])));
  });
  router.post('/orders/:orderId/loyalty', billing, async (req, res) => {
    const { staff } = requireAuthContext(req);
    const orderId = String(req.params['orderId']);
    const result = await selectLoyalty(prisma, staff.restaurantId, orderId, req.body);
    realtime.orderUpdated({
      restaurantId: staff.restaurantId,
      orderId,
      tableId: null,
      deleted: false,
    });
    res.json(result);
  });
  router.post(
    '/invoices/:invoiceId/loyalty-return',
    requireRole('OWNER', 'MANAGER'),
    async (req, res) => {
      const { staff } = requireAuthContext(req);
      res.json(
        await returnRewardOnly(
          prisma,
          staff.restaurantId,
          staff.id,
          String(req.params['invoiceId']),
          req.body,
          readIdempotencyAttempt(req),
        ),
      );
    },
  );
  return router;
}
