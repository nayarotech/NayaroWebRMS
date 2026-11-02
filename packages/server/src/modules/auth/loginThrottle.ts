/**
 * Slowing down password guessing on POST /auth/login.
 *
 * The server binds 0.0.0.0, so the login form is reachable from anything on
 * the restaurant's wifi - including guests - and staff usernames are first
 * names. scrypt makes each guess cost ~80ms; this makes a sustained run of
 * them cost hours.
 *
 * TWO LIMITS, keyed so the obvious abuse of each does not work:
 *
 *   address + username   a few free mistakes, then an exponentially growing
 *                        wait. Keyed on the address TOO, so a guest hammering
 *                        "rajan.s" from a phone locks out that phone only - not
 *                        the owner standing at the till. Locking a username
 *                        everywhere would hand anyone on the wifi a button
 *                        that stops the owner signing in.
 *
 *   address alone        a ceiling across every username, so one device
 *                        cannot sidestep the first limit by cycling names.
 *
 * Neither depends on whether the username exists, so a lockout is not a
 * username oracle. A lock is applied BEFORE the password is checked, so a
 * locked caller learns nothing - not even when they finally guessed right.
 *
 * In memory, deliberately. A restart clears it, which is fine: restarting the
 * till is not something an attacker on the wifi can do, and a durable table
 * would be one more thing to migrate for no real gain.
 */

export interface LoginThrottleOptions {
  /** Failures allowed per address + username before waits begin. */
  readonly freeFailures?: number;
  /** The first wait. Each further failure doubles it. */
  readonly baseLockMs?: number;
  readonly maxLockMs?: number;
  /** Failures allowed per address, across all usernames, in one window. */
  readonly addressFailureLimit?: number;
  /** The address window, and how long a quiet username counter is remembered. */
  readonly windowMs?: number;
  /** Injectable clock, for tests. */
  readonly now?: () => number;
}

interface PairState {
  failures: number;
  lastFailureAt: number;
  lockedUntil: number;
}

interface AddressState {
  failures: number;
  windowStartedAt: number;
}

/** Bounds memory if something floods the endpoint with made-up usernames. */
const MAX_TRACKED = 10_000;

export class LoginThrottle {
  private readonly freeFailures: number;
  private readonly baseLockMs: number;
  private readonly maxLockMs: number;
  private readonly addressFailureLimit: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  private readonly pairs = new Map<string, PairState>();
  private readonly addresses = new Map<string, AddressState>();

  constructor(options: LoginThrottleOptions = {}) {
    // Ten is generous for a person - nobody mistypes ten times running - and
    // leaves room for a till where several staff share one address.
    this.freeFailures = options.freeFailures ?? 10;
    this.baseLockMs = options.baseLockMs ?? 30 * 1000;
    this.maxLockMs = options.maxLockMs ?? 15 * 60 * 1000;
    this.addressFailureLimit = options.addressFailureLimit ?? 50;
    this.windowMs = options.windowMs ?? 15 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  /** Milliseconds the caller must wait, or null when they may try now. */
  retryAfterMs(address: string, username: string): number | null {
    const now = this.now();
    let wait = 0;

    const pair = this.livePair(pairKey(address, username), now);
    if (pair !== undefined && pair.lockedUntil > now) wait = pair.lockedUntil - now;

    const byAddress = this.liveAddress(address, now);
    if (byAddress !== undefined && byAddress.failures >= this.addressFailureLimit) {
      wait = Math.max(wait, byAddress.windowStartedAt + this.windowMs - now);
    }

    return wait > 0 ? wait : null;
  }

  /** Records a wrong password (or unknown username - the two are not told apart). */
  recordFailure(address: string, username: string): void {
    const now = this.now();
    this.makeRoom(now);

    const key = pairKey(address, username);
    const pair = this.livePair(key, now) ?? { failures: 0, lastFailureAt: now, lockedUntil: 0 };
    pair.failures += 1;
    pair.lastFailureAt = now;
    const beyond = pair.failures - this.freeFailures;
    if (beyond > 0) {
      pair.lockedUntil = now + Math.min(this.maxLockMs, this.baseLockMs * 2 ** (beyond - 1));
    }
    this.pairs.set(key, pair);

    const byAddress = this.liveAddress(address, now) ?? { failures: 0, windowStartedAt: now };
    byAddress.failures += 1;
    this.addresses.set(address, byAddress);
  }

  /**
   * A correct password clears that username's count from that address. The
   * address-wide count is left alone: one good login in the middle of a run
   * of guesses at other names should not reset the run.
   */
  recordSuccess(address: string, username: string): void {
    this.pairs.delete(pairKey(address, username));
  }

  /** A pair counter is forgotten once it has been quiet for a window and is not locked. */
  private livePair(key: string, now: number): PairState | undefined {
    const pair = this.pairs.get(key);
    if (pair === undefined) return undefined;
    if (pair.lockedUntil <= now && now - pair.lastFailureAt > this.windowMs) {
      this.pairs.delete(key);
      return undefined;
    }
    return pair;
  }

  private liveAddress(address: string, now: number): AddressState | undefined {
    const state = this.addresses.get(address);
    if (state === undefined) return undefined;
    if (now - state.windowStartedAt > this.windowMs) {
      this.addresses.delete(address);
      return undefined;
    }
    return state;
  }

  private makeRoom(now: number): void {
    if (this.pairs.size < MAX_TRACKED && this.addresses.size < MAX_TRACKED) return;
    for (const key of [...this.pairs.keys()]) this.livePair(key, now);
    for (const key of [...this.addresses.keys()]) this.liveAddress(key, now);
    // Still full of live entries: drop the oldest. Maps iterate in insertion order.
    while (this.pairs.size >= MAX_TRACKED) {
      const oldest = this.pairs.keys().next().value;
      if (oldest === undefined) break;
      this.pairs.delete(oldest);
    }
    while (this.addresses.size >= MAX_TRACKED) {
      const oldest = this.addresses.keys().next().value;
      if (oldest === undefined) break;
      this.addresses.delete(oldest);
    }
  }
}

function pairKey(address: string, username: string): string {
  return `${address}\u0000${username}`;
}

/** "45 seconds", "3 minutes" - for a person reading the login screen. */
export function describeWait(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${String(seconds)} second${seconds === 1 ? '' : 's'}`;
  const minutes = Math.ceil(seconds / 60);
  return `${String(minutes)} minute${minutes === 1 ? '' : 's'}`;
}
