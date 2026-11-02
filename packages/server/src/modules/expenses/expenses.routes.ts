import { Router } from 'express';
import { z } from 'zod';
import type { NayaroPrismaClient } from '@nayaro/database';
import type { ExpenseDto, ExpenseSummaryDto } from '@nayaro/shared';
import { requireAuthContext, requireRole } from '../../middleware/authentication';
import { ApiError } from '../../utils/apiError';
import { resolveBusinessDate } from '../../utils/businessDate';
import { readIdempotencyAttempt, withRequestReceipt } from '../../utils/idempotency';
import { linkedPayOut } from '../drawer/drawer.service';

export const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const date = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }, 'Enter a valid date.');
const receiptSchema = z.object({
  name: z.string().trim().min(1).max(160),
  mime: z.enum(['image/png', 'image/jpeg', 'application/pdf']),
  base64: z
    .string()
    .min(4)
    .max(2_800_000)
    .regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
const schema = z
  .object({
    amountPaisa: z.int().min(1).max(1_000_000_000),
    method: z.enum(['CASH', 'QR', 'CARD']),
    category: z.string().trim().min(1).max(80),
    supplier: z.string().trim().max(160).optional(),
    note: z.string().trim().min(3).max(300),
    businessDate: calendarDate,
    drawer: z.enum(['EXTERNAL', 'NEW', 'LINK']),
    cashMovementId: z.string().min(1).optional(),
    receipt: receiptSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.drawer !== 'EXTERNAL' && value.method !== 'CASH')
      ctx.addIssue({ code: 'custom', message: 'Only cash expenses use the drawer.' });
    if ((value.drawer === 'LINK') !== (value.cashMovementId !== undefined))
      ctx.addIssue({
        code: 'custom',
        message: 'Choose the existing drawer payout only when linking one.',
      });
  });
const expenseSelect = {
  id: true,
  amountPaisa: true,
  method: true,
  category: true,
  supplier: true,
  note: true,
  businessDate: true,
  createdAt: true,
  staff: { select: { id: true, name: true } },
  cashMovementId: true,
  receiptName: true,
} as const;
type ExpenseRow = { method: string; createdAt: Date } & Omit<ExpenseDto, 'method' | 'createdAt'>;
function dto(row: ExpenseRow): ExpenseDto {
  return {
    ...row,
    method: row.method as ExpenseDto['method'],
    createdAt: row.createdAt.toISOString(),
  };
}

export async function expenseSummary(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  from: string,
  to: string,
): Promise<ExpenseSummaryDto> {
  const range = { gte: from, lte: to };
  const [rows, sales, refunds, settings] = await Promise.all([
    prisma.expense.findMany({
      where: { restaurantId, businessDate: range },
      select: expenseSelect,
      orderBy: [{ businessDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    }),
    prisma.invoice.aggregate({
      where: { restaurantId, businessDate: range, status: 'ACTIVE' },
      _sum: { grandTotalPaisa: true },
    }),
    prisma.paymentRefund.aggregate({
      where: { restaurantId, businessDate: range },
      _sum: { amountPaisa: true },
    }),
    prisma.restaurantSettings.findUniqueOrThrow({ where: { restaurantId } }),
  ]);
  const totalPaisa = rows.reduce((sum, row) => sum + row.amountPaisa, 0);
  const salesPaisa = sales._sum.grandTotalPaisa ?? 0;
  const refundsPaisa = refunds._sum.amountPaisa ?? 0;
  const categories = new Map<string, number>();
  for (const row of rows)
    categories.set(row.category, (categories.get(row.category) ?? 0) + row.amountPaisa);
  return {
    currentBusinessDate: resolveBusinessDate(new Date(), settings.businessDayStartsAtMinutes, settings.timezone),
    from,
    to,
    expenses: rows.map(dto),
    totalPaisa,
    salesPaisa,
    refundsPaisa,
    salesLessRefundsAndExpensesPaisa: salesPaisa - refundsPaisa - totalPaisa,
    byCategory: [...categories].map(([category, amountPaisa]) => ({ category, amountPaisa })),
  };
}
export function createExpensesRouter(prisma: NayaroPrismaClient): Router {
  const router = Router();
  router.use('/expenses', requireRole('OWNER', 'MANAGER'));
  router.get('/expenses', async (req, res) => {
    const { staff } = requireAuthContext(req);
    const query = z
      .object({ from: calendarDate.optional(), to: calendarDate.optional() })
      .parse(req.query);
    const settings = await prisma.restaurantSettings.findUniqueOrThrow({
      where: { restaurantId: staff.restaurantId },
    });
    const today = resolveBusinessDate(new Date(), settings.businessDayStartsAtMinutes, settings.timezone);
    const from = query.from ?? today.slice(0, 7) + '-01';
    const to = query.to ?? today;
    if (from > to || Date.parse(to) - Date.parse(from) > 366 * 86400000)
      throw new ApiError(400, 'INVALID_DATE_RANGE', 'Choose a date range of up to one year.');
    res.json(await expenseSummary(prisma, staff.restaurantId, from, to));
  });
  router.post('/expenses', async (req, res) => {
    const { staff } = requireAuthContext(req);
    const input = schema.parse(req.body);
    const attempt = readIdempotencyAttempt(req);
    if (!attempt.key)
      throw new ApiError(400, 'REQUEST_KEY_REQUIRED', 'A request identifier is required.');
    if (input.receipt) {
      const bytes = Buffer.from(input.receipt.base64, 'base64');
      const valid =
        input.receipt.mime === 'application/pdf'
          ? bytes.subarray(0, 5).toString() === '%PDF-'
          : input.receipt.mime === 'image/png'
            ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
      if (!valid || bytes.length > 2_097_152)
        throw new ApiError(
          400,
          'INVALID_RECEIPT',
          'Attach a PNG, JPEG or PDF receipt of up to 2 MB.',
        );
    }
    const expense = await withRequestReceipt(
      prisma,
      staff.restaurantId,
      staff.id,
      'expense',
      input,
      attempt,
      async (tx) => {
        let cashMovementId: string | null = null;
        if (input.drawer === 'NEW')
          cashMovementId = await linkedPayOut(
            tx,
            staff.restaurantId,
            staff.id,
            input.amountPaisa,
            `Expense (${input.category}): ${input.note}`,
          );
        if (input.drawer === 'LINK') {
          const movement = await tx.cashMovement.findFirst({
            where: {
              id: input.cashMovementId!,
              restaurantId: staff.restaurantId,
              type: 'PAY_OUT',
              amountPaisa: input.amountPaisa,
            },
            include: { expense: true, refund: true },
          });
          if (!movement || movement.expense || movement.refund)
            throw new ApiError(
              409,
              'PAYOUT_UNAVAILABLE',
              'Choose an unlinked payout for this exact expense amount.',
            );
          cashMovementId = movement.id;
        }
        const row = await tx.expense.create({
          data: {
            restaurantId: staff.restaurantId,
            staffId: staff.id,
            amountPaisa: input.amountPaisa,
            method: input.method,
            category: input.category,
            supplier: input.supplier || null,
            note: input.note,
            businessDate: input.businessDate,
            cashMovementId,
            receiptName: input.receipt?.name ?? null,
            receiptMime: input.receipt?.mime ?? null,
            receiptBase64: input.receipt?.base64 ?? null,
          },
          select: expenseSelect,
        });
        return dto(row);
      },
    );
    res.status(201).json({ expense });
  });
  router.get('/expenses/:id/receipt', async (req, res) => {
    const { staff } = requireAuthContext(req);
    const row = await prisma.expense.findFirst({
      where: { id: z.string().parse(req.params['id']), restaurantId: staff.restaurantId },
      select: { receiptName: true, receiptMime: true, receiptBase64: true },
    });
    if (!row?.receiptBase64)
      throw new ApiError(404, 'RECEIPT_NOT_FOUND', 'No receipt is attached.');
    res.json({ name: row.receiptName, mime: row.receiptMime, base64: row.receiptBase64 });
  });
  return router;
}
