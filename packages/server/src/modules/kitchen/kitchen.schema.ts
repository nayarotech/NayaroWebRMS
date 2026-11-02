import { z } from 'zod';
import { correctionSchema } from '../../utils/correction';

/**
 * Kitchen input validation.
 *
 * The enum is the state machine's vocabulary, not the whole KotStatus enum:
 * NEW is where a ticket starts and cannot be returned to, and VOID is a
 * separate manager path with different consequences (it returns quantities to
 * undispatched). Neither is a move a cook can ask for, so neither is accepted
 * here - the schema refuses them before any service logic runs.
 */
export const transitionKotSchema = z.object({
  status: z.enum(['PREPARING', 'READY', 'SERVED']),
});

export type TransitionKotInput = z.infer<typeof transitionKotSchema>;

/** Void carries only a reason; the ticket id is in the path. */
export const voidKotSchema = correctionSchema;
