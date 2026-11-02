import type { NayaroPrismaClient, TenantStatus } from '@nayaro/database';
import type { TenantSummary } from '@nayaro/shared';
import { ApiError } from '../../utils/apiError';
import { hashPassword } from '../auth/password';
import { registerTenantSchema, type RegisterTenantInput } from './tenant.schema';

/**
 * Settings every new restaurant starts with. Money-affecting switches (VAT,
 * service charge, abbreviated invoices) start OFF: turning them on is a claim
 * about the business that only its owner can make.
 */
export const NEW_TENANT_SETTINGS = {
  currencyCode: 'NPR',
  timezone: 'Asia/Kathmandu',
  businessDayStartsAtMinutes: 240,
  roundGrandTotalToRupee: true,

  vatEnabled: false,
  vatRateBp: 1300,

  serviceChargeEnabled: false,
  serviceChargeRateBp: 1000,
  serviceChargeAppliesToTakeaway: false,

  defaultInvoiceType: 'STANDARD',
  abbreviatedInvoiceAuthorized: false,
  abbreviatedInvoiceCeilingPaisa: 1_000_000,
  invoicePrefix: 'INV',
} as const;

export const TRIAL_DAYS = 14;

export interface RegisterTenantResult {
  readonly restaurantId: string;
  readonly restaurantName: string;
  readonly workspace: string;
  readonly ownerStaffId: string;
  readonly ownerUsername: string;
}

/** Why a tenant may not operate right now, or null when it may. */
export type TenantBlock = 'TENANT_SUSPENDED' | 'SUBSCRIPTION_EXPIRED';

export interface TenantAccessFields {
  readonly isActive: boolean;
  readonly status: TenantStatus;
  readonly subscriptionEndsAt: Date | null;
}

export function tenantBlock(tenant: TenantAccessFields, now = new Date()): TenantBlock | null {
  if (!tenant.isActive || tenant.status === 'SUSPENDED' || tenant.status === 'CANCELLED') {
    return 'TENANT_SUSPENDED';
  }
  if (tenant.subscriptionEndsAt !== null && tenant.subscriptionEndsAt.getTime() <= now.getTime()) {
    return 'SUBSCRIPTION_EXPIRED';
  }
  return null;
}

export function tenantBlockedError(block: TenantBlock): ApiError {
  return block === 'SUBSCRIPTION_EXPIRED'
    ? new ApiError(
        403,
        'SUBSCRIPTION_EXPIRED',
        'This restaurant’s subscription has ended. Contact Nayaro Technology to renew.',
      )
    : new ApiError(
        403,
        'TENANT_SUSPENDED',
        'This restaurant’s account is not active. Contact Nayaro Technology for help.',
      );
}

/**
 * Creates a restaurant, its settings, its counters and its first owner in one
 * transaction. A half-created tenant - a restaurant with no owner, or an owner
 * with no settings - would be impossible to sign in to or to bill from.
 */
export async function registerTenant(
  prisma: NayaroPrismaClient,
  rawInput: unknown,
  options: { readonly trialDays?: number; readonly status?: TenantStatus } = {},
): Promise<RegisterTenantResult> {
  const input: RegisterTenantInput = registerTenantSchema.parse(rawInput);
  const passwordHash = await hashPassword(input.owner.password);
  const settings = { ...NEW_TENANT_SETTINGS, ...(input.settings ?? {}) };
  const trialDays = options.trialDays ?? TRIAL_DAYS;
  const status = options.status ?? 'TRIAL';

  return prisma.$transaction(async (tx) => {
    const taken = await tx.restaurant.findUnique({
      where: { slug: input.restaurant.slug },
      select: { id: true },
    });
    if (taken) {
      throw new ApiError(
        409,
        'WORKSPACE_TAKEN',
        'That workspace code is already in use. Choose another.',
      );
    }

    const restaurant = await tx.restaurant.create({
      data: {
        slug: input.restaurant.slug,
        name: input.restaurant.name,
        address: input.restaurant.address ?? '',
        phone: input.restaurant.phone ?? '',
        panNumber: input.restaurant.panNumber ?? '',
        contactEmail: input.restaurant.contactEmail || null,
        status,
        subscriptionEndsAt:
          status === 'TRIAL' ? new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000) : null,
      },
    });

    await tx.restaurantSettings.create({
      data: {
        restaurantId: restaurant.id,
        currencyCode: settings.currencyCode,
        timezone: settings.timezone,
        businessDayStartsAtMinutes: settings.businessDayStartsAtMinutes,
        roundGrandTotalToRupee: settings.roundGrandTotalToRupee,
        vatEnabled: settings.vatEnabled,
        vatRateBp: settings.vatRateBp,
        serviceChargeEnabled: settings.serviceChargeEnabled,
        serviceChargeRateBp: settings.serviceChargeRateBp,
        serviceChargeAppliesToTakeaway: settings.serviceChargeAppliesToTakeaway,
        defaultInvoiceType: settings.defaultInvoiceType,
        abbreviatedInvoiceAuthorized: settings.abbreviatedInvoiceAuthorized,
        abbreviatedInvoiceCeilingPaisa: settings.abbreviatedInvoiceCeilingPaisa,
        invoicePrefix: settings.invoicePrefix,
      },
    });

    const owner = await tx.staff.create({
      data: {
        restaurantId: restaurant.id,
        name: input.owner.name,
        username: input.owner.username,
        passwordHash,
        role: 'OWNER',
        isActive: true,
      },
    });

    await tx.restaurantCounter.createMany({
      data: [
        { restaurantId: restaurant.id, name: 'ORDER', nextValue: 1 },
        { restaurantId: restaurant.id, name: 'KOT', nextValue: 1 },
      ],
    });

    return {
      restaurantId: restaurant.id,
      restaurantName: restaurant.name,
      workspace: restaurant.slug,
      ownerStaffId: owner.id,
      ownerUsername: owner.username,
    };
  });
}

export async function getTenantSummary(
  prisma: NayaroPrismaClient,
  restaurantId: string,
): Promise<TenantSummary> {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: restaurantId },
    select: {
      id: true,
      slug: true,
      name: true,
      status: true,
      plan: true,
      subscriptionEndsAt: true,
    },
  });
  if (!restaurant) throw new ApiError(404, 'TENANT_NOT_FOUND', 'Restaurant not found.');
  return {
    id: restaurant.id,
    workspace: restaurant.slug,
    name: restaurant.name,
    status: restaurant.status,
    plan: restaurant.plan,
    subscriptionEndsAt: restaurant.subscriptionEndsAt?.toISOString() ?? null,
  };
}

/**
 * Public: the display name behind a workspace code, so the sign-in screen can
 * confirm "Signing in to Himalayan Kitchen". Returns the same 404 for an
 * unknown code and for a tenant that cannot operate.
 */
export async function lookupWorkspace(
  prisma: NayaroPrismaClient,
  workspace: string,
): Promise<{ readonly workspace: string; readonly name: string }> {
  const restaurant = await prisma.restaurant.findUnique({
    where: { slug: workspace },
    select: { slug: true, name: true, isActive: true, status: true, subscriptionEndsAt: true },
  });
  if (!restaurant || tenantBlock(restaurant) !== null) {
    throw new ApiError(404, 'WORKSPACE_NOT_FOUND', 'No active restaurant uses that workspace code.');
  }
  return { workspace: restaurant.slug, name: restaurant.name };
}

/** Platform administration: used by the operator CLI, never exposed to tenants. */
export async function setTenantStatus(
  prisma: NayaroPrismaClient,
  workspace: string,
  change: {
    readonly status: TenantStatus;
    readonly subscriptionEndsAt?: Date | null;
    readonly reason?: string;
  },
): Promise<TenantSummary> {
  const restaurant = await prisma.restaurant.findUnique({
    where: { slug: workspace },
    select: { id: true },
  });
  if (!restaurant) throw new ApiError(404, 'TENANT_NOT_FOUND', `No tenant "${workspace}".`);

  await prisma.restaurant.update({
    where: { id: restaurant.id },
    data: {
      status: change.status,
      isActive: change.status !== 'SUSPENDED' && change.status !== 'CANCELLED',
      statusReason: change.reason ?? null,
      ...(change.subscriptionEndsAt === undefined
        ? {}
        : { subscriptionEndsAt: change.subscriptionEndsAt }),
    },
  });
  return getTenantSummary(prisma, restaurant.id);
}
