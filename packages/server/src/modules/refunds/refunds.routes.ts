import { syncLoyalty } from '../loyalty/loyalty.service';
import { Router } from 'express';
import { z } from 'zod';
import type { NayaroPrismaClient } from '@nayaro/database';
import { requireAuthContext, requireRole } from '../../middleware/authentication';
import { ApiError } from '../../utils/apiError';
import { correctionReason } from '../../utils/correction';
import { resolveBusinessDate } from '../../utils/businessDate';
import { readIdempotencyAttempt, withRequestReceipt } from '../../utils/idempotency';
import { linkedPayOut } from '../drawer/drawer.service';
import { claimCustomer, creditBalance } from '../credit/credit.service';
import type { RefundSummaryDto } from '@nayaro/shared';
import { auditFromRequest } from '../audit/audit.service';

const schema = z.object({
  amountPaisa: z.int().min(1).max(1_000_000_000),
  expectedRefundedPaisa: z.int().min(0),
  reason: correctionReason,
});
export function createRefundsRouter(prisma: NayaroPrismaClient): Router {
  const router = Router();
  router.post('/payments/:paymentId/refunds', requireRole('OWNER', 'MANAGER'), async (req, res) => {
    const { staff } = requireAuthContext(req);
    const paymentId = z.string().parse(req.params['paymentId']);
    const input = schema.parse(req.body);
    const attempt = readIdempotencyAttempt(req);
    if (!attempt.key)
      throw new ApiError(
        400,
        'REQUEST_KEY_REQUIRED',
        'A request identifier is required. Refresh and try again.',
      );
    const refund = await withRequestReceipt(
      prisma,
      staff.restaurantId,
      staff.id,
      `refund:${paymentId}`,
      input,
      attempt,
      async (tx) => {
        const payment = await tx.payment.findFirst({
          where: { id: paymentId, restaurantId: staff.restaurantId },
          include: {
            invoice: { select: { status: true } },
            order: { select: { status: true } },
            refunds: true,
          },
        });
        if (!payment) throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'That payment does not exist.');
        if (
          payment.voidedAt ||
          payment.invoice.status !== 'ACTIVE' ||
          payment.order.status !== 'PAID'
        )
          throw new ApiError(
            409,
            'REFUND_NOT_ALLOWED',
            'Refunds require a valid payment on a settled bill.',
          );
        const refunded = payment.refunds.reduce((sum, row) => sum + row.amountPaisa, 0);
        if (refunded !== input.expectedRefundedPaisa)
          throw new ApiError(
            409,
            'REFUND_CHANGED',
            'Another refund was recorded. Check the refreshed history before trying again.',
          );
        if (input.amountPaisa > payment.amountPaisa - refunded)
          throw new ApiError(
            409,
            'REFUND_EXCEEDS_PAYMENT',
            'That exceeds the remaining refundable amount.',
          );
        if (payment.method === 'CREDIT') {
          if (!payment.customerId)
            throw new ApiError(
              409,
              'ASSIGN_CREDIT_FIRST',
              'Link this older credit payment to a customer account first.',
            );
          await claimCustomer(tx, staff.restaurantId, payment.customerId);
          if (input.amountPaisa > (await creditBalance(tx, staff.restaurantId, payment.customerId)))
            throw new ApiError(
              409,
              'CREDIT_ALREADY_REPAID',
              'This credit has been repaid. Reverse the applicable repayment before reducing the debt.',
            );
        }
        const settings = await tx.restaurantSettings.findUniqueOrThrow({
          where: { restaurantId: staff.restaurantId },
        });
        const cashMovementId =
          payment.method === 'CASH'
            ? await linkedPayOut(
                tx,
                staff.restaurantId,
                staff.id,
                input.amountPaisa,
                `Refund: ${input.reason}`,
              )
            : null;
        const row = await tx.paymentRefund.create({
          data: {
            restaurantId: staff.restaurantId,
            paymentId,
            customerId: payment.method === 'CREDIT' ? payment.customerId : null,
            method: payment.method,
            amountPaisa: input.amountPaisa,
            reason: input.reason,
            staffId: staff.id,
            cashMovementId,
            businessDate: resolveBusinessDate(new Date(), settings.businessDayStartsAtMinutes, settings.timezone),
          },
          include: { staff: { select: { id: true, name: true } } },
        });
        await syncLoyalty(tx, staff.restaurantId, staff.id, payment.invoiceId, `refund:${row.id}`);
        return { ...row, createdAt: row.createdAt.toISOString() };
      },
    );
    await auditFromRequest(prisma, req, {
      action: 'PAYMENT_REFUNDED',
      summary: `Refunded Rs ${(input.amountPaisa / 100).toFixed(2)}: ${input.reason}`,
      entityType: 'Payment',
      entityId: paymentId,
    });
    res.status(201).json({ refund });
  });
  return router;
}

export async function refundSummary(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  businessDate: string,
): Promise<RefundSummaryDto> {
  const rows = await prisma.paymentRefund.findMany({
    where: { restaurantId, businessDate },
    include: { staff: { select: { id: true, name: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const methods = ['CASH', 'QR', 'CARD', 'CREDIT'] as const;
  return {
    totalPaisa: rows.reduce((sum, row) => sum + row.amountPaisa, 0),
    byMethod: methods.map((method) => ({
      method,
      amountPaisa: rows
        .filter((row) => row.method === method)
        .reduce((sum, row) => sum + row.amountPaisa, 0),
    })),
    rows: rows.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
  };
}
