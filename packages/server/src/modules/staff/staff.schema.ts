import { z } from 'zod';

/**
 * Staff and password validation.
 *
 * The password rule is deliberately a LENGTH rule and nothing else. Composition
 * requirements ("one capital, one symbol") reliably produce `Password1!` on a
 * sticky note beside the till, which is worse than a longer passphrase somebody
 * can actually remember. Eight characters is the floor; the field accepts a
 * sentence.
 */
const password = z
  .string()
  .min(8, 'A password needs at least 8 characters.')
  .max(200, 'That password is too long.');

/**
 * Usernames are typed at a busy counter, so they are lowercased and restricted
 * to characters that cannot be confused or invisibly duplicated. "Ram" and
 * "ram" must not be two accounts.
 */
const username = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, 'A username needs at least 3 characters.')
  .max(32, 'That username is too long.')
  .regex(/^[a-z0-9][a-z0-9._-]*$/, 'Use letters, numbers, dots, dashes or underscores.');

const name = z.string().trim().min(1, 'A name is required.').max(80, 'That name is too long.');
const role = z.enum(['OWNER', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN']);

export const createStaffSchema = z.object({
  name,
  username,
  password,
  role,
  canTakeOrders: z.boolean().optional(),
  canManageKitchen: z.boolean().optional(),
});

export const updateStaffSchema = z
  .object({
    name: name.optional(),
    role: role.optional(),
    canTakeOrders: z.boolean().optional(),
    canManageKitchen: z.boolean().optional(),
    isActive: z.boolean().optional(),
    // Note what cannot be changed: username. It appears in nobody's history,
    // but it is how a person signs in, and silently renaming a login is how a
    // shift starts with somebody locked out.
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update.' });

export const changeOwnPasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password.'),
    newPassword: password,
  })
  .refine((value) => value.currentPassword !== value.newPassword, {
    message: 'The new password must be different from the current one.',
  });

export const resetPasswordSchema = z.object({ newPassword: password });
