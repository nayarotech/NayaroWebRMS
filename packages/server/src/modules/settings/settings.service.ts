import type { NayaroPrismaClient } from '@nayaro/database';
import type { SettingsResponse } from '@nayaro/shared';
import { ApiError } from '../../utils/apiError';
import {
  updateFinancialSettingsSchema,
  updateOperationalSettingsSchema,
  updateRestaurantSchema,
} from './settings.schema';

/**
 * Restaurant configuration.
 *
 * WHAT CHANGING THESE DOES, AND DOES NOT DO. Settings are read fresh every time
 * a pre-bill is calculated, so turning VAT on changes the next bill
 * immediately. They are NOT read when displaying an issued invoice: every rate
 * and amount was frozen onto that document at issue, and an owner correcting a
 * rate today must not rewrite what a customer was charged last month. Both
 * halves of that are covered by tests.
 *
 * WHO MAY CHANGE WHAT - the rule chosen for V1:
 *
 *   OWNER    everything.
 *   MANAGER  operational and display settings only (business-day start, bill
 *            footer, what is printed).
 *
 * Tax rates, invoice identity and abbreviated-invoice authorisation are
 * OWNER-only, because each is a claim about the business itself. Enabling VAT
 * asserts the restaurant is VAT-registered; enabling abbreviated invoices
 * asserts the tax office authorised it. A manager should not be able to make
 * either claim on the owner's behalf.
 */

export async function getSettings(
  prisma: NayaroPrismaClient,
  restaurantId: string,
): Promise<SettingsResponse> {
  const restaurant = await prisma.restaurant.findFirst({
    where: { id: restaurantId },
    select: {
      name: true,
      address: true,
      phone: true,
      panNumber: true,
      settings: {
        select: {
          vatEnabled: true,
          vatRateBp: true,
          serviceChargeEnabled: true,
          serviceChargeRateBp: true,
          serviceChargeAppliesToTakeaway: true,
          roundGrandTotalToRupee: true,
          defaultInvoiceType: true,
          abbreviatedInvoiceAuthorized: true,
          abbreviatedInvoiceCeilingPaisa: true,
          businessDayStartsAtMinutes: true,
          kitchenNewTicketAlertMinutes: true,
          customerMenuEnabled: true,
          printPanOnBill: true,
          showBsDateOnBill: true,
          billFooterText: true,
          updatedAt: true,
          updatedByStaff: { select: { name: true } },
        },
      },
    },
  });
  if (!restaurant?.settings) {
    throw new ApiError(500, 'SETTINGS_MISSING', 'This restaurant has no settings.');
  }
  const s = restaurant.settings;

  return {
    restaurant: {
      name: restaurant.name,
      address: restaurant.address,
      phone: restaurant.phone,
      panNumber: restaurant.panNumber,
    },
    financial: {
      vatEnabled: s.vatEnabled,
      vatRateBp: s.vatRateBp,
      serviceChargeEnabled: s.serviceChargeEnabled,
      serviceChargeRateBp: s.serviceChargeRateBp,
      serviceChargeAppliesToTakeaway: s.serviceChargeAppliesToTakeaway,
      roundGrandTotalToRupee: s.roundGrandTotalToRupee,
      defaultInvoiceType: s.defaultInvoiceType,
      abbreviatedInvoiceAuthorized: s.abbreviatedInvoiceAuthorized,
      abbreviatedInvoiceCeilingPaisa: s.abbreviatedInvoiceCeilingPaisa,
    },
    operational: {
      customerMenuEnabled: s.customerMenuEnabled,
      businessDayStartsAtMinutes: s.businessDayStartsAtMinutes,
      kitchenNewTicketAlertMinutes: s.kitchenNewTicketAlertMinutes,
      printPanOnBill: s.printPanOnBill,
      showBsDateOnBill: s.showBsDateOnBill,
      billFooterText: s.billFooterText,
    },
    updatedAt: s.updatedAt.toISOString(),
    updatedBy: s.updatedByStaff?.name ?? null,
  };
}

/**
 * Restaurant identity.
 *
 * These are printed on every invoice as the SELLER. Invoices issued from
 * Phase 4H onward snapshot them at issue (`Invoice.sellerName/Address/Pan`),
 * so correcting a typo here changes future documents only - which is why the
 * columns were added. Invoices issued before that snapshot existed have no
 * seller recorded, and reprinting one can only show what it stored: nothing.
 */
export async function updateRestaurant(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  staffId: string,
  rawInput: unknown,
): Promise<SettingsResponse> {
  const input = updateRestaurantSchema.parse(rawInput);

  await prisma.$transaction(async (tx) => {
    await tx.restaurant.update({
      where: { id: restaurantId },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.address === undefined ? {} : { address: input.address }),
        ...(input.phone === undefined ? {} : { phone: input.phone }),
        ...(input.panNumber === undefined ? {} : { panNumber: input.panNumber }),
      },
    });
    await touch(tx, restaurantId, staffId);
  });

  return getSettings(prisma, restaurantId);
}

export async function updateFinancialSettings(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  staffId: string,
  rawInput: unknown,
): Promise<SettingsResponse> {
  const input = updateFinancialSettingsSchema.parse(rawInput);

  await prisma.restaurantSettings.update({
    where: { restaurantId },
    data: { ...pick(input), updatedByStaffId: staffId },
  });
  return getSettings(prisma, restaurantId);
}

export async function updateOperationalSettings(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  staffId: string,
  rawInput: unknown,
): Promise<SettingsResponse> {
  const input = updateOperationalSettingsSchema.parse(rawInput);

  await prisma.restaurantSettings.update({
    where: { restaurantId },
    data: {
      ...pick(input),
      ...(input.billFooterText === undefined
        ? {}
        : { billFooterText: normaliseOptional(input.billFooterText) }),
      updatedByStaffId: staffId,
    },
  });
  return getSettings(prisma, restaurantId);
}

type Tx = Parameters<Parameters<NayaroPrismaClient['$transaction']>[0]>[0];

async function touch(tx: Tx, restaurantId: string, staffId: string): Promise<void> {
  await tx.restaurantSettings.update({
    where: { restaurantId },
    data: { updatedByStaffId: staffId },
  });
}

/**
 * Only defined keys, and only ones the schema validated. Never `...req.body`:
 * a spread would happily carry `restaurantId` or an unknown column straight
 * into the update.
 */
function pick<T extends Record<string, unknown>>(input: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined && key !== 'billFooterText') out[key] = value;
  }
  return out as Partial<T>;
}

function normaliseOptional(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
