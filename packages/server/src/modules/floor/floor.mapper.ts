import type { FloorArea, FloorTable, TableStatus } from '@nayaro/shared';
import type { ActiveOrderSnapshot, AreaRow } from './floor.types';

/**
 * DERIVED TABLE STATUS - the precedence rule, and why it is this order.
 *
 * A table's status is not a fact about the table; it is the answer to "what
 * should someone do about this table next?". So precedence follows the COST OF
 * NOT ACTING, highest first:
 *
 *   AWAITING_PAYMENT  money is owed and the customer is ready to leave.
 *                     Failing to act loses the money outright - the only
 *                     unrecoverable outcome on this list.
 *   READY             food is plated and going cold. Recoverable, but on a
 *                     clock, so it outranks everything below it.
 *   PREPARING         the kitchen has it. Nobody on the floor need do anything;
 *                     this is information, not a task.
 *   OCCUPIED          seated, nothing pending.
 *   AVAILABLE         seat someone.
 *
 * The one genuinely arguable case is READY *underneath* an active invoice: a
 * ticket could still be sitting in the pass when the bill is printed. We let
 * AWAITING_PAYMENT win, because once a bill exists service is over and the
 * table-level action is to settle it. Food stranded in the pass at that point
 * is an anomaly, and the kitchen board - which shows tickets, not tables - is
 * where it belongs. A floor plan that shows READY for a table whose customer
 * is standing at the till with a bill would be pointing at the wrong job.
 *
 * BILLED and "has an ACTIVE invoice" are checked together on purpose. They are
 * supposed to be equivalent (Phase 3 invariant 12), and checking both means a
 * disagreement between them degrades to "collect the money" rather than to
 * silently showing the wrong thing.
 */
export function deriveTableStatus(order: ActiveOrderSnapshot | undefined): TableStatus {
  if (!order) return 'AVAILABLE';

  if (order.status === 'BILLED' || order.hasActiveInvoice) return 'AWAITING_PAYMENT';
  if (order.kotStatuses.includes('READY')) return 'READY';
  if (order.kotStatuses.some((status) => status === 'NEW' || status === 'PREPARING')) {
    return 'PREPARING';
  }
  return 'OCCUPIED';
}

/**
 * Prisma rows -> the wire shape.
 *
 * A deliberate DTO rather than the Prisma object: `createdAt`, `updatedAt` and
 * `restaurantId` are of no use to the renderer, and shipping them invites the
 * client to start depending on internal columns.
 */
export function toFloorAreas(
  areas: readonly AreaRow[],
  activeOrdersByTableId: ReadonlyMap<string, ActiveOrderSnapshot>,
): FloorArea[] {
  return areas.map((area) => ({
    id: area.id,
    name: area.name,
    sortOrder: area.sortOrder,
    isActive: area.isActive,
    tables: area.tables.map((table): FloorTable => ({
      id: table.id,
      name: table.name,
      capacity: table.capacity,
      sortOrder: table.sortOrder,
      isActive: table.isActive,
      status: deriveTableStatus(activeOrdersByTableId.get(table.id)),
      activeOrderId: activeOrdersByTableId.get(table.id)?.orderId ?? null,
    })),
  }));
}
