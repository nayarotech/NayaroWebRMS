import { activeOffers, offerPrice } from '../offers/offers.service';
import type { NayaroPrismaClient } from '@nayaro/database';
import type {
  MaybeOrderListResponse,
  MaybeOrderResponse,
  OrderResponse,
  SendToKitchenResponse,
} from '@nayaro/shared';
import { withRequestReceipt, type IdempotencyAttempt } from '../../utils/idempotency';
import { resolveCombo } from '../menu/combos';
import { ApiError } from '../../utils/apiError';
import { consumeRecipeStock } from '../inventory/inventory.service';
import { resolveBusinessDate } from '../../utils/businessDate';
import { KITCHEN_TICKET_SELECT, toKitchenTicket } from '../kitchen/kitchen.mapper';
import { ORDER_SELECT, toOrderDto } from './orders.mapper';
import {
  addOrderItemSchema,
  cancelOrderItemSchema,
  removeOrderItemSchema,
  sendToKitchenSchema,
  updateOrderItemSchema,
  transferTableSchema,
} from './orders.schema';

/**
 * Draft orders: what a cashier builds before anything reaches the kitchen.
 *
 * Three rules hold across every function here.
 *
 * 1. `restaurantId` comes from the authenticated session and is applied to
 *    every query. Same rule as the floor: a signed-in user at one restaurant
 *    cannot read or edit another's orders by guessing an id.
 *
 * 2. An Order row exists only once a real item has been added. Clicking a
 *    table opens a screen; it does not write to the database. Empty orders
 *    would accumulate from every mis-tap, hold tables OCCUPIED, and burn
 *    order numbers on nothing.
 *
 * 3. Every mutation is a compare-and-swap on `version`. Two terminals editing
 *    one order is not a hypothetical in a restaurant - it is Friday night -
 *    and the loser must be told, never silently overwritten.
 */

/**
 * States in which an order's items may still be changed.
 *
 * OPEN joined DRAFT in Phase 4D: once the first ticket goes to the kitchen the
 * order is OPEN, and a customer asking for one more Coke is the most ordinary
 * thing that happens next. What OPEN does NOT allow is reducing a line below
 * what the kitchen is already cooking - that guard lives in `assertNotBelow-
 * Dispatched`, not in the status check.
 */
const EDITABLE_STATUSES = ['DRAFT', 'OPEN'] as const;

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getOrder(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  orderId: string,
): Promise<OrderResponse> {
  const order = await prisma.order.findFirst({
    where: { id: orderId, restaurantId },
    select: ORDER_SELECT,
  });
  if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'That order no longer exists.');
  return { order: toOrderDto(order) };
}

/**
 * The order currently sitting on a table, if any.
 *
 * `closedAt: null` is the same predicate the partial unique index uses, which
 * is what guarantees this returns at most one row rather than a list.
 */
export async function getActiveOrderForTable(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  tableId: string,
): Promise<MaybeOrderResponse> {
  await findTableOrThrow(prisma, restaurantId, tableId);

  const order = await prisma.order.findFirst({
    where: { restaurantId, tableId, closedAt: null },
    select: ORDER_SELECT,
  });
  return { order: order === null ? null : toOrderDto(order) };
}

/**
 * Open takeaway orders.
 *
 * THE BUG THIS FIXES. A takeaway has no table, so the floor plan cannot show
 * it - and once a cashier navigated away, the only route back was a URL nobody
 * had written down. The order stayed open forever, holding an order number,
 * unbillable and invisible.
 *
 * Bounded by `closedAt: null`, exactly like the floor: this lists work in
 * progress, never history. A paid takeaway disappears from it, which is what
 * makes the list short enough to be useful.
 */
export async function listOpenTakeaways(
  prisma: NayaroPrismaClient,
  restaurantId: string,
): Promise<MaybeOrderListResponse> {
  const orders = await prisma.order.findMany({
    where: { restaurantId, type: 'TAKEAWAY', closedAt: null },
    orderBy: { createdAt: 'asc' },
    select: ORDER_SELECT,
  });
  return { orders: orders.map(toOrderDto) };
}

// ---------------------------------------------------------------------------
// Add an item - the only operation that can bring an Order into existence
// ---------------------------------------------------------------------------

export async function addItem(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  staffId: string,
  rawInput: unknown,
  attempt?: IdempotencyAttempt,
): Promise<OrderResponse> {
  const input = addOrderItemSchema.parse(rawInput);
  return withRequestReceipt(
    prisma,
    restaurantId,
    staffId,
    'add-item',
    input,
    attempt,
    async (tx) => {
      const menuItem = await findSellableMenuItemOrThrow(tx, restaurantId, input.menuItemId);
      const quantity = input.quantity ?? 1;
      const note = normaliseNote(input.note);

      if (input.target.kind === 'ORDER') {
        const orderId = input.target.orderId;
        const expectedVersion = input.target.expectedVersion;

        await assertEditableDraft(tx, restaurantId, orderId);
        await claimVersion(tx, orderId, expectedVersion);
        await upsertLine(tx, orderId, menuItem, quantity, note);
        const updated = await tx.order.findFirstOrThrow({
          where: { id: orderId },
          select: ORDER_SELECT,
        });
        return { order: toOrderDto(updated) };
      }

      // Create case. Everything below happens in one transaction so a failure
      // anywhere leaves no order number burned and no half-built order.
      const tableId = input.target.kind === 'TABLE' ? input.target.tableId : null;
      if (tableId !== null) {
        const table = await findTableOrThrow(tx, restaurantId, tableId);
        if (!table.isActive) {
          throw new ApiError(
            409,
            'TABLE_INACTIVE',
            `"${table.name}" is out of service. Put it back in service before taking orders on it.`,
          );
        }
      }

      try {
        if (tableId !== null) {
          // Advisory check: it turns the ordinary case into a clear message
          // instead of a constraint violation. It is NOT the guarantee - two
          // terminals can both pass this and both proceed. The partial unique
          // index below is what actually holds the line.
          const existing = await tx.order.findFirst({
            where: { restaurantId, tableId, closedAt: null },
            select: { id: true },
          });
          if (existing) throw activeOrderConflict();
        }

        const orderNumber = await allocateOrderNumber(tx, restaurantId);
        const businessDate = await resolveRestaurantBusinessDate(tx, restaurantId);

        const created = await tx.order.create({
          data: {
            restaurantId,
            orderNumber,
            type: tableId === null ? 'TAKEAWAY' : 'DINE_IN',
            status: 'DRAFT',
            tableId,
            openedByStaffId: staffId,
            businessDate,
            // Creation-with-first-item is mutation number one, so the version a
            // client must send back to edit further is 1, not 0.
            version: 1,
            items: {
              create: {
                menuItemId: menuItem.id,
                nameSnapshot: menuItem.name,
                nameNpSnapshot: menuItem.nameNp,
                unitPricePaisa: menuItem.pricePaisa,
                comboSnapshot: menuItem.comboSnapshot,
                promotionSnapshot: menuItem.promotionSnapshot,
                quantity,
                note,
              },
            },
          },
          select: ORDER_SELECT,
        });
        return { order: toOrderDto(created) };
      } catch (error: unknown) {
        // The race we designed the index for: another terminal created the order
        // between our check and our insert. Translate, never leak.
        if (isActiveOrderIndexViolation(error)) throw activeOrderConflict();
        throw error;
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Edit and remove
// ---------------------------------------------------------------------------

export async function updateItem(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  orderId: string,
  itemId: string,
  rawInput: unknown,
): Promise<OrderResponse> {
  const input = updateOrderItemSchema.parse(rawInput);

  const order = await prisma.$transaction(async (tx) => {
    await assertEditableDraft(tx, restaurantId, orderId);
    await claimVersion(tx, orderId, input.expectedVersion);

    const item = await tx.orderItem.findFirst({
      where: { id: itemId, orderId },
      select: { id: true },
    });
    if (!item)
      throw new ApiError(404, 'ORDER_ITEM_NOT_FOUND', 'That item is no longer on this order.');

    if (input.quantity !== undefined) {
      await assertNotBelowDispatched(tx, itemId, input.quantity);
    }

    // A note edit deliberately does NOT re-merge this line into an identical
    // one. Collapsing two rows under the cashier's hands, mid-edit, is more
    // surprising than leaving a duplicate they can remove themselves.
    await tx.orderItem.update({
      where: { id: itemId },
      data: {
        ...(input.quantity === undefined ? {} : { quantity: input.quantity }),
        ...(input.note === undefined ? {} : { note: normaliseNote(input.note ?? undefined) }),
      },
    });

    return tx.order.findFirstOrThrow({ where: { id: orderId }, select: ORDER_SELECT });
  });

  return { order: toOrderDto(order) };
}

/**
 * Removes an item, and the order too if that was the last one.
 *
 * THE EMPTY-DRAFT DELETE, and why it is safe here specifically. A DRAFT with
 * no items is an order that never happened: nothing was cooked, nothing was
 * billed, nobody was charged. Keeping it would hold the table OCCUPIED with
 * nothing to settle and leave meaningless rows in the owner's history. The
 * three conditions below are what make the delete provably lossless - no KOT,
 * no invoice, no payment means nothing anywhere references this order.
 *
 * It leaves a gap in the ORDER counter, which is fine: that sequence is
 * internal bookkeeping. Invoice numbers are the regulated gapless series and
 * nothing here touches them.
 *
 * A hard delete stops being safe the moment a KOT exists, which is why this
 * is confined to DRAFT and why Phase 4D will not extend it.
 */
export async function removeItem(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  orderId: string,
  itemId: string,
  rawQuery: unknown,
): Promise<MaybeOrderResponse> {
  const { expectedVersion } = removeOrderItemSchema.parse(rawQuery);

  const order = await prisma.$transaction(async (tx) => {
    await assertEditableDraft(tx, restaurantId, orderId);
    await claimVersion(tx, orderId, expectedVersion);

    // The KotItem foreign key is RESTRICT, so the database would refuse this
    // anyway - but with a constraint error nobody can act on. Checking first
    // turns it into a sentence a cashier understands.
    await assertNotDispatched(tx, itemId);
    await assertNotCancelled(tx, itemId);

    const deleted = await tx.orderItem.deleteMany({ where: { id: itemId, orderId } });
    if (deleted.count === 0) {
      throw new ApiError(404, 'ORDER_ITEM_NOT_FOUND', 'That item is no longer on this order.');
    }

    const remaining = await tx.orderItem.count({ where: { orderId } });
    if (remaining === 0 && (await isUntouchedDraft(tx, orderId))) {
      await tx.order.delete({ where: { id: orderId } });
      return null;
    }

    return tx.order.findFirstOrThrow({ where: { id: orderId }, select: ORDER_SELECT });
  });

  return { order: order === null ? null : toOrderDto(order) };
}

// ---------------------------------------------------------------------------
// Send to kitchen
// ---------------------------------------------------------------------------

/**
 * Dispatches everything not yet sent, as ONE new ticket.
 *
 * A KOT is a BATCH, not the order. An order accumulates tickets over a meal -
 * drinks first, mains when the table is ready, a late dessert - and each is a
 * separate instruction the kitchen acts on once. That is why this creates a new
 * Kot every time rather than editing an existing one, and why it sends only the
 * delta:
 *
 *   ordered 2 momo, 1 coke   send -> KOT #1: momo x2, coke x1
 *   coke becomes 2           send -> KOT #2: coke x1
 *
 * Re-sending the first coke would have the kitchen make two. That delta is the
 * whole safety property, and it is computed from KOTItem rows rather than from
 * a stored counter, so it cannot drift out of step with the tickets themselves.
 *
 * All of it in one transaction: if any assertion fails the KOT number is never
 * consumed, because the counter increment rolls back with everything else.
 */
export async function sendToKitchen(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  staffId: string,
  orderId: string,
  rawInput: unknown,
  attempt?: IdempotencyAttempt,
): Promise<SendToKitchenResponse> {
  const input = sendToKitchenSchema.parse(rawInput);

  return withRequestReceipt(
    prisma,
    restaurantId,
    staffId,
    `send-kot:${orderId}`,
    input,
    attempt,
    async (tx) => {
      const order = await tx.order.findFirst({
        where: { id: orderId, restaurantId },
        select: { id: true, status: true, tableId: true },
      });
      if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'That order no longer exists.');
      if (order.status !== 'DRAFT' && order.status !== 'OPEN') {
        throw new ApiError(
          409,
          'ORDER_NOT_EDITABLE',
          order.status === 'BILLED'
            ? 'This order has been billed. Nothing more can be sent to the kitchen.'
            : 'This order is closed. Nothing more can be sent to the kitchen.',
        );
      }

      // Checked separately from status because the two are meant to agree
      // (Phase 3 invariant 12) and a disagreement should fail safe.
      const activeInvoices = await tx.invoice.count({ where: { orderId, status: 'ACTIVE' } });
      if (activeInvoices > 0) {
        throw new ApiError(
          409,
          'ORDER_ALREADY_BILLED',
          'A bill has been made for this order. Void it before sending anything else.',
        );
      }

      // Claimed before anything is written, so a losing terminal changes nothing.
      await claimVersion(tx, orderId, input.expectedVersion);

      const items = await tx.orderItem.findMany({
        where: { orderId },
        select: {
          id: true,
          quantity: true,
          note: true,
          kotItems: { where: { kot: { status: { not: 'VOID' } } }, select: { quantity: true } },
        },
      });

      const toDispatch = items
        .map((item) => ({
          orderItemId: item.id,
          note: item.note,
          quantity: item.quantity - item.kotItems.reduce((total, kot) => total + kot.quantity, 0),
        }))
        .filter((line) => line.quantity > 0);

      if (toDispatch.length === 0) {
        // Rejected BEFORE the counter is touched, so a no-op send burns no KOT
        // number - and never writes an empty ticket for the kitchen to puzzle at.
        throw new ApiError(
          409,
          'NOTHING_TO_SEND',
          'Everything on this order has already gone to the kitchen.',
        );
      }

      const kotNumber = await allocateKotNumber(tx, restaurantId);

      const kot = await tx.kot.create({
        data: {
          restaurantId,
          orderId,
          kotNumber,
          status: 'NEW',
          createdByStaffId: staffId,
          items: {
            create: toDispatch.map((line) => ({
              orderItemId: line.orderItemId,
              quantity: line.quantity,
              // Frozen here. Editing the OrderItem note afterwards must not
              // rewrite what the kitchen was told to cook.
              noteSnapshot: line.note,
            })),
          },
        },
        select: { id: true },
      });

      await consumeRecipeStock(tx, restaurantId, staffId, kot.id, toDispatch);

      // The first dispatch is what makes an order real: DRAFT means "still being
      // built", OPEN means "the kitchen is working on it". After this the order
      // can no longer vanish by being emptied, which is exactly right.
      if (order.status === 'DRAFT') {
        await tx.order.update({ where: { id: orderId }, data: { status: 'OPEN' } });
      }

      const updated = await tx.order.findFirstOrThrow({
        where: { id: orderId },
        select: ORDER_SELECT,
      });
      const ticket = await tx.kot.findFirstOrThrow({
        where: { id: kot.id },
        select: KITCHEN_TICKET_SELECT,
      });
      return { order: toOrderDto(updated), kot: toKitchenTicket(ticket) };
    },
  );
}

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

/** The Prisma transaction client. Narrow alias, so the helpers read cleanly. */
type Tx = Parameters<Parameters<NayaroPrismaClient['$transaction']>[0]>[0];

/**
 * Optimistic concurrency, done as one atomic statement.
 *
 * Read-then-write would be a race of its own: two terminals could both read
 * version 4 and both decide they are allowed to proceed. `updateMany` with the
 * version in its WHERE makes the check and the increment a single conditional
 * update - exactly one of them can match, and `count === 0` is the loser
 * finding out. Called before touching any item, so a rejected edit rolls back
 * having changed nothing.
 */
async function claimVersion(tx: Tx, orderId: string, expectedVersion: number): Promise<void> {
  const claimed = await tx.order.updateMany({
    where: { id: orderId, version: expectedVersion },
    data: { version: { increment: 1 } },
  });
  if (claimed.count === 0) {
    throw new ApiError(
      409,
      'ORDER_CHANGED',
      'This order was changed on another terminal. We have refreshed it - please check it and try again.',
    );
  }
}

async function assertEditableDraft(tx: Tx, restaurantId: string, orderId: string): Promise<void> {
  const order = await tx.order.findFirst({
    where: { id: orderId, restaurantId },
    select: { status: true },
  });
  if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'That order no longer exists.');
  if (!(EDITABLE_STATUSES as readonly string[]).includes(order.status)) {
    throw new ApiError(
      409,
      'ORDER_NOT_EDITABLE',
      order.status === 'BILLED'
        ? 'This order has been billed. Void the bill before changing it.'
        : 'This order is closed and can no longer be changed.',
    );
  }
}

/**
 * How much of one line the kitchen already has. VOID tickets do not count:
 * voiding a ticket returns its quantities to undispatched, which is the whole
 * meaning of that status.
 */
async function dispatchedQuantity(tx: Tx, orderItemId: string): Promise<number> {
  const rows = await tx.kotItem.findMany({
    where: { orderItemId, kot: { status: { not: 'VOID' } } },
    select: { quantity: true },
  });
  return rows.reduce((total, row) => total + row.quantity, 0);
}

/**
 * A line may shrink, but never below what is already being cooked.
 *
 * Ordered 3, sent 2, reduce to 2 - fine, the third was never dispatched.
 * Ordered 2, sent 2, reduce to 1 - refused: the food exists. Taking it off the
 * bill is a cancellation, which is a manager decision with a reason attached
 * (OrderItemCancellation), not a quantity edit.
 */
async function assertNotBelowDispatched(
  tx: Tx,
  orderItemId: string,
  nextQuantity: number,
): Promise<void> {
  const dispatched = await dispatchedQuantity(tx, orderItemId);
  if (nextQuantity < dispatched) {
    throw new ApiError(
      409,
      'QUANTITY_BELOW_DISPATCHED',
      `${String(dispatched)} of these have already gone to the kitchen, so the quantity cannot go below ${String(dispatched)}.`,
    );
  }
}

async function assertNotDispatched(tx: Tx, orderItemId: string): Promise<void> {
  if ((await dispatchedQuantity(tx, orderItemId)) > 0) {
    throw new ApiError(
      409,
      'ITEM_ALREADY_SENT',
      'This has already gone to the kitchen and cannot be removed from the order.',
    );
  }
}

/**
 * A line carrying cancellations cannot be deleted.
 *
 * The FK is RESTRICT, so the database would refuse it anyway - and a raw
 * constraint error is not something a cashier can act on. In practice this is
 * unreachable today, because cancelling requires a live dispatch and a ticket
 * with cancellations cannot be voided, so `assertNotDispatched` fires first.
 * It is here because that chain of reasoning is exactly the kind that a later
 * change quietly breaks, and the failure would be a Prisma error on screen.
 */
async function assertNotCancelled(tx: Tx, orderItemId: string): Promise<void> {
  if ((await tx.orderItemCancellation.count({ where: { orderItemId } })) > 0) {
    throw new ApiError(
      409,
      'ITEM_HAS_CANCELLATIONS',
      'This item has a recorded cancellation against it, so it has to stay on the order as history.',
    );
  }
}

/** Nothing anywhere references this order, so deleting it loses no history. */
async function isUntouchedDraft(tx: Tx, orderId: string): Promise<boolean> {
  const [kots, invoices, payments] = await Promise.all([
    tx.kot.count({ where: { orderId } }),
    tx.invoice.count({ where: { orderId } }),
    tx.payment.count({ where: { orderId } }),
  ]);
  return kots === 0 && invoices === 0 && payments === 0;
}

/**
 * MERGE RULE: menuItemId + note + unit price.
 *
 * Tapping Chicken Momo twice should read "Chicken Momo x2", not two identical
 * lines - a cashier scanning the panel counts lines, not quantities. But two
 * taps with different notes are genuinely two things the kitchen must plate
 * differently, so the note is part of the key.
 *
 * The unit price is in the key too, and that is the subtle one: if the owner
 * repriced the dish between the two taps, merging would retroactively reprice
 * the first plate. The snapshot exists precisely so that cannot happen, and a
 * merge key that ignored it would quietly undo it.
 *
 * This stays friendly to Phase 4D's KOT batching, which dispatches
 * "quantity minus what has already gone" per row - arithmetic that works the
 * same whether the quantity arrived in one tap or five.
 */
async function upsertLine(
  tx: Tx,
  orderId: string,
  menuItem: {
    id: string;
    name: string;
    nameNp: string | null;
    pricePaisa: number;
    comboSnapshot: string;
    promotionSnapshot: string | null;
  },
  quantity: number,
  note: string | null,
): Promise<void> {
  const existing = await tx.orderItem.findFirst({
    where: {
      orderId,
      menuItemId: menuItem.id,
      note,
      unitPricePaisa: menuItem.pricePaisa,
      comboSnapshot: menuItem.comboSnapshot,
      promotionSnapshot: menuItem.promotionSnapshot,
    },
    select: { id: true },
  });

  if (existing) {
    await tx.orderItem.update({
      where: { id: existing.id },
      data: { quantity: { increment: quantity } },
    });
    return;
  }

  await tx.orderItem.create({
    data: {
      orderId,
      menuItemId: menuItem.id,
      // Snapshots. From here on this line is immune to menu edits.
      nameSnapshot: menuItem.name,
      nameNpSnapshot: menuItem.nameNp,
      unitPricePaisa: menuItem.pricePaisa,
      comboSnapshot: menuItem.comboSnapshot,
      promotionSnapshot: menuItem.promotionSnapshot,
      quantity,
      note,
    },
  });
}

/**
 * Order numbers come from a counter row updated inside the transaction, so two
 * concurrent orders cannot be handed the same number. `update` returns the new
 * value, hence the -1: we take the number we just consumed.
 *
 * `upsert` rather than `update` so a restaurant whose counters predate this
 * feature still works instead of failing on a missing row.
 */
async function allocateOrderNumber(tx: Tx, restaurantId: string): Promise<number> {
  const counter = await tx.restaurantCounter.upsert({
    where: { restaurantId_name: { restaurantId, name: 'ORDER' } },
    create: { restaurantId, name: 'ORDER', nextValue: 2 },
    update: { nextValue: { increment: 1 } },
    select: { nextValue: true },
  });
  return counter.nextValue - 1;
}

/**
 * KOT numbers, allocated exactly as order numbers are: an increment inside the
 * caller's transaction, so two simultaneous sends cannot be handed the same
 * number and a rolled-back send consumes nothing.
 */
async function allocateKotNumber(tx: Tx, restaurantId: string): Promise<number> {
  const counter = await tx.restaurantCounter.upsert({
    where: { restaurantId_name: { restaurantId, name: 'KOT' } },
    create: { restaurantId, name: 'KOT', nextValue: 2 },
    update: { nextValue: { increment: 1 } },
    select: { nextValue: true },
  });
  return counter.nextValue - 1;
}

async function resolveRestaurantBusinessDate(tx: Tx, restaurantId: string): Promise<string> {
  const settings = await tx.restaurantSettings.findFirst({
    where: { restaurantId },
    select: { businessDayStartsAtMinutes: true, timezone: true },
  });
  return resolveBusinessDate(new Date(), settings?.businessDayStartsAtMinutes ?? 240, settings?.timezone);
}

async function findTableOrThrow(
  prisma: NayaroPrismaClient | Tx,
  restaurantId: string,
  tableId: string,
): Promise<{ id: string; name: string; isActive: boolean }> {
  const table = await prisma.restaurantTable.findFirst({
    where: { id: tableId, restaurantId },
    select: { id: true, name: true, isActive: true },
  });
  if (!table) throw new ApiError(404, 'TABLE_NOT_FOUND', 'That table no longer exists.');
  return table;
}

/**
 * Both flags are checked, and they fail differently on purpose: a retired dish
 * is gone (404), a sold-out one is a real dish you cannot have right now (409).
 */
async function findSellableMenuItemOrThrow(
  prisma: NayaroPrismaClient | Tx,
  restaurantId: string,
  menuItemId: string,
): Promise<{
  id: string;
  name: string;
  nameNp: string | null;
  pricePaisa: number;
  comboSnapshot: string;
  promotionSnapshot: string | null;
}> {
  const item = await prisma.menuItem.findFirst({
    where: { id: menuItemId, restaurantId },
    select: {
      id: true,
      name: true,
      nameNp: true,
      pricePaisa: true,
      comboComponents: true,
      categoryId: true,
      isActive: true,
      isAvailable: true,
      recipe: { include: { ingredient: true } },
    },
  });
  if (!item || !item.isActive) {
    throw new ApiError(404, 'MENU_ITEM_NOT_FOUND', 'That item is no longer on the menu.');
  }
  if (!item.isAvailable) {
    throw new ApiError(409, 'MENU_ITEM_UNAVAILABLE', `"${item.name}" is sold out today.`);
  }
  if (
    item.recipe.some(
      (row) => !row.ingredient.isActive || row.ingredient.onHandMilli < row.quantityMilli,
    )
  )
    throw new ApiError(
      409,
      'INSUFFICIENT_STOCK',
      `Not enough ingredients for "${item.name}". Check stock before ordering.`,
    );
  const combo = await resolveCombo(prisma, restaurantId, item.comboComponents);
  if (!combo.available)
    throw new ApiError(
      409,
      'COMBO_UNAVAILABLE',
      'A bundle dish is unavailable or has insufficient ingredients.',
    );
  const price = offerPrice(await activeOffers(prisma, restaurantId), item);
  return {
    id: item.id,
    name: item.name,
    nameNp: item.nameNp,
    pricePaisa: price.pricePaisa,
    promotionSnapshot: price.promotionSnapshot,
    comboSnapshot: JSON.stringify(combo.snapshot),
  };
}

function activeOrderConflict(): ApiError {
  return new ApiError(
    409,
    'ORDER_ALREADY_OPEN',
    'Another terminal just started an order on this table. We have opened it for you.',
  );
}

/** Empty note and absent note are the same thing; storing "" would split the
 * merge key on something invisible. */
function normaliseNote(note: string | undefined): string | null {
  const trimmed = note?.trim() ?? '';
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Recognises the partial unique index firing, whatever the driver adapter
 * chooses to call it. Prisma normally reports P2002, but this goes through the
 * libSQL adapter, so the raw SQLite message is checked as well rather than
 * trusting one shape and turning a race into a 500.
 */
function isActiveOrderIndexViolation(error: unknown): boolean {
  if (error instanceof ApiError) return false;
  const code = (error as { code?: unknown }).code;
  if (code === 'P2002') return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('uq_order_active_per_table') ||
    (message.includes('UNIQUE constraint failed') && message.includes('Order'))
  );
}

// ---------------------------------------------------------------------------
// Cancelling dispatched items
// ---------------------------------------------------------------------------

/**
 * The customer no longer wants food the kitchen has already been told about.
 *
 * THE MODEL, and why it is not simply "reduce the quantity". The kitchen was
 * told to cook two momos and it cooked two momos. Editing `OrderItem.quantity`
 * down to one would rewrite that instruction after the fact: the order would
 * claim one was ordered, the ticket would say two, and nobody could tell later
 * whether the kitchen had made a mistake or the customer had changed their
 * mind. So the ordered quantity never moves. A cancellation row is added
 * beside it, and the bill is computed as
 *
 *   billableQuantity = quantity - SUM(cancellations)
 *
 * Dispatch history is untouched. The ticket still says two, because that is
 * what the kitchen was really asked for.
 *
 * WHY THE CEILING IS THE DISPATCHED QUANTITY rather than the ordered one.
 * Cancellation is the expensive, audited path, and it exists for units the
 * kitchen already has. Units that have not been sent are still just an edit -
 * `updateItem` handles them, with no reason and no manager needed. Allowing
 * cancellation past the dispatched count would also produce a line that makes
 * no sense: ordered 3, sent 2, cancelled 3 would leave one unit simultaneously
 * waiting to be cooked and already off the bill.
 */
export async function cancelOrderItem(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  staffId: string,
  orderId: string,
  itemId: string,
  rawInput: unknown,
): Promise<OrderResponse> {
  const input = cancelOrderItemSchema.parse(rawInput);

  await prisma.$transaction(async (tx) => {
    const item = await tx.orderItem.findFirst({
      where: { id: itemId, orderId, order: { restaurantId } },
      select: {
        id: true,
        nameSnapshot: true,
        quantity: true,
        order: { select: { id: true, status: true, version: true } },
        kotItems: { where: { kot: { status: { not: 'VOID' } } }, select: { quantity: true } },
        cancellations: { select: { quantity: true } },
      },
    });
    if (!item) throw new ApiError(404, 'ITEM_NOT_FOUND', 'That item is no longer on this order.');

    if (item.order.status !== 'OPEN') {
      throw new ApiError(
        409,
        item.order.status === 'BILLED' ? 'ORDER_ALREADY_BILLED' : 'ORDER_NOT_EDITABLE',
        item.order.status === 'BILLED'
          ? 'A bill has been made for this order. Void the bill first, then cancel the item.'
          : item.order.status === 'DRAFT'
            ? 'Nothing on this order has gone to the kitchen yet. Change the quantity instead.'
            : 'This order is closed and can no longer be changed.',
      );
    }

    const dispatched = item.kotItems.reduce((total, kot) => total + kot.quantity, 0);
    if (dispatched === 0) {
      // Deliberately not a cancellation. Nobody has cooked anything, so there
      // is nothing to explain and nobody to hold to account - just edit it.
      throw new ApiError(
        409,
        'ITEM_NOT_DISPATCHED',
        'This has not gone to the kitchen yet. Change the quantity on the order instead.',
      );
    }

    const alreadyCancelled = item.cancellations.reduce(
      (total, cancellation) => total + cancellation.quantity,
      0,
    );
    const remaining = dispatched - alreadyCancelled;
    if (input.quantity > remaining) {
      throw new ApiError(
        409,
        'CANCELS_MORE_THAN_SENT',
        remaining === 0
          ? `Every ${item.nameSnapshot} that went to the kitchen has already been cancelled.`
          : `Only ${String(remaining)} of ${String(dispatched)} ${item.nameSnapshot} sent to the kitchen can still be cancelled.`,
      );
    }

    await tx.orderItemCancellation.create({
      data: {
        orderItemId: item.id,
        quantity: input.quantity,
        reason: input.reason,
        cancelledByStaffId: staffId,
      },
    });

    /*
     * CONCURRENCY, and what it is actually protecting. The totals above were
     * read inside this transaction; the claim below is a conditional update on
     * the version they were read against. Two managers each cancelling the
     * last remaining momo both compute "1 may still be cancelled", but only one
     * of them can move the version - the other rolls back having written
     * nothing, and re-reads a line where nothing remains to cancel. Without
     * this the line would end up cancelled twice over.
     */
    await claimVersion(tx, item.order.id, item.order.version);
  });

  return getOrder(prisma, restaurantId, orderId);
}

/** Move the order, never copy its items or dispatch another kitchen ticket. */
export async function transferTable(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  staffId: string,
  orderId: string,
  rawInput: unknown,
  attempt?: IdempotencyAttempt,
): Promise<OrderResponse> {
  const input = transferTableSchema.parse(rawInput);
  try {
    return await withRequestReceipt(
      prisma,
      restaurantId,
      staffId,
      `transfer-table:${orderId}`,
      input,
      attempt,
      async (tx) => {
        const order = await tx.order.findFirst({
          where: { id: orderId, restaurantId },
          select: {
            id: true,
            orderNumber: true,
            type: true,
            tableId: true,
            status: true,
            closedAt: true,
            table: { select: { name: true } },
          },
        });
        if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'That order no longer exists.');
        if (order.type !== 'DINE_IN' || order.tableId === null || order.table === null) {
          throw new ApiError(
            409,
            'DINE_IN_REQUIRED',
            'Only a dine-in order can move between tables.',
          );
        }
        if (order.closedAt !== null || (order.status !== 'DRAFT' && order.status !== 'OPEN')) {
          throw new ApiError(
            409,
            'ORDER_NOT_TRANSFERABLE',
            'Only an unbilled, open order can move tables.',
          );
        }
        if ((await tx.invoice.count({ where: { orderId } })) > 0) {
          throw new ApiError(
            409,
            'ORDER_ALREADY_BILLED',
            'This order has already had a bill issued. Move tables before issuing the first bill.',
          );
        }
        if (input.toTableId === order.tableId)
          throw new ApiError(409, 'SAME_TABLE', 'Choose a different table.');
        const destination = await tx.restaurantTable.findFirst({
          where: { id: input.toTableId, restaurantId },
          select: { id: true, name: true, isActive: true, area: { select: { isActive: true } } },
        });
        if (!destination)
          throw new ApiError(404, 'TABLE_NOT_FOUND', 'That table no longer exists.');
        if (!destination.isActive || !destination.area.isActive)
          throw new ApiError(
            409,
            'TABLE_INACTIVE',
            'That table is out of service. Choose an active table.',
          );
        if (
          (await tx.order.count({
            where: { restaurantId, tableId: destination.id, closedAt: null },
          })) > 0
        ) {
          throw transferOccupied();
        }
        await claimVersion(tx, orderId, input.expectedVersion);
        await tx.order.update({ where: { id: orderId }, data: { tableId: destination.id } });
        await tx.orderTableTransfer.create({
          data: {
            restaurantId,
            orderId,
            orderNumber: order.orderNumber,
            fromTableId: order.tableId,
            toTableId: destination.id,
            fromTableName: order.table.name,
            toTableName: destination.name,
            staffId,
          },
        });
        const updated = await tx.order.findFirstOrThrow({
          where: { id: orderId },
          select: ORDER_SELECT,
        });
        return { order: toOrderDto(updated) };
      },
    );
  } catch (error: unknown) {
    // The partial unique index also protects transfers racing a first item or another move.
    if (isActiveOrderIndexViolation(error)) throw transferOccupied();
    throw error;
  }
}

function transferOccupied(): ApiError {
  return new ApiError(
    409,
    'TABLE_OCCUPIED',
    'That table already has an open order. Refresh the floor and choose an available table.',
  );
}
