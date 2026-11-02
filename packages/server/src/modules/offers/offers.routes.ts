import { Router } from 'express';
import type { NayaroPrismaClient } from '@nayaro/database';
import { requireAuthContext, requireRole } from '../../middleware/authentication';
import type { RealtimeEmitter } from '../../socket/realtimeEmitter';
import { createOffer, listOffers, updateOffer } from './offers.service';

export function createOffersRouter(prisma: NayaroPrismaClient, realtime: RealtimeEmitter): Router {
  const router = Router();
  router.use('/management/offers', requireRole('OWNER', 'MANAGER'));
  router.get('/management/offers', async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(await listOffers(prisma, staff.restaurantId));
  });
  router.post('/management/offers', async (req, res) => {
    const { staff } = requireAuthContext(req);
    const result = await createOffer(prisma, staff.restaurantId, staff.id, req.body);
    realtime.menuUpdated({ restaurantId: staff.restaurantId });
    res.status(201).json(result);
  });
  router.patch('/management/offers/:id', async (req, res) => {
    const { staff } = requireAuthContext(req);
    const result = await updateOffer(
      prisma,
      staff.restaurantId,
      staff.id,
      String(req.params['id']),
      req.body,
    );
    realtime.menuUpdated({ restaurantId: staff.restaurantId });
    res.json(result);
  });
  return router;
}
