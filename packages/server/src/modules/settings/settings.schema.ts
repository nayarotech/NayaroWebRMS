import { z } from 'zod';

/**
 * Settings validation.
 *
 * Ranges are enforced here rather than trusted from a form, because these
 * numbers multiply real customers' money. A basis-point typo is the difference
 * between charging 13% and 130%.
 */

/** 0..10000 bp is 0%..100%. Nothing sensible lies outside it. */
const rateBp = z
  .int()
  .min(0, 'A rate cannot be negative.')
  .max(10000, 'A rate cannot be more than 100%.');

export const updateRestaurantSchema = z
  .object({
    name: z.string().trim().min(1, 'A restaurant name is required.').max(120).optional(),
    address: z.string().trim().max(200).optional(),
    phone: z.string().trim().max(40).optional(),
    /**
     * Nepali PAN numbers are nine digits. This is a FORMAT check that catches a
     * typo at setup; it verifies nothing with any registry and asserts nothing
     * about the restaurant's tax status. Empty is allowed - a business that is
     * not registered should not be forced to invent a number.
     */
    panNumber: z
      .string()
      .trim()
      .regex(/^(\d{9})?$/, 'A PAN number is nine digits.')
      .optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update.' });

export const updateFinancialSettingsSchema = z
  .object({
    vatEnabled: z.boolean().optional(),
    vatRateBp: rateBp.optional(),
    serviceChargeEnabled: z.boolean().optional(),
    serviceChargeRateBp: rateBp.optional(),
    serviceChargeAppliesToTakeaway: z.boolean().optional(),
    roundGrandTotalToRupee: z.boolean().optional(),
    defaultInvoiceType: z.enum(['STANDARD', 'ABBREVIATED']).optional(),
    abbreviatedInvoiceAuthorized: z.boolean().optional(),
    /** Up to Rs 10,00,000. The statutory figure can change, so it is editable. */
    abbreviatedInvoiceCeilingPaisa: z.int().min(0).max(100_000_000).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update.' });

export const updateOperationalSettingsSchema = z
  .object({
    customerMenuEnabled: z.boolean().optional(),
    /** Minutes after local midnight. 0..1439; 240 is 04:00. */
    businessDayStartsAtMinutes: z.int().min(0).max(1439, 'That is not a time of day.').optional(),
    kitchenNewTicketAlertMinutes: z.int().min(1).max(60).optional(),
    printPanOnBill: z.boolean().optional(),
    showBsDateOnBill: z.boolean().optional(),
    billFooterText: z.string().trim().max(200).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update.' });
