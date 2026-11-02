import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

/**
 * Promise wrapper written by hand rather than via `promisify`, which drops the
 * overload that accepts scrypt options - and the options are the entire point.
 */
function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/**
 * Password hashing for Nayaro RMS.
 *
 * scrypt from node:crypto, deliberately - not bcrypt or argon2. Those are
 * native addons, and Phase 2 established what that costs us: no Electron
 * prebuild, no MSVC on the target machine, a dead end at packaging time.
 * scrypt ships inside Node, is a memory-hard KDF designed for exactly this,
 * and adds zero packaging risk.
 *
 * This module is the only place in the codebase that touches password crypto.
 * Nothing else may hash, compare or parse a stored hash.
 */

/**
 * Stored format:
 *
 *   scrypt$<N>$<r>$<p>$<saltBase64>$<hashBase64>
 *
 * The parameters are stored WITH the hash, not assumed. That is the whole
 * point of the format: when hardware improves and we raise N, existing hashes
 * still verify against the parameters they were created with, and can be
 * transparently re-hashed on the user's next successful login.
 *
 * Parameters: N=16384, r=8, p=1 - the long-standing scrypt baseline. Memory
 * cost is 128 * N * r = 16 MiB, which sits inside Node's default 32 MiB
 * scrypt limit, and takes roughly 50-100 ms on a POS-class machine: slow
 * enough to make offline guessing expensive, fast enough that a cashier
 * logging in mid-rush does not notice.
 */
const SCHEME = 'scrypt';
const N = 16384;
const R = 8;
const P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

/** Node's scrypt refuses to allocate beyond maxmem; 128*N*r plus headroom. */
const MAX_MEM = 32 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, KEY_BYTES, { N, r: R, p: P, maxmem: MAX_MEM });

  return [
    SCHEME,
    String(N),
    String(R),
    String(P),
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

/**
 * Verifies a password against a stored hash.
 *
 * Returns false rather than throwing for a malformed or unrecognised stored
 * value. A corrupt hash must fail closed - treating it as "cannot log in" is
 * correct, and turning it into an exception would leak the difference between
 * "wrong password" and "damaged record" to whoever is probing.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parsed = parseStoredHash(storedHash);
  if (!parsed) return false;

  let derived: Buffer;
  try {
    derived = await scrypt(password, parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAX_MEM,
    });
  } catch {
    // Parameters outside what this machine will allocate. Fail closed.
    return false;
  }

  // Constant-time: a length check first, because timingSafeEqual throws on
  // mismatched lengths and that throw would itself be a timing signal.
  if (derived.length !== parsed.hash.length) return false;
  return timingSafeEqual(derived, parsed.hash);
}

/** True when a hash was made with parameters weaker than we now use. */
export function needsRehash(storedHash: string): boolean {
  const parsed = parseStoredHash(storedHash);
  if (!parsed) return true;
  return parsed.N < N || parsed.r < R || parsed.p < P;
}

interface ParsedHash {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly hash: Buffer;
}

function parseStoredHash(stored: string): ParsedHash | null {
  const parts = stored.split('$');
  if (parts.length !== 6) return null;

  const [scheme, rawN, rawR, rawP, rawSalt, rawHash] = parts;
  if (scheme !== SCHEME) return null;

  const parsedN = Number(rawN);
  const parsedR = Number(rawR);
  const parsedP = Number(rawP);
  if (!Number.isInteger(parsedN) || !Number.isInteger(parsedR) || !Number.isInteger(parsedP)) {
    return null;
  }
  if (parsedN <= 1 || parsedR <= 0 || parsedP <= 0) return null;

  const salt = safeBase64(rawSalt ?? '');
  const hash = safeBase64(rawHash ?? '');
  if (!salt || !hash || salt.length === 0 || hash.length === 0) return null;

  return { N: parsedN, r: parsedR, p: parsedP, salt, hash };
}

function safeBase64(value: string): Buffer | null {
  try {
    const buffer = Buffer.from(value, 'base64');
    // Reject input that was not valid base64 at all (Buffer is lenient).
    return buffer.toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '')
      ? buffer
      : null;
  } catch {
    return null;
  }
}
