import { Router, type Request } from 'express';
import type { NayaroPrismaClient } from '@nayaro/database';
import { requireAuthContext, requireRole } from '../../middleware/authentication';
import { readIdempotencyAttempt } from '../../utils/idempotency';
import { ApiError } from '../../utils/apiError';
import * as credit from './credit.service';

const BILLING = ['OWNER', 'MANAGER', 'CASHIER'] as const;
const MANAGEMENT = ['OWNER', 'MANAGER'] as const;
function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string' || !value)
    throw new ApiError(400, 'BAD_REQUEST', 'Malformed request path.');
  return value;
}

export function createCreditRouter(prisma: NayaroPrismaClient): Router {
  const router = Router();
  router.get('/customers', requireRole(...BILLING), async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(await credit.listCustomers(prisma, staff.restaurantId, req.query));
  });
  router.post('/customers', requireRole(...BILLING), async (req, res) => {
    const { staff } = requireAuthContext(req);
    res
      .status(201)
      .json(
        await credit.createCustomer(
          prisma,
          staff.restaurantId,
          staff.id,
          req.body,
          readIdempotencyAttempt(req),
        ),
      );
  });
  router.get('/customers/:customerId/statement', requireRole(...BILLING), async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(await credit.getStatement(prisma, staff.restaurantId, param(req, 'customerId')));
  });
  router.patch('/customers/:customerId', requireRole(...MANAGEMENT), async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(
      await credit.editCustomer(prisma, staff.restaurantId, param(req, 'customerId'), req.body),
    );
  });
  router.post('/customers/:customerId/repayments', requireRole(...BILLING), async (req, res) => {
    const { staff } = requireAuthContext(req);
    res
      .status(201)
      .json(
        await credit.repay(
          prisma,
          staff.restaurantId,
          staff.id,
          param(req, 'customerId'),
          req.body,
          readIdempotencyAttempt(req),
        ),
      );
  });
  router.post(
    '/credit-repayments/:repaymentId/reverse',
    requireRole(...MANAGEMENT),
    async (req, res) => {
      const { staff } = requireAuthContext(req);
      res.json(
        await credit.reverseRepayment(
          prisma,
          staff.restaurantId,
          staff.id,
          param(req, 'repaymentId'),
          req.body,
          readIdempotencyAttempt(req),
        ),
      );
    },
  );
  router.get('/credit/unassigned', requireRole(...BILLING), async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(await credit.unassignedCredits(prisma, staff.restaurantId));
  });
  router.post('/credit/:paymentId/customer', requireRole(...MANAGEMENT), async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(
      await credit.assignCredit(
        prisma,
        staff.restaurantId,
        staff.id,
        param(req, 'paymentId'),
        req.body,
        readIdempotencyAttempt(req),
      ),
    );
  });
  return router;
}
