import { z } from 'zod';

/**
 * Billing input validation.
 *
 * Note what is not here: amounts. A client never sends a total, a tax figure or
 * a line price - it sends what the cashier chose (a discount, a buyer, an
 * invoice type) and the server calculates the money. A bill assembled from
 * client-supplied numbers is a bill anyone can rewrite.
 */

const expectedVersion = z.int().min(0);

/** Basis points: 0..10000 is 0%..100%. */
const basisPoints = z.int().min(0).max(10000);
const paisa = z.int().min(0).max(1_000_000_000);

export const setDiscountSchema = z
  .object({
    expectedVersion,
    discountType: z.enum(['NONE', 'PERCENT', 'FIXED']),
    discountValue: z.int().min(0).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.discountType === 'NONE') return;
    if (value.discountValue === undefined) {
      ctx.addIssue({ code: 'custom', message: 'A discount amount is required.' });
      return;
    }
    const bounded =
      value.discountType === 'PERCENT'
        ? basisPoints.safeParse(value.discountValue)
        : paisa.safeParse(value.discountValue);
    if (!bounded.success) {
      ctx.addIssue({
        code: 'custom',
        message:
          value.discountType === 'PERCENT'
            ? 'A percentage discount must be between 0% and 100%.'
            : 'That discount amount is out of range.',
      });
    }
  });

/**
 * Buyer details, all optional.
 *
 * The PAN check is a FORMAT check - Nepali PAN numbers are nine digits, so this
 * catches a typo at the counter. It is not a check against any registry and
 * asserts nothing about the buyer's tax status.
 */
export const issueInvoiceSchema = z.object({
  expectedVersion,
  invoiceType: z.enum(['STANDARD', 'ABBREVIATED']).optional(),
  buyerName: z.string().trim().max(120).optional(),
  buyerPan: z
    .string()
    .trim()
    .regex(/^\d{9}$/, 'A PAN number is nine digits.')
    .optional(),
  buyerAddress: z.string().trim().max(200).optional(),
});

export type SetDiscountInput = z.infer<typeof setDiscountSchema>;
export type IssueInvoiceInput = z.infer<typeof issueInvoiceSchema>;
