import { z } from 'zod';

const trimmed = z.string().trim();

/**
 * Usernames are unique per restaurant, not per platform: two restaurants can
 * both have a "ram". The same trim and lower-case transform is used at
 * registration, staff creation and sign-in so they can never disagree.
 */
export const usernameSchema = trimmed
  .min(3, 'Username must be at least 3 characters.')
  .max(32)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Username may use letters, numbers, dot, underscore and hyphen only.')
  .transform((value) => value.toLowerCase());

/** Workspace codes that would collide with routes or read as official. */
const RESERVED_WORKSPACES = new Set([
  'admin',
  'api',
  'app',
  'auth',
  'demo-admin',
  'help',
  'login',
  'menu',
  'nayaro',
  'platform',
  'register',
  'root',
  'support',
  'system',
  'www',
]);

export const workspaceSchema = trimmed
  .toLowerCase()
  .min(3, 'Workspace code must be at least 3 characters.')
  .max(40, 'Workspace code must be at most 40 characters.')
  .regex(
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/,
    'Workspace code may use lower-case letters, numbers and hyphens, and cannot start or end with a hyphen.',
  );

export const newWorkspaceSchema = workspaceSchema.refine(
  (value) => !RESERVED_WORKSPACES.has(value),
  'That workspace code is reserved. Choose another.',
);

export const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters.')
  .max(200, 'Password is too long.');

export const registerTenantSchema = z.object({
  restaurant: z.object({
    slug: newWorkspaceSchema,
    name: trimmed.min(1, 'Restaurant name is required.').max(120),
    address: trimmed.max(240).optional(),
    phone: trimmed.max(40).optional(),
    panNumber: trimmed.max(40).optional(),
    contactEmail: z
      .union([z.literal(''), trimmed.toLowerCase().pipe(z.email('Enter a valid email address.'))])
      .optional(),
  }),

  owner: z.object({
    name: trimmed.min(1, 'Owner name is required.').max(120),
    username: usernameSchema,
    password: passwordSchema,
  }),

  settings: z
    .object({
      currencyCode: trimmed.length(3).optional(),
      timezone: trimmed.min(1).max(64).optional(),
      businessDayStartsAtMinutes: z.int().min(0).max(1439).optional(),
      roundGrandTotalToRupee: z.boolean().optional(),

      vatEnabled: z.boolean().optional(),
      vatRateBp: z.int().min(0).max(10000).optional(),

      serviceChargeEnabled: z.boolean().optional(),
      serviceChargeRateBp: z.int().min(0).max(10000).optional(),
      serviceChargeAppliesToTakeaway: z.boolean().optional(),

      invoicePrefix: trimmed.max(16).optional(),
    })
    .optional(),
});

export type RegisterTenantInput = z.infer<typeof registerTenantSchema>;
