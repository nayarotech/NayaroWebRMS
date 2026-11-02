import { z } from 'zod';
import type { NayaroPrismaClient } from '@nayaro/database';
import type { PayrollOverview, PayrollRecordDto } from '@nayaro/shared';
import { ApiError } from '../../utils/apiError';
import { correctionReason } from '../../utils/correction';
import { resolveBusinessDate } from '../../utils/businessDate';
import {
  withRequestReceipt,
  type IdempotencyAttempt,
  type Transaction,
} from '../../utils/idempotency';
import { calendarDate } from '../expenses/expenses.routes';
import { linkedPayOut } from '../drawer/drawer.service';

const money = z.int().min(0).max(1_000_000_000);
const version = z.int().min(0);
export const payrollMonth = z.string().regex(/^(20\d{2}|21\d{2})-(0[1-9]|1[0-2])$/);
const profileSchema = z.object({ monthlySalaryPaisa: money, expectedVersion: version.nullable() });
const createSchema = z.object({
  staffId: z.string().min(1),
  month: payrollMonth,
  expectedProfileVersion: version,
});
const editSchema = z
  .object({
    expectedVersion: version,
    baseSalaryPaisa: money,
    allowancesPaisa: money,
    deductionsPaisa: money,
    note: correctionReason,
  })
  .refine(
    (row) =>
      row.baseSalaryPaisa + row.allowancesPaisa <= 1_000_000_000 &&
      row.deductionsPaisa <= row.baseSalaryPaisa + row.allowancesPaisa,
    'Deductions cannot exceed gross pay.',
  );
const transitionSchema = z.object({ expectedVersion: version, note: correctionReason });
const paymentSchema = z
  .object({
    expectedVersion: version,
    kind: z.enum(['ADVANCE', 'SALARY']),
    amountPaisa: money.min(1),
    method: z.enum(['CASH', 'QR', 'CARD']),
    drawer: z.enum(['EXTERNAL', 'NEW']),
    businessDate: calendarDate,
    note: correctionReason,
    reference: z.string().trim().max(80).optional(),
  })
  .refine(
    (row) => row.drawer === 'EXTERNAL' || row.method === 'CASH',
    'Only cash payroll payments can use the cash drawer.',
  );
const include = {
  approvedByStaff: { select: { name: true } },
  payments: {
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    include: {
      paidByStaff: { select: { name: true } },
      expense: { select: { cashMovementId: true } },
    },
  },
  audits: {
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    take: 100,
    include: { staff: { select: { name: true } } },
  },
};
async function loadRecord(
  tx: Pick<NayaroPrismaClient, 'payrollRecord'>,
  restaurantId: string,
  id: string,
) {
  const row = await tx.payrollRecord.findFirst({ where: { id, restaurantId }, include });
  if (!row) throw new ApiError(404, 'PAYROLL_NOT_FOUND', 'That payroll record does not exist.');
  return row;
}
function recordDto(row: Awaited<ReturnType<typeof loadRecord>>): PayrollRecordDto {
  const paidPaisa = row.payments.reduce((sum, payment) => sum + payment.amountPaisa, 0);
  const netSalaryPaisa = row.baseSalaryPaisa + row.allowancesPaisa - row.deductionsPaisa;
  return {
    id: row.id,
    staffId: row.staffId,
    staffName: row.staffNameSnapshot,
    month: row.month,
    status: z.enum(['DRAFT', 'APPROVED']).parse(row.status),
    version: row.version,
    baseSalaryPaisa: row.baseSalaryPaisa,
    allowancesPaisa: row.allowancesPaisa,
    deductionsPaisa: row.deductionsPaisa,
    netSalaryPaisa,
    paidPaisa,
    advancePaisa: row.payments
      .filter((payment) => payment.kind === 'ADVANCE')
      .reduce((sum, payment) => sum + payment.amountPaisa, 0),
    remainingPaisa: netSalaryPaisa - paidPaisa,
    settled: row.status === 'APPROVED' && netSalaryPaisa === paidPaisa,
    note: row.note,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedBy: row.approvedByStaff?.name ?? null,
    canReopen:
      row.status === 'APPROVED' && !row.payments.some((payment) => payment.kind === 'SALARY'),
    payments: row.payments.map((payment) => ({
      id: payment.id,
      kind: z.enum(['ADVANCE', 'SALARY']).parse(payment.kind),
      amountPaisa: payment.amountPaisa,
      method: z.enum(['CASH', 'QR', 'CARD']).parse(payment.method),
      reference: payment.reference,
      note: payment.note,
      businessDate: payment.businessDate,
      at: payment.createdAt.toISOString(),
      paidBy: payment.paidByStaff.name,
      expenseId: payment.expenseId,
      cashMovementId: payment.expense.cashMovementId,
    })),
    audits: row.audits.map((audit) => ({
      id: audit.id,
      kind: audit.kind,
      at: audit.createdAt.toISOString(),
      actor: audit.staff.name,
      note: audit.note,
      beforeJson: audit.beforeJson,
      afterJson: audit.afterJson,
    })),
  };
}
function requireKey(attempt: IdempotencyAttempt) {
  if (!attempt.key)
    throw new ApiError(
      400,
      'REQUEST_KEY_REQUIRED',
      'Refresh and try again with a request identifier.',
    );
}
type State = {
  baseSalaryPaisa: number;
  allowancesPaisa: number;
  deductionsPaisa: number;
  note: string;
  status: string;
  version: number;
  approvedAt: Date | null;
  approvedByStaffId: string | null;
  staffNameSnapshot: string;
  month: string;
};
const snapshot = (row: State) =>
  JSON.stringify({
    staffName: row.staffNameSnapshot,
    month: row.month,
    baseSalaryPaisa: row.baseSalaryPaisa,
    allowancesPaisa: row.allowancesPaisa,
    deductionsPaisa: row.deductionsPaisa,
    note: row.note,
    status: row.status,
    version: row.version,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedByStaffId: row.approvedByStaffId,
  });
async function audit(
  tx: Transaction,
  restaurantId: string,
  actorId: string,
  id: string,
  kind: string,
  before: string | null,
  note: string,
) {
  const after = await tx.payrollRecord.findUniqueOrThrow({ where: { id } });
  await tx.payrollAudit.create({
    data: {
      restaurantId,
      payrollRecordId: id,
      staffId: actorId,
      kind,
      beforeJson: before,
      afterJson: snapshot(after),
      note,
    },
  });
}
async function claim(
  tx: Transaction,
  restaurantId: string,
  actorId: string,
  id: string,
  expectedVersion: number,
  patch: Partial<{
    baseSalaryPaisa: number;
    allowancesPaisa: number;
    deductionsPaisa: number;
    note: string;
    status: 'DRAFT' | 'APPROVED';
    approvedAt: Date | null;
    approvedByStaffId: string | null;
  }> = {},
) {
  const changed = await tx.payrollRecord.updateMany({
    where: { id, restaurantId, version: expectedVersion },
    data: { ...patch, version: { increment: 1 }, updatedByStaffId: actorId },
  });
  if (changed.count !== 1)
    throw new ApiError(
      409,
      'PAYROLL_CHANGED',
      'This payroll record changed. Refresh before continuing.',
    );
}
export async function getPayroll(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  rawMonth?: unknown,
): Promise<PayrollOverview> {
  return prisma.$transaction(async (tx) => {
    const settings = await tx.restaurantSettings.findUniqueOrThrow({
      where: { restaurantId },
      select: { businessDayStartsAtMinutes: true, timezone: true },
    });
    const today = resolveBusinessDate(new Date(), settings.businessDayStartsAtMinutes, settings.timezone);
    const month = payrollMonth.parse(rawMonth ?? today.slice(0, 7));
    const [staff, records] = await Promise.all([
      tx.staff.findMany({
        where: { restaurantId },
        orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          isActive: true,
          payrollProfile: { select: { monthlySalaryPaisa: true, version: true } },
        },
      }),
      tx.payrollRecord.findMany({
        where: { restaurantId, month },
        orderBy: [{ staffNameSnapshot: 'asc' }, { id: 'asc' }],
        include,
      }),
    ]);
    const rows = records.map(recordDto);
    return {
      month,
      currentBusinessDate: today,
      staff: staff.map((row) => ({
        id: row.id,
        name: row.name,
        isActive: row.isActive,
        monthlySalaryPaisa: row.payrollProfile?.monthlySalaryPaisa ?? null,
        profileVersion: row.payrollProfile?.version ?? null,
      })),
      records: rows,
      totals: {
        approvedNetPaisa: rows
          .filter((row) => row.status === 'APPROVED')
          .reduce((sum, row) => sum + row.netSalaryPaisa, 0),
        paidPaisa: rows.reduce((sum, row) => sum + row.paidPaisa, 0),
        advancesPaisa: rows.reduce((sum, row) => sum + row.advancePaisa, 0),
        approvedRemainingPaisa: rows
          .filter((row) => row.status === 'APPROVED')
          .reduce((sum, row) => sum + row.remainingPaisa, 0),
      },
    };
  });
}
export async function getPayrollRecord(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  id: string,
) {
  return recordDto(await loadRecord(prisma, restaurantId, id));
}
export async function saveProfile(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  actorId: string,
  staffId: string,
  raw: unknown,
  attempt: IdempotencyAttempt,
) {
  const input = profileSchema.parse(raw);
  requireKey(attempt);
  return withRequestReceipt(
    prisma,
    restaurantId,
    actorId,
    `payroll-profile:${staffId}`,
    input,
    attempt,
    async (tx) => {
      const staff = await tx.staff.findFirst({
        where: { id: staffId, restaurantId },
        select: { id: true },
      });
      if (!staff) throw new ApiError(404, 'STAFF_NOT_FOUND', 'That staff member does not exist.');
      const profile = await tx.payrollProfile.findUnique({ where: { staffId } });
      if (input.expectedVersion === null && !profile)
        await tx.payrollProfile.create({
          data: {
            staffId,
            restaurantId,
            monthlySalaryPaisa: input.monthlySalaryPaisa,
            updatedByStaffId: actorId,
          },
        });
      else {
        if (!profile || input.expectedVersion === null)
          throw new ApiError(
            409,
            'PAYROLL_PROFILE_CHANGED',
            'Salary settings changed. Refresh before saving.',
          );
        const changed = await tx.payrollProfile.updateMany({
          where: { staffId, restaurantId, version: input.expectedVersion },
          data: {
            monthlySalaryPaisa: input.monthlySalaryPaisa,
            updatedByStaffId: actorId,
            version: { increment: 1 },
          },
        });
        if (changed.count !== 1)
          throw new ApiError(
            409,
            'PAYROLL_PROFILE_CHANGED',
            'Salary settings changed. Refresh before saving.',
          );
      }
      return { saved: true };
    },
  );
}
export async function createPayroll(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  actorId: string,
  raw: unknown,
  attempt: IdempotencyAttempt,
) {
  const input = createSchema.parse(raw);
  requireKey(attempt);
  return withRequestReceipt(
    prisma,
    restaurantId,
    actorId,
    'create-payroll',
    input,
    attempt,
    async (tx) => {
      const staff = await tx.staff.findFirst({
        where: { id: input.staffId, restaurantId },
        select: { name: true, payrollProfile: true },
      });
      if (!staff) throw new ApiError(404, 'STAFF_NOT_FOUND', 'That staff member does not exist.');
      const profile = staff.payrollProfile;
      if (!profile || profile.version !== input.expectedProfileVersion)
        throw new ApiError(
          409,
          'PAYROLL_PROFILE_CHANGED',
          'Set or refresh the monthly salary before creating payroll.',
        );
      if (
        await tx.payrollRecord.count({
          where: { restaurantId, staffId: input.staffId, month: input.month },
        })
      )
        throw new ApiError(
          409,
          'PAYROLL_EXISTS',
          'This staff member already has a payroll record for this month.',
        );
      const row = await tx.payrollRecord.create({
        data: {
          restaurantId,
          staffId: input.staffId,
          staffNameSnapshot: staff.name,
          month: input.month,
          baseSalaryPaisa: profile.monthlySalaryPaisa,
          createdByStaffId: actorId,
          updatedByStaffId: actorId,
        },
      });
      await audit(
        tx,
        restaurantId,
        actorId,
        row.id,
        'CREATE',
        null,
        'Created from monthly salary settings',
      );
      return recordDto(await loadRecord(tx, restaurantId, row.id));
    },
  );
}
export async function editPayroll(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  actorId: string,
  id: string,
  raw: unknown,
  attempt: IdempotencyAttempt,
) {
  const input = editSchema.parse(raw);
  requireKey(attempt);
  return withRequestReceipt(
    prisma,
    restaurantId,
    actorId,
    `edit-payroll:${id}`,
    input,
    attempt,
    async (tx) => {
      const row = await loadRecord(tx, restaurantId, id);
      if (row.status !== 'DRAFT')
        throw new ApiError(
          409,
          'PAYROLL_APPROVED',
          'Reopen an eligible payroll record before changing its amounts.',
        );
      const paid = row.payments.reduce((sum, payment) => sum + payment.amountPaisa, 0);
      if (input.baseSalaryPaisa + input.allowancesPaisa - input.deductionsPaisa < paid)
        throw new ApiError(
          409,
          'PAYROLL_BELOW_PAID',
          'Net salary cannot be less than advances already paid.',
        );
      await claim(tx, restaurantId, actorId, id, input.expectedVersion, {
        baseSalaryPaisa: input.baseSalaryPaisa,
        allowancesPaisa: input.allowancesPaisa,
        deductionsPaisa: input.deductionsPaisa,
        note: input.note,
      });
      await audit(tx, restaurantId, actorId, id, 'EDIT', snapshot(row), input.note);
      return recordDto(await loadRecord(tx, restaurantId, id));
    },
  );
}
export async function transitionPayroll(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  actorId: string,
  id: string,
  mode: 'APPROVE' | 'REOPEN',
  raw: unknown,
  attempt: IdempotencyAttempt,
) {
  const input = transitionSchema.parse(raw);
  requireKey(attempt);
  return withRequestReceipt(
    prisma,
    restaurantId,
    actorId,
    `${mode}-payroll:${id}`,
    input,
    attempt,
    async (tx) => {
      const row = await loadRecord(tx, restaurantId, id);
      if (
        mode === 'APPROVE'
          ? row.status !== 'DRAFT'
          : row.status !== 'APPROVED' || row.payments.some((payment) => payment.kind === 'SALARY')
      )
        throw new ApiError(
          409,
          'PAYROLL_TRANSITION_UNAVAILABLE',
          mode === 'APPROVE'
            ? 'Only draft payroll can be approved.'
            : 'Payroll can only reopen before any salary payment has been recorded.',
        );
      await claim(tx, restaurantId, actorId, id, input.expectedVersion, {
        status: mode === 'APPROVE' ? 'APPROVED' : 'DRAFT',
        approvedAt: mode === 'APPROVE' ? new Date() : null,
        approvedByStaffId: mode === 'APPROVE' ? actorId : null,
      });
      await audit(tx, restaurantId, actorId, id, mode, snapshot(row), input.note);
      return recordDto(await loadRecord(tx, restaurantId, id));
    },
  );
}
export async function payPayroll(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  actorId: string,
  id: string,
  raw: unknown,
  attempt: IdempotencyAttempt,
) {
  const input = paymentSchema.parse(raw);
  requireKey(attempt);
  return withRequestReceipt(
    prisma,
    restaurantId,
    actorId,
    `pay-payroll:${id}`,
    input,
    attempt,
    async (tx) => {
      const row = await loadRecord(tx, restaurantId, id);
      if (input.kind === 'ADVANCE' ? row.status !== 'DRAFT' : row.status !== 'APPROVED')
        throw new ApiError(
          409,
          'PAYROLL_NOT_READY',
          'Advances are recorded against a draft. Approve payroll before recording salary payments.',
        );
      const remaining = recordDto(row).remainingPaisa;
      if (input.amountPaisa > remaining)
        throw new ApiError(409, 'PAYROLL_OVERPAYMENT', 'That is more than the unpaid net salary.');
      const settings = await tx.restaurantSettings.findUniqueOrThrow({
        where: { restaurantId },
        select: { businessDayStartsAtMinutes: true, timezone: true },
      });
      const today = resolveBusinessDate(new Date(), settings.businessDayStartsAtMinutes, settings.timezone);
      if (input.drawer === 'NEW' && input.businessDate !== today)
        throw new ApiError(
          409,
          'DRAWER_DATE_MISMATCH',
          'A new drawer payout must use the current business date. Use external funds for a historical payment.',
        );
      await claim(tx, restaurantId, actorId, id, input.expectedVersion);
      const cashMovementId =
        input.drawer === 'NEW'
          ? await linkedPayOut(
              tx,
              restaurantId,
              actorId,
              input.amountPaisa,
              `Payroll ${row.month}: ${input.kind.toLowerCase()}`,
            )
          : null;
      const expense = await tx.expense.create({
        data: {
          restaurantId,
          staffId: actorId,
          amountPaisa: input.amountPaisa,
          method: input.method,
          category: 'Payroll',
          supplier: 'Staff payroll',
          note: `${row.month} ${input.kind.toLowerCase()}: ${input.note}`,
          businessDate: input.businessDate,
          cashMovementId,
        },
      });
      await tx.payrollPayment.create({
        data: {
          restaurantId,
          payrollRecordId: id,
          paidByStaffId: actorId,
          kind: input.kind,
          amountPaisa: input.amountPaisa,
          method: input.method,
          reference: input.reference || null,
          note: input.note,
          businessDate: input.businessDate,
          expenseId: expense.id,
        },
      });
      return recordDto(await loadRecord(tx, restaurantId, id));
    },
  );
}
