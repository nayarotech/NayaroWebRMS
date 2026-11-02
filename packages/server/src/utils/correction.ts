import { z } from 'zod';

/**
 * The reason attached to every correction, in one place.
 *
 * Four different operations reverse something a person did - a dispatch, an
 * item, a bill, a payment - and all four are only auditable if the reason is
 * real text. Trimmed before the length check, so a space bar cannot satisfy
 * it. The limit is generous: whoever writes this is explaining themselves to
 * somebody reading it months later with no other context.
 *
 * It lives in utils rather than in one module's schema because no module owns
 * corrections, and importing kitchen's validator into orders would say the
 * kitchen did.
 */
export const correctionReason = z
  .string()
  .trim()
  .min(3, 'Say briefly why. This is the only record of it.')
  .max(300);

/** Every correction request body, before the operation adds its own fields. */
export const correctionSchema = z.object({ reason: correctionReason });
