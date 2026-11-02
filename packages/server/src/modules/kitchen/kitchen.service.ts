import type { NayaroPrismaClient } from '@nayaro/database';
import type { KitchenTicket, KitchenTicketsResponse } from '@nayaro/shared';
import { ApiError } from '../../utils/apiError';
import { KITCHEN_TICKET_SELECT, toKitchenTicket } from './kitchen.mapper';
import { transitionKotSchema, voidKotSchema } from './kitchen.schema';

/**
 * The kitchen board: every ticket for work still in the building.
 *
 * WHAT THE BOARD SHOWS, and why this is the boundary. A ticket stays on the
 * board while its ORDER is still on the floor (`closedAt: null`) and leaves
 * when the order is paid or voided. That matches how a kitchen actually thinks:
 * a served ticket for a table still eating is useful context - the cooks can
 * see what that table already has - and becomes noise the moment the customer
 * pays and walks out.
 *
 * It also bounds the query naturally. "Everything from today" would grow all
 * evening and need a date filter that disagrees with the business-day rollover;
 * "still on the floor" is bounded by the number of occupied tables, which is
 * bounded by the size of the restaurant.
 *
 * VOID tickets are excluded outright. A voided ticket means "this batch was
 * sent in error" - showing it to a cook is worse than not showing it at all.
 */
export async function getTickets(
  prisma: NayaroPrismaClient,
  restaurantId: string,
): Promise<KitchenTicketsResponse> {
  const rows = await prisma.kot.findMany({
    where: {
      restaurantId,
      status: { not: 'VOID' },
      order: { closedAt: null },
    },
    // Oldest first: the kitchen works a queue, and the ticket that has been
    // waiting longest is the one that matters most.
    orderBy: [{ createdAt: 'asc' }, { kotNumber: 'asc' }],
    select: KITCHEN_TICKET_SELECT,
  });

  // One `now` for the whole response, so two tickets cut in the same second do
  // not report elapsed times that differ by a millisecond of query time.
  const settings = await prisma.restaurantSettings.findUniqueOrThrow({
    where: { restaurantId },
    select: { kitchenNewTicketAlertMinutes: true },
  });
  const now = new Date();
  return {
    tickets: rows.map((row) => toKitchenTicket(row, now)),
    newTicketAlertMinutes: settings.kitchenNewTicketAlertMinutes,
  };
}

// ---------------------------------------------------------------------------
// The status workflow
// ---------------------------------------------------------------------------

/**
 * THE STATE MACHINE, in one table.
 *
 *   NEW -> PREPARING -> READY -> SERVED
 *
 * Strictly forward, one step at a time. No skipping (a ticket cannot be READY
 * without having been cooked), no going back (a cook who mis-taps does not get
 * to un-cook food), and SERVED is terminal. VOID is not in this table at all:
 * it is a manager correcting a mis-sent dispatch, which changes dispatched
 * quantities, and it needs its own deliberate flow.
 *
 * Expressed as "what must the ticket be NOW for this move to be legal", because
 * that is also exactly the WHERE clause the update needs.
 */
const REQUIRED_PREVIOUS = {
  PREPARING: 'NEW',
  READY: 'PREPARING',
  SERVED: 'READY',
} as const;

/** Which timestamp a move stamps. Each is written once, ever. */
const TIMESTAMP_FIELD = {
  PREPARING: 'startedAt',
  READY: 'readyAt',
  SERVED: 'servedAt',
} as const;

/**
 * Moves a ticket one step along the workflow.
 *
 * CONCURRENCY, and why there is no version column. The machine is forward-only
 * and every state is visited at most once, so the CURRENT STATUS is already a
 * perfect compare-and-swap token - a ticket that has moved cannot look
 * unmoved. `updateMany` with the required status in its WHERE makes the check
 * and the write one conditional statement:
 *
 *   UPDATE Kot SET status='READY', readyAt=now
 *   WHERE id=? AND restaurantId=? AND status='PREPARING'
 *
 * Two cooks double-tapping "Mark ready" both send the same request; exactly one
 * matches a row. The loser changes nothing, and - this is the part that
 * matters - `readyAt` keeps the time the transition ACTUALLY happened rather
 * than being rewritten by whichever duplicate arrived last.
 *
 * The read below exists only to tell the three failures apart in language a
 * person can act on. It is NOT the guarantee; the WHERE clause is.
 */
export async function transitionStatus(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  kotId: string,
  rawInput: unknown,
): Promise<KitchenTicket> {
  const input = transitionKotSchema.parse(rawInput);

  const kot = await prisma.kot.findFirst({
    where: { id: kotId, restaurantId },
    select: { id: true, status: true, order: { select: { closedAt: true } } },
  });
  // Scoped lookup: another restaurant's ticket reads as "not found" rather
  // than leaking that it exists.
  if (!kot) throw new ApiError(404, 'KOT_NOT_FOUND', 'That ticket no longer exists.');

  if (kot.status === 'VOID') {
    throw new ApiError(
      409,
      'KOT_VOIDED',
      'This ticket was cancelled and is no longer part of the kitchen queue.',
    );
  }
  if (kot.order.closedAt !== null) {
    throw new ApiError(
      409,
      'ORDER_CLOSED',
      'This order has been closed, so its tickets can no longer be changed.',
    );
  }

  const required = REQUIRED_PREVIOUS[input.status];
  if (kot.status !== required) {
    // Two different failures, and the difference matters to the person
    // reading it. Landing on the status someone asked for means another
    // terminal got there first - a normal race, not a mistake. Anything else
    // is a move the machine does not allow.
    if (kot.status === input.status) throw kotChanged();
    throw new ApiError(
      409,
      'INVALID_KOT_TRANSITION',
      `A ticket that is ${describe(kot.status)} cannot be marked ${describe(input.status)}.`,
    );
  }

  const moved = await prisma.kot.updateMany({
    where: { id: kotId, restaurantId, status: required },
    data: { status: input.status, [TIMESTAMP_FIELD[input.status]]: new Date() },
  });
  if (moved.count === 0) throw kotChanged();

  const row = await prisma.kot.findFirstOrThrow({
    where: { id: kotId },
    select: KITCHEN_TICKET_SELECT,
  });
  return toKitchenTicket(row);
}

function kotChanged(): ApiError {
  return new ApiError(
    409,
    'KOT_CHANGED',
    'Another terminal moved this ticket first. We have refreshed the board.',
  );
}

/** Kitchen words, not enum names. These reach the screen. */
function describe(status: string): string {
  switch (status) {
    case 'NEW':
      return 'still waiting';
    case 'PREPARING':
      return 'being cooked';
    case 'READY':
      return 'ready';
    case 'SERVED':
      return 'served';
    default:
      return status.toLowerCase();
  }
}

// ---------------------------------------------------------------------------
// Void: "this batch was sent in error"
// ---------------------------------------------------------------------------

/**
 * WHAT VOIDING A TICKET MEANS, and what it emphatically does not.
 *
 * It means the DISPATCH was a mistake - the wrong table, a double tap, a
 * ticket cut before the customer had finished deciding. Because
 * `dispatchedQuantity` is defined as the sum over non-VOID tickets, voiding
 * one returns its quantities to the undispatched pool, and they can be sent
 * again on a later ticket. Nothing about the order or the bill changes.
 *
 * It is NOT how a customer cancels food. That food was really ordered and the
 * kitchen really cooked it; erasing the dispatch would be a lie in the kitchen
 * history and would put the quantity back in the queue to be cooked twice.
 * That is `OrderItemCancellation`, which reduces the BILL and leaves the
 * dispatch alone.
 *
 * WHY SERVED CANNOT BE VOIDED. Up to READY the food is still in the kitchen's
 * hands and "we should never have sent this" is a statement someone can act
 * on. Once it has been carried to the table, the dispatch demonstrably
 * happened. Correcting what the customer pays for is then a cancellation, and
 * pretending the ticket never existed would leave the kitchen's own record
 * disagreeing with what the cooks remember plating.
 */
const VOIDABLE_STATUSES = ['NEW', 'PREPARING', 'READY'] as const;

export interface VoidKotResult {
  readonly kotId: string;
  readonly kotNumber: number;
  readonly orderId: string;
}

export async function voidKot(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  staffId: string,
  kotId: string,
  rawInput: unknown,
): Promise<VoidKotResult> {
  const input = voidKotSchema.parse(rawInput);

  return prisma.$transaction(async (tx) => {
    const kot = await tx.kot.findFirst({
      where: { id: kotId, restaurantId },
      select: {
        id: true,
        kotNumber: true,
        status: true,
        order: { select: { id: true, status: true, version: true } },
      },
    });
    // Scoped lookup: another restaurant's ticket reads as "not found" rather
    // than leaking that it exists.
    if (!kot) throw new ApiError(404, 'KOT_NOT_FOUND', 'That ticket no longer exists.');

    if (kot.status === 'VOID') {
      throw new ApiError(409, 'KOT_ALREADY_VOID', 'This ticket has already been voided.');
    }
    if (kot.status === 'SERVED') {
      throw new ApiError(
        409,
        'KOT_ALREADY_SERVED',
        'This food has already been served, so the ticket cannot be treated as sent in error. Cancel the items on the order instead.',
      );
    }

    /*
     * The order must be OPEN. A BILLED order has a frozen document standing
     * against it, and moving dispatch around underneath one would let the bill
     * and the kitchen tell different stories. The path exists and is ordered:
     * void the bill, which reopens the order, then void the ticket.
     */
    if (kot.order.status !== 'OPEN') {
      throw new ApiError(
        409,
        kot.order.status === 'BILLED' ? 'ORDER_ALREADY_BILLED' : 'ORDER_CLOSED',
        kot.order.status === 'BILLED'
          ? 'A bill has been made for this order. Void the bill first, then void this ticket.'
          : 'This order is closed, so its tickets can no longer be changed.',
      );
    }

    /*
     * THE ONE COMBINATION THAT DOES NOT ADD UP. If a customer has already
     * cancelled some of this ticket's items, the dispatch was real and has
     * been corrected the honest way. Voiding it as well would return the
     * quantities to the undispatched pool while they stay cancelled off the
     * bill - the kitchen would be told to cook two momos the customer is being
     * charged for one of. The two corrections mean opposite things; refuse to
     * apply both to the same food.
     */
    const cancellations = await tx.orderItemCancellation.count({
      where: { orderItem: { kotItems: { some: { kotId } } } },
    });
    if (cancellations > 0) {
      throw new ApiError(
        409,
        'KOT_HAS_CANCELLATIONS',
        'Items on this ticket have already been cancelled off the bill, so it cannot also be treated as sent in error.',
      );
    }

    /*
     * CONCURRENCY. The status is the compare-and-swap token, exactly as it is
     * for a forward transition: a ticket that has already been voided is no
     * longer in the voidable set, so two managers pressing Void produce one
     * void and one refusal. A cook marking it SERVED in the same instant takes
     * it out of the set too, and this loses - which is the right way round,
     * because the food is then out of the kitchen.
     */
    const voided = await tx.kot.updateMany({
      where: { id: kotId, restaurantId, status: { in: [...VOIDABLE_STATUSES] } },
      data: {
        status: 'VOID',
        voidedAt: new Date(),
        voidReason: input.reason,
        voidedByStaffId: staffId,
      },
    });
    if (voided.count === 0) throw kotChanged();

    /*
     * The order stays OPEN even when this was its only ticket. Reverting it to
     * DRAFT would claim nothing had ever been sent to the kitchen, and the
     * voided ticket in the history says otherwise. Nothing depends on the
     * distinction anyway: item removal and re-dispatch are both gated on
     * dispatched quantity, which this void has already returned to zero.
     *
     * The version bump is read-then-CAS on the value read at the top of this
     * transaction, so a payment or an edit that raced us loses cleanly instead
     * of both succeeding.
     */
    const claimed = await tx.order.updateMany({
      where: { id: kot.order.id, version: kot.order.version },
      data: { version: { increment: 1 } },
    });
    if (claimed.count === 0) {
      throw new ApiError(
        409,
        'ORDER_CHANGED',
        'This order was changed on another terminal. We have refreshed it - please check it and try again.',
      );
    }

    return { kotId: kot.id, kotNumber: kot.kotNumber, orderId: kot.order.id };
  });
}
