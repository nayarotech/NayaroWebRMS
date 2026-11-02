/**
 * Integer money. Every amount in Nayaro RMS is paisa, and every rate is basis
 * points (13% = 1300 bp, 10% = 1000 bp).
 *
 * There is no floating point anywhere in this file, and there must never be.
 * `0.1 + 0.2 !== 0.3` is the reason a till and its own report disagree by a
 * paisa at closing time, and a bill that does not add up is worse than a bill
 * that is slightly wrong - the owner loses trust in the whole system.
 */

/**
 * `base × rateBp / 10000`, rounded half up, in integers throughout.
 *
 * The `+ 5000` is the half: dividing by 10000 with floor after adding half the
 * divisor is round-half-up without ever leaving integer arithmetic.
 *
 *   68000 × 1000bp -> (68_000_000 + 5000) / 10000 = 6800.5 -> 6800
 *   74800 × 1300bp -> (97_240_000 + 5000) / 10000 = 9724.5 -> 9724
 *
 * RANGE: the intermediate is `base × rateBp`. At the maximum sane rate
 * (10000 bp) a base would have to exceed 900 billion paisa - nine billion
 * rupees on one bill - before leaving JavaScript's safe integer range. Asserted
 * below rather than assumed.
 */
export function applyRateBp(basePaisa: number, rateBp: number): number {
  assertSafeInteger(basePaisa, 'basePaisa');
  assertSafeInteger(rateBp, 'rateBp');
  if (basePaisa < 0) throw new RangeError('basePaisa must not be negative');
  if (rateBp < 0) throw new RangeError('rateBp must not be negative');

  const product = basePaisa * rateBp;
  if (!Number.isSafeInteger(product)) {
    throw new RangeError('Amount is too large to calculate exactly');
  }
  return Math.floor((product + 5000) / 10000);
}

/** One rupee, in paisa. The unit whole-rupee rounding snaps to. */
export const PAISA_PER_RUPEE = 100;

export interface RoundedToRupee {
  /** The rounded amount. */
  readonly totalPaisa: number;
  /** rounded - original. Negative when rounding down, positive when up. */
  readonly adjustmentPaisa: number;
}

/**
 * Snaps an amount to the nearest whole rupee, half up.
 *
 *   84524 -> 84500  (adjustment -24)
 *   84560 -> 84600  (adjustment +40)
 *   84550 -> 84600  (adjustment +50)   exact midpoint goes UP
 *
 * Half UP on the midpoint is the choice a customer notices least often in
 * their favour and a cashier can explain: "we round to the nearest rupee".
 * Half-even would be defensible statistically and indefensible at a counter.
 *
 * Totals are never negative (the invoice CHECK enforces it), so this does not
 * need to define behaviour for negative input and refuses it instead of
 * guessing.
 */
export function roundToRupee(totalPaisa: number): RoundedToRupee {
  assertSafeInteger(totalPaisa, 'totalPaisa');
  if (totalPaisa < 0) throw new RangeError('totalPaisa must not be negative');

  const rounded =
    Math.floor((totalPaisa + PAISA_PER_RUPEE / 2) / PAISA_PER_RUPEE) * PAISA_PER_RUPEE;
  return { totalPaisa: rounded, adjustmentPaisa: rounded - totalPaisa };
}

function assertSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`${name} must be a safe integer, received ${String(value)}`);
  }
}
