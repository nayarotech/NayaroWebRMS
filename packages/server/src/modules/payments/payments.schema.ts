import { z } from 'zod';

/**
 * Payment input validation.
 *
 * NOTHING about card details appears here, and nothing ever should. Nayaro RMS
 * records that a card was used and an optional reference from the terminal
 * receipt; it never sees, asks for or stores a card number or CVV. A POS that
 * does not hold card data cannot leak it.
 */

const paisa = z.int().min(1).max(1_000_000_000);
const expectedOrderVersion = z.int().min(0);

export const recordPaymentSchema = z
  .object({
    expectedOrderVersion,
    method: z.enum(['CASH', 'QR', 'CARD', 'CREDIT']),
    amountPaisa: paisa,
    items: z
      .array(
        z.object({
          invoiceLineId: z.string().min(1),
          quantity: z.int().min(1).max(1_000_000),
        }),
      )
      .min(1)
      .max(500)
      .optional(),
    tenderedPaisa: paisa.optional(),
    reference: z.string().trim().max(80).optional(),
    customerId: z.string().min(1).optional(),
    creditAccountName: z.string().trim().max(120).optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.items &&
      new Set(value.items.map((item) => item.invoiceLineId)).size !== value.items.length
    ) {
      ctx.addIssue({ code: 'custom', message: 'Choose each invoice line only once.' });
    }
    if (value.method === 'CREDIT' && !value.customerId) {
      ctx.addIssue({ code: 'custom', message: 'Choose a customer account for this credit sale.' });
    }
    if (value.method !== 'CREDIT' && value.customerId !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'Only a credit sale has a customer account.' });
    }
    // Tender is a cash concept. A "tendered" amount on a card payment would be
    // noise in the financial history that nobody could later interpret.
    if (value.tenderedPaisa !== undefined) {
      if (value.method !== 'CASH') {
        ctx.addIssue({ code: 'custom', message: 'Only a cash payment has an amount tendered.' });
      } else if (value.tenderedPaisa < value.amountPaisa) {
        ctx.addIssue({
          code: 'custom',
          message: 'The cash received is less than the amount being paid.',
        });
      }
    }
    if (value.creditAccountName !== undefined && value.method !== 'CREDIT') {
      ctx.addIssue({ code: 'custom', message: 'Only a credit sale records an account name.' });
    }
  });

export const settleInvoiceSchema = z.object({ expectedOrderVersion });

export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;
