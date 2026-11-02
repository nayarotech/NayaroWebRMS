import { correctionReason } from '../../utils/correction';
import { withRequestReceipt, type IdempotencyAttempt } from '../../utils/idempotency';
import { z } from 'zod';
import type { NayaroPrismaClient } from '@nayaro/database';
import type {
  LoyaltyProgram,
  LoyaltyStatement,
  LoyaltySummary,
  OrderLoyaltyResponse,
} from '@nayaro/shared';
import type { Transaction } from '../../utils/idempotency';
import { ApiError } from '../../utils/apiError';
import { claimCustomer } from '../credit/credit.service';

type Client = Pick<
  NayaroPrismaClient,
  'restaurantSettings' | 'loyaltyEntry' | 'customer' | 'order'
>;
const snapshotSchema = z.object({
  customerId: z.string(),
  customerName: z.string(),
  earnEveryPaisa: z.int().min(0),
  pointsRedeemed: z.int().min(0),
  redemptionPaisa: z.int().min(0),
});
export const readLoyaltySnapshot = (raw: string | null) =>
  raw === null ? null : snapshotSchema.parse(JSON.parse(raw));
export function loyaltySummary(
  raw: string | null,
  entries: readonly { kind: string; deltaPoints: number }[] = [],
): LoyaltySummary | null {
  const snapshot = readLoyaltySnapshot(raw);
  return snapshot
    ? {
        customerName: snapshot.customerName,
        pointsRedeemed: snapshot.pointsRedeemed,
        redemptionPaisa: snapshot.redemptionPaisa,
        pointsEarned: entries
          .filter((row) => row.kind === 'EARN' || row.kind === 'EARN_ADJUSTMENT')
          .reduce((sum, row) => sum + row.deltaPoints, 0),
        pointsReturned: entries
          .filter((row) => row.kind === 'REDEEM_VOID' || row.kind === 'REDEEM_REFUND')
          .reduce((sum, row) => sum + row.deltaPoints, 0),
      }
    : null;
}
export async function getProgram(
  client: Pick<Client, 'restaurantSettings'>,
  restaurantId: string,
): Promise<LoyaltyProgram> {
  const row = await client.restaurantSettings.findUniqueOrThrow({
    where: { restaurantId },
    select: {
      loyaltyEnabled: true,
      loyaltyEarnEveryPaisa: true,
      loyaltyPointValuePaisa: true,
      loyaltyVersion: true,
    },
  });
  return {
    enabled: row.loyaltyEnabled,
    earnEveryPaisa: row.loyaltyEarnEveryPaisa,
    pointValuePaisa: row.loyaltyPointValuePaisa,
    version: row.loyaltyVersion,
  };
}
const programSchema = z.object({
  enabled: z.boolean(),
  earnEveryPaisa: z.int().min(100).max(100_000_000),
  pointValuePaisa: z.int().min(1).max(1_000_000),
  expectedVersion: z.int().min(0),
});
export async function updateProgram(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  staffId: string,
  raw: unknown,
) {
  const input = programSchema.parse(raw);
  const changed = await prisma.restaurantSettings.updateMany({
    where: { restaurantId, loyaltyVersion: input.expectedVersion },
    data: {
      loyaltyEnabled: input.enabled,
      loyaltyEarnEveryPaisa: input.earnEveryPaisa,
      loyaltyPointValuePaisa: input.pointValuePaisa,
      loyaltyVersion: { increment: 1 },
      updatedByStaffId: staffId,
    },
  });
  if (changed.count !== 1)
    throw new ApiError(
      409,
      'LOYALTY_PROGRAM_CHANGED',
      'Loyalty settings changed. Refresh before saving again.',
    );
  return getProgram(prisma, restaurantId);
}
export async function pointsBalance(
  client: Pick<Client, 'loyaltyEntry'>,
  restaurantId: string,
  customerId: string,
) {
  return (
    (
      await client.loyaltyEntry.aggregate({
        where: { restaurantId, customerId },
        _sum: { deltaPoints: true },
      })
    )._sum.deltaPoints ?? 0
  );
}
export async function getStatement(
  client: Client,
  restaurantId: string,
  customerId: string,
): Promise<LoyaltyStatement> {
  const customer = await client.customer.findFirst({
    where: { id: customerId, restaurantId },
    select: { name: true, isActive: true },
  });
  if (!customer) throw new ApiError(404, 'CUSTOMER_NOT_FOUND', 'That customer does not exist.');
  const rows = await client.loyaltyEntry.findMany({
    where: { restaurantId, customerId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: 50,
    include: { invoice: { select: { invoiceNumber: true } }, staff: { select: { name: true } } },
  });
  return {
    customerId,
    customerName: customer.name,
    isActive: customer.isActive,
    balancePoints: await pointsBalance(client, restaurantId, customerId),
    entries: rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      reason: row.reason,
      deltaPoints: row.deltaPoints,
      at: row.createdAt.toISOString(),
      invoiceNumber: row.invoice.invoiceNumber,
      staffName: row.staff.name,
    })),
  };
}
export async function getOrderLoyalty(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  orderId: string,
): Promise<OrderLoyaltyResponse> {
  return prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { id: orderId, restaurantId },
      select: {
        version: true,
        status: true,
        loyaltyCustomerId: true,
        loyaltyPointsToRedeem: true,
        discountValue: true,
      },
    });
    if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'That order does not exist.');
    const paidRewardBill =
      order.status === 'PAID'
        ? await tx.invoice.findFirst({
            where: { orderId, status: 'ACTIVE', grandTotalPaisa: 0 },
            select: {
              id: true,
              loyaltySnapshot: true,
              loyaltyEntries: { select: { kind: true, deltaPoints: true } },
            },
          })
        : null;
    const rewardSummary = paidRewardBill
      ? loyaltySummary(paidRewardBill.loyaltySnapshot, paidRewardBill.loyaltyEntries)
      : null;
    return {
      rewardOnlyInvoiceId:
        rewardSummary && rewardSummary.pointsRedeemed > rewardSummary.pointsReturned
          ? paidRewardBill!.id
          : null,
      program: await getProgram(tx, restaurantId),
      orderVersion: order.version,
      editable: order.status === 'DRAFT' || order.status === 'OPEN',
      customerId: order.loyaltyCustomerId,
      pointsToRedeem: order.loyaltyPointsToRedeem,
      redemptionPaisa: order.loyaltyPointsToRedeem > 0 ? order.discountValue : 0,
      statement: order.loyaltyCustomerId
        ? await getStatement(tx, restaurantId, order.loyaltyCustomerId)
        : null,
    };
  });
}
const selectionSchema = z
  .object({
    expectedOrderVersion: z.int().min(0),
    customerId: z.string().min(1).nullable(),
    points: z.int().min(0).max(1_000_000),
  })
  .refine(
    (value) => value.customerId !== null || value.points === 0,
    'Choose a customer before redeeming points.',
  );
export async function selectLoyalty(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  orderId: string,
  raw: unknown,
) {
  const input = selectionSchema.parse(raw);
  await prisma.$transaction(async (tx) => {
    const order = await tx.order.findFirst({
      where: { id: orderId, restaurantId },
      include: { items: { include: { cancellations: true } } },
    });
    if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'That order does not exist.');
    if (
      !['DRAFT', 'OPEN'].includes(order.status) ||
      (await tx.invoice.count({ where: { orderId, status: 'ACTIVE' } }))
    )
      throw new ApiError(409, 'ORDER_ALREADY_BILLED', 'Choose loyalty before issuing the bill.');
    const program = await getProgram(tx, restaurantId);
    if (input.customerId) {
      if (!program.enabled)
        throw new ApiError(409, 'LOYALTY_DISABLED', 'The loyalty program is disabled.');
      const customer = await tx.customer.findFirst({
        where: { id: input.customerId, restaurantId, isActive: true },
      });
      if (!customer)
        throw new ApiError(
          404,
          'CUSTOMER_NOT_FOUND',
          'Choose an active customer from this restaurant.',
        );
      if (
        input.points > 0 &&
        input.points > (await pointsBalance(tx, restaurantId, input.customerId))
      )
        throw new ApiError(
          409,
          'INSUFFICIENT_POINTS',
          'This customer does not have enough points.',
        );
    }
    if (input.points > 0 && order.loyaltyPointsToRedeem === 0 && order.discountType !== 'NONE')
      throw new ApiError(
        409,
        'MANUAL_DISCOUNT_PRESENT',
        'Clear the manual bill discount before redeeming loyalty points.',
      );
    const value = input.points * program.pointValuePaisa;
    const subtotal = order.items.reduce(
      (sum, item) =>
        sum +
        Math.max(
          0,
          item.quantity - item.cancellations.reduce((count, row) => count + row.quantity, 0),
        ) *
          item.unitPricePaisa,
      0,
    );
    if (!Number.isSafeInteger(value) || value > subtotal)
      throw new ApiError(
        409,
        'REWARD_EXCEEDS_BILL',
        'The reward cannot exceed the bill’s item subtotal. Choose fewer points.',
      );
    const clear = input.points === 0 && order.loyaltyPointsToRedeem > 0;
    const changed = await tx.order.updateMany({
      where: { id: orderId, restaurantId, version: input.expectedOrderVersion },
      data: {
        loyaltyCustomerId: input.customerId,
        loyaltyPointsToRedeem: input.points,
        loyaltyPointValuePaisa: input.points > 0 ? program.pointValuePaisa : 0,
        ...(input.points > 0
          ? { discountType: 'FIXED', discountValue: value, discountApprovedByStaffId: null }
          : clear
            ? { discountType: 'NONE', discountValue: 0, discountApprovedByStaffId: null }
            : {}),
        version: { increment: 1 },
      },
    });
    if (changed.count !== 1)
      throw new ApiError(
        409,
        'ORDER_CHANGED',
        'This bill changed. Refresh before choosing loyalty again.',
      );
  });
  return getOrderLoyalty(prisma, restaurantId, orderId);
}
/** Called before allocating an invoice number. Selection is a quote, not a reservation. */
export async function prepareLoyalty(
  tx: Transaction,
  restaurantId: string,
  orderId: string,
  subtotalPaisa: number,
): Promise<string | null> {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: {
      loyaltyCustomerId: true,
      loyaltyPointsToRedeem: true,
      loyaltyPointValuePaisa: true,
      discountType: true,
      discountValue: true,
    },
  });
  if (!order.loyaltyCustomerId) return null;
  const program = await getProgram(tx, restaurantId);
  const customer = await tx.customer.findFirst({
    where: { id: order.loyaltyCustomerId, restaurantId, isActive: true },
  });
  if (!customer)
    throw new ApiError(
      409,
      'CUSTOMER_INACTIVE',
      'Clear or change the inactive loyalty customer before issuing the bill.',
    );
  if (order.loyaltyPointsToRedeem > 0) {
    const value = order.loyaltyPointsToRedeem * order.loyaltyPointValuePaisa;
    if (!program.enabled)
      throw new ApiError(
        409,
        'LOYALTY_DISABLED',
        'Clear the reward before issuing a bill while loyalty is disabled.',
      );
    if (order.discountType !== 'FIXED' || order.discountValue !== value || value > subtotalPaisa)
      throw new ApiError(
        409,
        'REWARD_EXCEEDS_BILL',
        'Update the loyalty reward to fit the current bill before issuing it.',
      );
    await claimCustomer(tx, restaurantId, customer.id, undefined, true);
    if (order.loyaltyPointsToRedeem > (await pointsBalance(tx, restaurantId, customer.id)))
      throw new ApiError(
        409,
        'INSUFFICIENT_POINTS',
        'Points were used on another bill. Choose fewer points before issuing this one.',
      );
  }
  return JSON.stringify({
    customerId: customer.id,
    customerName: customer.name,
    earnEveryPaisa: program.enabled ? program.earnEveryPaisa : 0,
    pointsRedeemed: order.loyaltyPointsToRedeem,
    redemptionPaisa: order.loyaltyPointsToRedeem > 0 ? order.discountValue : 0,
  });
}
export async function recordRedemption(
  tx: Transaction,
  restaurantId: string,
  staffId: string,
  invoiceId: string,
  raw: string | null,
) {
  const snapshot = readLoyaltySnapshot(raw);
  if (!snapshot || snapshot.pointsRedeemed === 0) return;
  await tx.loyaltyEntry.create({
    data: {
      restaurantId,
      customerId: snapshot.customerId,
      staffId,
      invoiceId,
      key: `redeem:${invoiceId}`,
      kind: 'REDEEM',
      deltaPoints: -snapshot.pointsRedeemed,
    },
  });
}
export async function reverseRedemption(
  tx: Transaction,
  restaurantId: string,
  staffId: string,
  invoiceId: string,
) {
  const invoice = await tx.invoice.findUniqueOrThrow({
    where: { id: invoiceId },
    select: { loyaltySnapshot: true },
  });
  const snapshot = readLoyaltySnapshot(invoice.loyaltySnapshot);
  if (!snapshot || snapshot.pointsRedeemed === 0) return;
  await claimCustomer(tx, restaurantId, snapshot.customerId);
  await tx.loyaltyEntry.create({
    data: {
      restaurantId,
      customerId: snapshot.customerId,
      staffId,
      invoiceId,
      key: `redeem-void:${invoiceId}`,
      kind: 'REDEEM_VOID',
      deltaPoints: snapshot.pointsRedeemed,
    },
  });
}
/** Reconcile cumulative refunds, so rounding never depends on how a refund was split. */
export async function syncLoyalty(
  tx: Transaction,
  restaurantId: string,
  staffId: string,
  invoiceId: string,
  event: string,
) {
  const invoice = await tx.invoice.findFirstOrThrow({
    where: { id: invoiceId, restaurantId },
    select: {
      loyaltySnapshot: true,
      grandTotalPaisa: true,
      status: true,
      order: { select: { status: true } },
      loyaltyEntries: { select: { kind: true, deltaPoints: true } },
      payments: {
        where: { voidedAt: null },
        select: { method: true, amountPaisa: true, refunds: { select: { amountPaisa: true } } },
      },
    },
  });
  const snapshot = readLoyaltySnapshot(invoice.loyaltySnapshot);
  if (!snapshot || invoice.status !== 'ACTIVE' || invoice.order.status !== 'PAID') return;
  const paid = invoice.payments
    .filter((row) => row.method !== 'CREDIT')
    .reduce(
      (sum, row) =>
        sum +
        row.amountPaisa -
        row.refunds.reduce((total, refund) => total + refund.amountPaisa, 0),
      0,
    );
  const refunded = invoice.payments.reduce(
    (sum, row) => sum + row.refunds.reduce((total, refund) => total + refund.amountPaisa, 0),
    0,
  );
  const summary = loyaltySummary(invoice.loyaltySnapshot, invoice.loyaltyEntries)!;
  const earned =
    snapshot.earnEveryPaisa > 0 ? Math.floor(Math.max(0, paid) / snapshot.earnEveryPaisa) : 0;
  const returned =
    invoice.grandTotalPaisa > 0
      ? Number(
          (BigInt(snapshot.pointsRedeemed) * BigInt(Math.min(refunded, invoice.grandTotalPaisa))) /
            BigInt(invoice.grandTotalPaisa),
        )
      : 0;
  const earnDelta = earned - summary.pointsEarned,
    returnDelta = returned - summary.pointsReturned;
  if (earnDelta === 0 && returnDelta === 0) return;
  await claimCustomer(tx, restaurantId, snapshot.customerId);
  for (const [kind, deltaPoints] of [
    [earnDelta > 0 ? 'EARN' : 'EARN_ADJUSTMENT', earnDelta],
    ['REDEEM_REFUND', returnDelta],
  ] as const) {
    if (deltaPoints === 0) continue;
    if (!Number.isSafeInteger(deltaPoints) || Math.abs(deltaPoints) > 2_000_000_000)
      throw new ApiError(409, 'LOYALTY_AMOUNT_TOO_LARGE', 'This loyalty amount is too large.');
    await tx.loyaltyEntry.create({
      data: {
        restaurantId,
        customerId: snapshot.customerId,
        staffId,
        invoiceId,
        key: `${kind}:${invoiceId}:${event}`,
        kind,
        deltaPoints,
      },
    });
  }
}

/** Reward-only bills have no monetary payment to refund. This returns points without inventing money. */
export async function returnRewardOnly(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  staffId: string,
  invoiceId: string,
  raw: unknown,
  attempt: IdempotencyAttempt,
) {
  const input = z
    .object({ expectedOrderVersion: z.int().min(0), reason: correctionReason })
    .parse(raw);
  if (!attempt.key)
    throw new ApiError(
      400,
      'REQUEST_KEY_REQUIRED',
      'Refresh and try again with a request identifier.',
    );
  return withRequestReceipt(
    prisma,
    restaurantId,
    staffId,
    `return-reward-only:${invoiceId}`,
    input,
    attempt,
    async (tx) => {
      const invoice = await tx.invoice.findFirst({
        where: { id: invoiceId, restaurantId },
        include: { order: true, loyaltyEntries: true },
      });
      if (!invoice) throw new ApiError(404, 'INVOICE_NOT_FOUND', 'That bill does not exist.');
      const snapshot = readLoyaltySnapshot(invoice.loyaltySnapshot);
      const summary = loyaltySummary(invoice.loyaltySnapshot, invoice.loyaltyEntries);
      if (
        invoice.status !== 'ACTIVE' ||
        invoice.order.status !== 'PAID' ||
        invoice.grandTotalPaisa !== 0 ||
        !snapshot ||
        snapshot.pointsRedeemed === 0 ||
        !summary ||
        summary.pointsReturned > 0
      )
        throw new ApiError(
          409,
          'REWARD_RETURN_UNAVAILABLE',
          'Only a settled reward-only bill with unreturned points can use this correction. Refund paid bills through their payments.',
        );
      const claimed = await tx.order.updateMany({
        where: { id: invoice.orderId, restaurantId, version: input.expectedOrderVersion },
        data: { version: { increment: 1 } },
      });
      if (claimed.count !== 1)
        throw new ApiError(
          409,
          'ORDER_CHANGED',
          'The bill changed. Refresh before returning points.',
        );
      await claimCustomer(tx, restaurantId, snapshot.customerId);
      await tx.loyaltyEntry.create({
        data: {
          restaurantId,
          customerId: snapshot.customerId,
          invoiceId,
          staffId,
          key: `REDEEM_REFUND:${invoiceId}:reward-only`,
          kind: 'REDEEM_REFUND',
          deltaPoints: snapshot.pointsRedeemed,
          reason: input.reason,
        },
      });
      return getStatement(tx, restaurantId, snapshot.customerId);
    },
  );
}
