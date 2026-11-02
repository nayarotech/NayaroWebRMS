import { readComboSnapshot } from '../menu/combos';
import type { KitchenTicket } from '@nayaro/shared';
import type { KitchenTicketRow } from './kitchen.types';

/**
 * The columns a kitchen ticket needs. Shared between the board query and the
 * send operation, so the ticket the POS gets back is byte-for-byte the shape
 * the kitchen screen shows.
 */
export const KITCHEN_TICKET_SELECT = {
  id: true,
  kotNumber: true,
  status: true,
  createdAt: true,
  startedAt: true,
  readyAt: true,
  servedAt: true,
  order: {
    select: {
      id: true,
      orderNumber: true,
      type: true,
      table: { select: { name: true } },
    },
  },
  items: {
    select: {
      id: true,
      quantity: true,
      noteSnapshot: true,
      orderItem: {
        select: { nameSnapshot: true, nameNpSnapshot: true, createdAt: true, comboSnapshot: true },
      },
    },
  },
} as const;

/**
 * Prisma row -> the ticket the kitchen reads.
 *
 * Item names and notes are snapshots. The name comes from OrderItem.nameSnapshot and
 * the note from KotItem.noteSnapshot - never from the live MenuItem or the live
 * OrderItem.note. A dish renamed at 8pm, or a note corrected after the ticket
 * was cut, must not silently rewrite the instruction a cook is holding. What
 * the kitchen was told is a historical fact. The table is the order's current
 * location so existing tickets follow a table transfer.
 *
 * `elapsedSeconds` is computed at response time and never stored. It is derived
 * from `createdAt`, which is immutable by design: the timer measures how long
 * food has been waiting since it was ordered, and resetting it on a status
 * change would hide exactly the tickets that need attention.
 */
export function toKitchenTicket(row: KitchenTicketRow, now: Date = new Date()): KitchenTicket {
  return {
    id: row.id,
    kotNumber: row.kotNumber,
    orderId: row.order.id,
    orderNumber: row.order.orderNumber,
    orderType: row.order.type,
    tableName: row.order.table?.name ?? null,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    readyAt: row.readyAt?.toISOString() ?? null,
    servedAt: row.servedAt?.toISOString() ?? null,
    elapsedSeconds: Math.max(0, Math.floor((now.getTime() - row.createdAt.getTime()) / 1000)),
    items: [...row.items]
      // Ticket order follows the order the cashier built, so a cook comparing
      // the ticket with the POS screen reads the same sequence.
      .sort(
        (a, b) =>
          a.orderItem.createdAt.getTime() - b.orderItem.createdAt.getTime() ||
          a.id.localeCompare(b.id),
      )
      .flatMap((item) => {
        const components = readComboSnapshot(item.orderItem.comboSnapshot);
        if (components.length > 0)
          return components.map((part) => ({
            id: `${item.id}:${part.menuItemId}`,
            name: part.name,
            nameNp: part.nameNp,
            quantity: item.quantity * part.quantity,
            note: [item.orderItem.nameSnapshot, item.noteSnapshot].filter(Boolean).join(' · '),
          }));
        return [
          {
            id: item.id,
            name: item.orderItem.nameSnapshot,
            nameNp: item.orderItem.nameNpSnapshot,
            quantity: item.quantity,
            note: item.noteSnapshot,
          },
        ];
      }),
  };
}
