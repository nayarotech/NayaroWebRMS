import { z } from 'zod';
import type { NayaroPrismaClient } from '@nayaro/database';
import type { CashMovementType, PaymentMethod, ShiftDto } from '@nayaro/shared';
import { ApiError } from '../../utils/apiError';
import { resolveBusinessDate } from '../../utils/businessDate';
import { correctionReason } from '../../utils/correction';
import type { Transaction } from '../../utils/idempotency';

/**
 * The cash drawer: open with a float, pay in and out, close with a count.
 *
 * WHAT THIS IS FOR. A till's oldest job is answering "is the right amount of
 * cash in the drawer?" at the end of the night. That needs three numbers: what
 * the drawer started with, what should have come in and out since, and what
 * a person actually counted. The difference - the variance - is recorded with
 * the name of whoever counted, and nothing afterwards can change it.
 *
 * A TIME WINDOW, NOT A LINK. Cash payments belong to the shift that was open
 * when they were taken. Payment rows carry no shift id, so recording a payment
 * never depends on a drawer being open - a restaurant that never uses this
 * screen bills exactly as before. Cash taken while no drawer is open simply
 * belongs to no shift, and the end-of-day report shows it as such.
 *
 * ONE DRAWER. A partial unique index allows one open shift per restaurant,
 * which matches the hardware: one till, one cash box.
 */

const paisa = z.int().min(0).max(1_000_000_000);

export const openShiftSchema = z.object({ openingFloatPaisa: paisa });

export const cashMovementSchema = z.object({
  type: z.enum(['PAY_IN', 'PAY_OUT']),
  amountPaisa: paisa.min(1, 'Enter an amount.'),
  // Same rule as a correction: the reason is the only record of why money
  // left the drawer, so a space bar must not satisfy it.
  reason: correctionReason,
});

export const closeShiftSchema = z.object({
  countedCashPaisa: paisa,
  note: z.string().trim().max(300).optional(),
});

const SHIFT_SELECT = {
  id: true,
  businessDate: true,
  openedAt: true,
  openedByStaff: { select: { id: true, name: true } },
  openingFloatPaisa: true,
  closedAt: true,
  closedByStaff: { select: { id: true, name: true } },
  expectedCashPaisa: true,
  countedCashPaisa: true,
  closeNote: true,
  movements: {
    // A plain array: `as const` below would make it a readonly tuple, which
    // Prisma's orderBy type does not accept.
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }] as {
      createdAt?: 'asc';
      id?: 'asc';
    }[],
    select: {
      id: true,
      type: true,
      amountPaisa: true,
      reason: true,
      createdAt: true,
      staff: { select: { id: true, name: true } },
    },
  },
} as const;

type Client = Pick<NayaroPrismaClient, 'shift' | 'payment' | 'creditRepayment'>;
type ShiftRow = NonNullable<Awaited<ReturnType<typeof findShift>>>;

function findShift(prisma: Client, where: { restaurantId: string; id?: string; closedAt?: null }) {
  return prisma.shift.findFirst({ where, select: SHIFT_SELECT });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export async function getCurrentShift(
  prisma: NayaroPrismaClient,
  restaurantId: string,
): Promise<ShiftDto | null> {
  const row = await findShift(prisma, { restaurantId, closedAt: null });
  return row === null ? null : toShiftDto(prisma, restaurantId, row);
}

/** Every drawer opened on a business day, oldest first. Used by the daily report. */
export async function listShiftsForDay(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  businessDate: string,
): Promise<ShiftDto[]> {
  const rows = await prisma.shift.findMany({
    where: { restaurantId, businessDate },
    orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
    select: SHIFT_SELECT,
  });
  return Promise.all(rows.map((row) => toShiftDto(prisma, restaurantId, row)));
}

/**
 * Live payments taken inside the shift's window, by method. Voided payments are
 * excluded: a reversed cash payment was handed back, so it is not in the drawer.
 */
async function takingsInWindow(
  prisma: Client,
  restaurantId: string,
  from: Date,
  to: Date,
): Promise<{ method: PaymentMethod; count: number; amountPaisa: number }[]> {
  const groups = await prisma.payment.groupBy({
    by: ['method'],
    where: { restaurantId, voidedAt: null, createdAt: { gte: from, lte: to } },
    _sum: { amountPaisa: true },
    _count: { _all: true },
  });
  return groups.map((g) => ({
    method: g.method,
    count: g._count._all,
    amountPaisa: g._sum.amountPaisa ?? 0,
  }));
}

interface CashPosition {
  readonly takings: { method: PaymentMethod; count: number; amountPaisa: number }[];
  readonly cashSalesPaisa: number;
  readonly cashCreditCollectionsPaisa: number;
  readonly payInsPaisa: number;
  readonly payOutsPaisa: number;
  readonly expectedCashPaisa: number;
}

/** The one place the drawer arithmetic lives. */
async function cashPosition(
  prisma: Client,
  restaurantId: string,
  row: Pick<ShiftRow, 'openedAt' | 'openingFloatPaisa' | 'movements'>,
  until: Date,
): Promise<CashPosition> {
  const [takings, collected, reversed] = await Promise.all([
    takingsInWindow(prisma, restaurantId, row.openedAt, until),
    prisma.creditRepayment.aggregate({
      where: { restaurantId, method: 'CASH', createdAt: { gte: row.openedAt, lte: until } },
      _sum: { amountPaisa: true },
    }),
    prisma.creditRepayment.aggregate({
      where: { restaurantId, method: 'CASH', reversedAt: { gte: row.openedAt, lte: until } },
      _sum: { amountPaisa: true },
    }),
  ]);
  const cashCreditCollectionsPaisa =
    (collected._sum.amountPaisa ?? 0) - (reversed._sum.amountPaisa ?? 0);
  const cashSalesPaisa = takings.find((t) => t.method === 'CASH')?.amountPaisa ?? 0;
  const sumOf = (type: CashMovementType): number =>
    row.movements.filter((m) => m.type === type).reduce((s, m) => s + m.amountPaisa, 0);
  const payInsPaisa = sumOf('PAY_IN');
  const payOutsPaisa = sumOf('PAY_OUT');
  return {
    takings,
    cashSalesPaisa,
    cashCreditCollectionsPaisa,
    payInsPaisa,
    payOutsPaisa,
    expectedCashPaisa:
      row.openingFloatPaisa +
      cashSalesPaisa +
      cashCreditCollectionsPaisa +
      payInsPaisa -
      payOutsPaisa,
  };
}

async function toShiftDto(prisma: Client, restaurantId: string, row: ShiftRow): Promise<ShiftDto> {
  const position = await cashPosition(prisma, restaurantId, row, row.closedAt ?? new Date());
  const closed =
    row.closedAt !== null &&
    row.closedByStaff !== null &&
    row.expectedCashPaisa !== null &&
    row.countedCashPaisa !== null;

  return {
    id: row.id,
    businessDate: row.businessDate,
    status: closed ? 'CLOSED' : 'OPEN',
    openedAt: row.openedAt.toISOString(),
    openedBy: row.openedByStaff,
    openingFloatPaisa: row.openingFloatPaisa,
    takings: position.takings,
    cashSalesPaisa: position.cashSalesPaisa,
    cashCreditCollectionsPaisa: position.cashCreditCollectionsPaisa,
    payInsPaisa: position.payInsPaisa,
    payOutsPaisa: position.payOutsPaisa,
    // Frozen once closed. See the schema comment on Shift.
    expectedCashPaisa: closed ? row.expectedCashPaisa! : position.expectedCashPaisa,
    movements: row.movements.map((m) => ({
      id: m.id,
      type: m.type,
      amountPaisa: m.amountPaisa,
      reason: m.reason,
      createdAt: m.createdAt.toISOString(),
      staff: m.staff,
    })),
    close: closed
      ? {
          closedAt: row.closedAt!.toISOString(),
          closedBy: row.closedByStaff!,
          expectedCashPaisa: row.expectedCashPaisa!,
          countedCashPaisa: row.countedCashPaisa!,
          variancePaisa: row.countedCashPaisa! - row.expectedCashPaisa!,
          note: row.closeNote,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

export async function openShift(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  staffId: string,
  rawInput: unknown,
): Promise<ShiftDto> {
  const input = openShiftSchema.parse(rawInput);

  const settings = await prisma.restaurantSettings.findFirst({
    where: { restaurantId },
    select: { businessDayStartsAtMinutes: true, timezone: true },
  });

  let id: string;
  try {
    // The unique index decides a race; this read only gives the common case
    // a clear message without relying on the error shape.
    if ((await prisma.shift.count({ where: { restaurantId, closedAt: null } })) > 0) {
      throw alreadyOpen();
    }
    const created = await prisma.shift.create({
      data: {
        restaurantId,
        businessDate: resolveBusinessDate(new Date(), settings?.businessDayStartsAtMinutes ?? 240, settings?.timezone),
        openedByStaffId: staffId,
        openingFloatPaisa: input.openingFloatPaisa,
      },
      select: { id: true },
    });
    id = created.id;
  } catch (error: unknown) {
    if (isOpenShiftIndexViolation(error)) throw alreadyOpen();
    throw error;
  }

  const row = await findShift(prisma, { restaurantId, id });
  return toShiftDto(prisma, restaurantId, row!);
}

function alreadyOpen(): ApiError {
  return new ApiError(
    409,
    'SHIFT_ALREADY_OPEN',
    'The drawer is already open. Close the current shift before opening another.',
  );
}

/** Same reasoning as the order module: trust neither error shape alone. */
function isOpenShiftIndexViolation(error: unknown): boolean {
  if (error instanceof ApiError) return false;
  if ((error as { code?: unknown }).code === 'P2002') return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('uq_shift_open_per_restaurant') ||
    (message.includes('UNIQUE constraint failed') && message.includes('Shift'))
  );
}

// ---------------------------------------------------------------------------
// Pay in / pay out
// ---------------------------------------------------------------------------

export async function recordMovement(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  staffId: string,
  shiftId: string,
  rawInput: unknown,
): Promise<ShiftDto> {
  const input = cashMovementSchema.parse(rawInput);

  await prisma.$transaction(async (tx) => {
    const row = await findShift(tx, { restaurantId, id: shiftId });
    if (row === null) throw notFound();
    if (row.closedAt !== null) throw alreadyClosed();

    // Cash cannot leave a drawer that does not hold it. This is the one
    // pay-out that is certainly a typo - an extra zero - so it is refused
    // rather than recorded as a shortage nobody can explain.
    if (input.type === 'PAY_OUT') {
      const { expectedCashPaisa } = await cashPosition(tx, restaurantId, row, new Date());
      if (input.amountPaisa > expectedCashPaisa) {
        throw new ApiError(
          409,
          'NOT_ENOUGH_CASH',
          'That is more cash than the drawer should hold. Check the amount.',
        );
      }
    }

    await tx.cashMovement.create({
      data: {
        restaurantId,
        shiftId,
        type: input.type,
        amountPaisa: input.amountPaisa,
        reason: input.reason,
        staffId,
      },
    });
  });

  const row = await findShift(prisma, { restaurantId, id: shiftId });
  return toShiftDto(prisma, restaurantId, row!);
}

// ---------------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------------

/**
 * Counts the drawer and closes the shift. The expected figure is computed at
 * this instant and stored next to the count, so the variance is a fact about
 * this moment and stays that way.
 */
export async function closeShift(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  staffId: string,
  shiftId: string,
  rawInput: unknown,
): Promise<ShiftDto> {
  const input = closeShiftSchema.parse(rawInput);

  await prisma.$transaction(async (tx) => {
    const row = await findShift(tx, { restaurantId, id: shiftId });
    if (row === null) throw notFound();
    if (row.closedAt !== null) throw alreadyClosed();

    const closedAt = new Date();
    const { expectedCashPaisa } = await cashPosition(tx, restaurantId, row, closedAt);
    const note = input.note === undefined || input.note.length === 0 ? null : input.note;

    // Conditional on still being open: two people closing at once get one
    // close and one refusal, not a second count overwriting the first.
    const closed = await tx.shift.updateMany({
      where: { id: shiftId, restaurantId, closedAt: null },
      data: {
        closedAt,
        closedByStaffId: staffId,
        expectedCashPaisa,
        countedCashPaisa: input.countedCashPaisa,
        closeNote: note,
      },
    });
    if (closed.count === 0) throw alreadyClosed();
  });

  const row = await findShift(prisma, { restaurantId, id: shiftId });
  return toShiftDto(prisma, restaurantId, row!);
}

function notFound(): ApiError {
  return new ApiError(404, 'SHIFT_NOT_FOUND', 'That shift does not exist.');
}

function alreadyClosed(): ApiError {
  return new ApiError(409, 'SHIFT_CLOSED', 'This shift has already been closed.');
}

/** Atomically links a business record to its actual drawer payout. */
export async function linkedPayOut(
  tx: Transaction,
  restaurantId: string,
  staffId: string,
  amountPaisa: number,
  reason: string,
): Promise<string> {
  const row = await findShift(tx, { restaurantId, closedAt: null });
  if (!row)
    throw new ApiError(409, 'DRAWER_REQUIRED', 'Open the cash drawer before paying from it.');
  const claimed = await tx.shift.updateMany({
    where: { id: row.id, restaurantId, closedAt: null },
    data: { openingFloatPaisa: { increment: 0 } },
  });
  if (claimed.count !== 1) throw alreadyClosed();
  const position = await cashPosition(tx, restaurantId, row, new Date());
  if (amountPaisa > position.expectedCashPaisa)
    throw new ApiError(
      409,
      'NOT_ENOUGH_CASH',
      'The drawer does not hold enough cash for this payout.',
    );
  return (
    await tx.cashMovement.create({
      data: { restaurantId, shiftId: row.id, staffId, type: 'PAY_OUT', amountPaisa, reason },
    })
  ).id;
}
