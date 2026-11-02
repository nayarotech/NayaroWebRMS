import { z } from 'zod';
import { usernameSchema, workspaceSchema } from '../tenant/tenant.schema';

/**
 * Login input. The workspace code names the restaurant; usernames are only
 * unique within one restaurant.
 *
 * The username reuses `usernameSchema` from bootstrap - the same trim and
 * lower-case transform that created the account. If login normalised
 * differently from signup, "Rajan.S" would create an account nobody could
 * log into.
 */
export const loginInputSchema = z.object({
  workspace: workspaceSchema,
  username: usernameSchema,
  password: z.string().min(1).max(200),
  /** Optional hint about which terminal this is, shown in the sessions list. */
  deviceLabel: z.string().trim().max(64).optional(),
});

export type LoginInput = z.infer<typeof loginInputSchema>;
