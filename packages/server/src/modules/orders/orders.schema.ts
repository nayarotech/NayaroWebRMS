import { z } from 'zod';
import { correctionReason } from '../../utils/correction';

/**
 * Order input validation.
 *
 * As with the floor, restaurantId appears nowhere: it comes from the session.
 * Neither does staffId - the server records who is signed in, not who the
 * client claims to be.
 */

/** Free text a cook has to read off a ticket. Long enough to be useful, short
 * enough to print. */
const note = z.string().trim().max(120, 'Note is too long.');

const quantity = z
  .int()
  .min(1, 'Quantity must be at least 1. Remove the item instead of setting it to zero.')
  .max(99, 'That is more than one order can hold.');

/** Zero is a legitimate version: an order created but not yet re-edited. */
const expectedVersion = z.int().min(0);

const id = z.string().min(1);

/**
 * TABLE and TAKEAWAY carry no version because there is nothing to version yet -
 * these are the create cases. ORDER carries one because it is an edit. Making
 * this a discriminated union means "an orderId without a version" is not a
 * request that can be built.
 */
export const addOrderItemTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('TABLE'), tableId: id }),
  z.object({ kind: z.literal('TAKEAWAY') }),
  z.object({ kind: z.literal('ORDER'), orderId: id, expectedVersion }),
]);

export const addOrderItemSchema = z.object({
  target: addOrderItemTargetSchema,
  menuItemId: id,
  quantity: quantity.optional(),
  note: note.optional(),
});

export const updateOrderItemSchema = z
  .object({
    expectedVersion,
    quantity: quantity.optional(),
    // Explicit null clears the note; omitting the field leaves it alone. The
    // two are different intentions and the API keeps them different.
    note: note.nullable().optional(),
  })
  .refine((value) => value.quantity !== undefined || value.note !== undefined, {
    message: 'Nothing to update.',
  });

/** Sending carries no payload beyond the version it believes it is sending. */
export const sendToKitchenSchema = z.object({ expectedVersion });

/** DELETE carries no body, so the version rides in the query string. */
export const removeOrderItemSchema = z.object({
  expectedVersion: z.coerce.number().int().min(0),
});

/**
 * Cancelling dispatched units.
 *
 * No expected version. The service reads the line's dispatched and cancelled
 * totals inside the same transaction that writes the cancellation and
 * compare-and-swaps the order version it read, so a stale client cannot
 * over-cancel - it can only be refused.
 */
export const cancelOrderItemSchema = z.object({
  quantity,
  reason: correctionReason,
});

export type AddOrderItemInput = z.infer<typeof addOrderItemSchema>;
export type UpdateOrderItemInput = z.infer<typeof updateOrderItemSchema>;

export const transferTableSchema = z.object({ expectedVersion, toTableId: id });
