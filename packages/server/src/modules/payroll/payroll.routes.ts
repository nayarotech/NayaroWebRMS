import { Router } from 'express';
import type { NayaroPrismaClient } from '@nayaro/database';
import { requireAuthContext, requireRole } from '../../middleware/authentication';
import { readIdempotencyAttempt } from '../../utils/idempotency';
import * as payroll from './payroll.service';
export function createPayrollRouter(prisma: NayaroPrismaClient) {
  const router = Router();
  router.use('/payroll', requireRole('OWNER'));
  router.get('/payroll', async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(await payroll.getPayroll(prisma, staff.restaurantId, req.query['month']));
  });
  router.get('/payroll/records/:id', async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(await payroll.getPayrollRecord(prisma, staff.restaurantId, String(req.params['id'])));
  });
  router.post('/payroll/profiles/:staffId', async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(
      await payroll.saveProfile(
        prisma,
        staff.restaurantId,
        staff.id,
        String(req.params['staffId']),
        req.body,
        readIdempotencyAttempt(req),
      ),
    );
  });
  router.post('/payroll/records', async (req, res) => {
    const { staff } = requireAuthContext(req);
    res
      .status(201)
      .json(
        await payroll.createPayroll(
          prisma,
          staff.restaurantId,
          staff.id,
          req.body,
          readIdempotencyAttempt(req),
        ),
      );
  });
  router.post('/payroll/records/:id/edit', async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(
      await payroll.editPayroll(
        prisma,
        staff.restaurantId,
        staff.id,
        String(req.params['id']),
        req.body,
        readIdempotencyAttempt(req),
      ),
    );
  });
  for (const mode of ['approve', 'reopen'] as const)
    router.post(`/payroll/records/:id/${mode}`, async (req, res) => {
      const { staff } = requireAuthContext(req);
      res.json(
        await payroll.transitionPayroll(
          prisma,
          staff.restaurantId,
          staff.id,
          String(req.params['id']),
          mode === 'approve' ? 'APPROVE' : 'REOPEN',
          req.body,
          readIdempotencyAttempt(req),
        ),
      );
    });
  router.post('/payroll/records/:id/payments', async (req, res) => {
    const { staff } = requireAuthContext(req);
    res
      .status(201)
      .json(
        await payroll.payPayroll(
          prisma,
          staff.restaurantId,
          staff.id,
          String(req.params['id']),
          req.body,
          readIdempotencyAttempt(req),
        ),
      );
  });
  return router;
}
