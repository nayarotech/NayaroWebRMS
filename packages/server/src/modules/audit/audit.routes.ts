import { Router } from 'express';
import type { NayaroPrismaClient } from '@nayaro/database';
import { requireAuthContext, requireRole } from '../../middleware/authentication';
import { listAuditLog } from './audit.service';

export function createAuditRouter(prisma: NayaroPrismaClient): Router {
  const router = Router();

  router.get('/audit-log', requireRole('OWNER'), async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(await listAuditLog(prisma, staff.restaurantId, req.query));
  });

  return router;
}
