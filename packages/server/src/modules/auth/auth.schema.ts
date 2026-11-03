import { z } from 'zod';
import { emailSchema, usernameSchema, workspaceSchema } from '../tenant/tenant.schema';

/**
 * Login input. The workspace code names the restaurant; usernames are only
 * unique within one restaurant.
 *
 * The username reuses `usernameSchema` from bootstrap - the same trim and
 * lower-case transform that created the account. If login normalised
 * differently from signup, "Rajan.S" would create an account nobody could
 * log into.
 */
const common = {
  password: z.string().min(1).max(200),
  /** Optional hint about which terminal this is, shown in the sessions list. */
  deviceLabel: z.string().trim().max(64).optional(),
};

/**
 * Either a verified email (unique platform-wide, so no workspace is needed) or
 * a workspace code plus username. Exactly one shape is accepted.
 */
export const loginInputSchema = z.union([
  z.object({ email: emailSchema, workspace: z.undefined().optional(), username: z.undefined().optional(), ...common }),
  z.object({ workspace: workspaceSchema, username: usernameSchema, email: z.undefined().optional(), ...common }),
]);

export type LoginInput = z.infer<typeof loginInputSchema>;
