import type { NayaroPrismaClient } from '@nayaro/database';

/** Operator-only reset for demo/test data. Never exposed through the tenant API. */
export async function resetTenantData(
  prisma: NayaroPrismaClient,
  workspace: string,
  backupPath: string,
): Promise<void> {
  const restaurant = await prisma.restaurant.findUniqueOrThrow({
    where: { slug: workspace },
    select: { id: true },
  });

  // SQLite produces a consistent, standalone snapshot, including committed WAL data.
  // Failure to create the backup aborts before any restaurant data is changed.
  await prisma.$executeRaw`VACUUM INTO ${backupPath}`;

  await prisma.$transaction(
    async (tx) => {
      const restaurantId = restaurant.id;
      const where = { restaurantId };

      // Children without restaurantId are scoped through their owning parent.
      // Keep foreign keys enabled and remove dependants before their parents.
      await tx.paymentItemAllocation.deleteMany({ where: { payment: where } });
      await tx.paymentRefund.deleteMany({ where });
      await tx.loyaltyEntry.deleteMany({ where });
      await tx.creditRepayment.deleteMany({ where });
      await tx.payment.deleteMany({ where });
      await tx.invoicePrint.deleteMany({ where: { invoice: where } });
      await tx.invoiceLine.deleteMany({ where: { invoice: where } });
      await tx.invoice.deleteMany({ where });
      await tx.stockMovement.deleteMany({ where });
      await tx.kotItem.deleteMany({ where: { kot: where } });
      await tx.kot.deleteMany({ where });
      await tx.orderItemCancellation.deleteMany({ where: { orderItem: { order: where } } });
      await tx.orderItem.deleteMany({ where: { order: where } });
      await tx.orderTableTransfer.deleteMany({ where });
      await tx.order.deleteMany({ where });
      await tx.payrollAudit.deleteMany({ where });
      await tx.payrollPayment.deleteMany({ where });
      await tx.payrollRecord.deleteMany({ where });
      await tx.expense.deleteMany({ where });
      await tx.cashMovement.deleteMany({ where });
      await tx.shift.deleteMany({ where });
      await tx.customer.deleteMany({ where });
      await tx.requestReceipt.deleteMany({ where });
      await tx.restaurantCounter.deleteMany({ where });
      await tx.restaurantCounter.createMany({
        data: [
          { restaurantId, name: 'ORDER', nextValue: 1 },
          { restaurantId, name: 'KOT', nextValue: 1 },
        ],
      });
      // Stock balances must agree with the now-empty stock ledger.
      await tx.ingredient.updateMany({
        where,
        data: { onHandMilli: 0, version: { increment: 1 } },
      });
      // Force terminals to sign in again rather than reuse stale orders or retries.
      await tx.session.deleteMany({ where });
      await tx.auditLog.create({
        data: {
          restaurantId,
          action: 'TENANT_DATA_RESET',
          entityType: 'Restaurant',
          entityId: restaurantId,
          summary: 'Transaction history and customers cleared by platform operator.',
          metadata: JSON.stringify({ backupPath }),
        },
      });
    },
    { timeout: 60_000 },
  );
}
