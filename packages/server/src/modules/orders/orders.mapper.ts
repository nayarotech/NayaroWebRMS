import { promotionSummary } from '../offers/offers.service';
import { readComboSnapshot } from '../menu/combos';
import type { OrderDto, OrderItemDto } from '@nayaro/shared';
import type { OrderRow } from './orders.types';

/**
 * The columns every order read selects. Kept in one place so `getOrder`, the
 * mutations and the race-recovery path cannot drift into returning different
 * shapes for the same thing.
 */
export const ORDER_SELECT = {
  id: true,
  orderNumber: true,
  status: true,
  type: true,
  version: true,
  _count: { select: { invoices: true } },
  table: { select: { id: true, name: true } },
  tableTransfers: {
    select: {
      id: true,
      fromTableId: true,
      toTableId: true,
      fromTableName: true,
      toTableName: true,
      createdAt: true,
      staff: { select: { id: true, name: true } },
    },
  },
  /*
   * Every ticket for this order, so the POS can say "1 preparing, 1 ready"
   * without shipping KOT history to the renderer to reconstruct. One extra
   * relation on a query we were already running.
   *
   * VOID tickets are INCLUDED here, unlike everywhere else. The live counts
   * filter them out in the mapper, but the panel lists them: a manager who
   * voided a dispatch needs to see that it happened and was undone. The
   * kitchen board is the place that must never show them.
   */
  kots: {
    select: {
      id: true,
      kotNumber: true,
      status: true,
      createdAt: true,
      voidedAt: true,
      voidReason: true,
      voidedByStaff: { select: { id: true, name: true } },
      items: { select: { quantity: true, orderItem: { select: { nameSnapshot: true } } } },
    },
  },
  items: {
    select: {
      id: true,
      menuItemId: true,
      comboSnapshot: true,
      promotionSnapshot: true,
      nameSnapshot: true,
      nameNpSnapshot: true,
      quantity: true,
      unitPricePaisa: true,
      note: true,
      // Selected only to order by. Never sent to the client.
      createdAt: true,
      /*
       * Customer cancellations against this line. Separate from dispatch:
       * these reduce what is billed and never touch what the kitchen was told.
       */
      cancellations: {
        select: {
          id: true,
          quantity: true,
          reason: true,
          cancelledAt: true,
          cancelledByStaff: { select: { id: true, name: true } },
        },
      },
      /*
       * The dispatch history of this line, fetched with the order rather than
       * in a follow-up query. VOID tickets are excluded here rather than
       * subtracted later: a voided ticket means "this batch never happened",
       * so its quantities return to undispatched and it must not appear in the
       * sum at all.
       */
      kotItems: {
        where: { kot: { status: { not: 'VOID' } } },
        select: { quantity: true },
      },
    },
  },
} as const;

/**
 * Prisma row -> wire DTO.
 *
 * `lineTotalPaisa` and `subtotalPaisa` are computed here rather than stored.
 * A stored total is a second copy of a fact that can disagree with the rows it
 * summarises, and reconciling the two is a bug hunt nobody wants during
 * service. Integer paisa throughout, so the arithmetic is exact - float money
 * is how a bill ends up one paisa short of itself.
 *
 * Note what does not cross the wire: restaurantId, createdAt, openedByStaffId,
 * discount working fields. The POS needs none of them, and shipping them
 * invites the client to start depending on internal columns.
 */
export function toOrderDto(order: OrderRow): OrderDto {
  // Oldest first, so the panel reads in the order the cashier built it and a
  // line never jumps position when its quantity changes. Sorted here rather
  // than in the query because `orderBy` inside a shared `as const` select
  // becomes a readonly tuple that Prisma's input types reject - and ordering
  // for display is presentation anyway.
  const items: OrderItemDto[] = [...order.items]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
    .map((item) => {
      const dispatchedQuantity = item.kotItems.reduce((total, kot) => total + kot.quantity, 0);
      const cancelledQuantity = item.cancellations.reduce(
        (total, cancellation) => total + cancellation.quantity,
        0,
      );
      // Cancellation is a BILLING fact, so it comes off the billable count and
      // out of the line total - and nowhere else. `quantity` still says what
      // was ordered and `dispatchedQuantity` what the kitchen was told, both
      // of which remain true after a customer changes their mind.
      const billableQuantity = Math.max(0, item.quantity - cancelledQuantity);
      return {
        id: item.id,
        menuItemId: item.menuItemId,
        promotion: promotionSummary(item.promotionSnapshot),
        components: readComboSnapshot(item.comboSnapshot).map(({ name, quantity }) => ({
          name,
          quantity,
        })),
        name: item.nameSnapshot,
        nameNp: item.nameNpSnapshot,
        quantity: item.quantity,
        unitPricePaisa: item.unitPricePaisa,
        note: item.note,
        lineTotalPaisa: billableQuantity * item.unitPricePaisa,
        dispatchedQuantity,
        // Clamped at zero: the guards keep quantity >= dispatched, but a
        // negative "to send" on a POS screen would be nonsense to look at even
        // if some future path made it arithmetically possible.
        undispatchedQuantity: Math.max(0, item.quantity - dispatchedQuantity),
        cancelledQuantity,
        billableQuantity,
        cancellations: [...item.cancellations]
          .sort((a, b) => a.cancelledAt.getTime() - b.cancelledAt.getTime())
          .map((cancellation) => ({
            id: cancellation.id,
            quantity: cancellation.quantity,
            reason: cancellation.reason,
            cancelledAt: cancellation.cancelledAt.toISOString(),
            cancelledBy: {
              id: cancellation.cancelledByStaff.id,
              name: cancellation.cancelledByStaff.name,
            },
          })),
      };
    });

  // Live work only. A voided ticket is not something the kitchen is doing, so
  // it must not appear in any of these five numbers.
  const live = order.kots.filter((kot) => kot.status !== 'VOID');
  const kitchen = {
    ticketCount: live.length,
    newCount: live.filter((kot) => kot.status === 'NEW').length,
    preparingCount: live.filter((kot) => kot.status === 'PREPARING').length,
    readyCount: live.filter((kot) => kot.status === 'READY').length,
    servedCount: live.filter((kot) => kot.status === 'SERVED').length,
  };

  const tickets = [...order.kots]
    .sort((a, b) => a.kotNumber - b.kotNumber)
    .map((kot) => ({
      id: kot.id,
      kotNumber: kot.kotNumber,
      status: kot.status,
      createdAt: kot.createdAt.toISOString(),
      items: kot.items.map((line) => ({
        name: line.orderItem.nameSnapshot,
        quantity: line.quantity,
      })),
      voidedAt: kot.voidedAt?.toISOString() ?? null,
      voidReason: kot.voidReason,
      voidedBy:
        kot.voidedByStaff === null
          ? null
          : { id: kot.voidedByStaff.id, name: kot.voidedByStaff.name },
    }));

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    type: order.type,
    table: order.table === null ? null : { id: order.table.id, name: order.table.name },
    version: order.version,
    items,
    subtotalPaisa: items.reduce((total, item) => total + item.lineTotalPaisa, 0),
    kitchen,
    tickets,
    canTransferTable:
      order.type === 'DINE_IN' &&
      order.table !== null &&
      (order.status === 'DRAFT' || order.status === 'OPEN') &&
      order._count.invoices === 0,
    tableTransfers: [...order.tableTransfers]
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
      .map((row) => ({
        id: row.id,
        from: { id: row.fromTableId, name: row.fromTableName },
        to: { id: row.toTableId, name: row.toTableName },
        at: row.createdAt.toISOString(),
        staff: row.staff,
      })),
  };
}
