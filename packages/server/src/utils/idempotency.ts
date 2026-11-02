import { createHash } from 'node:crypto';
import type { Request } from 'express';
import type { NayaroPrismaClient } from '@nayaro/database';
import { ApiError } from './apiError';

export type Transaction = Parameters<Parameters<NayaroPrismaClient['$transaction']>[0]>[0];

/** Request-local state lets routes suppress notifications when replaying a receipt. */
export interface IdempotencyAttempt {
  readonly key: string | undefined;
  replayed: boolean;
}

export function readIdempotencyAttempt(req: Request): IdempotencyAttempt {
  const key = req.get('Idempotency-Key');
  if (key !== undefined && !/^[a-zA-Z0-9_-]{16,128}$/.test(key)) {
    throw new ApiError(400, 'INVALID_REQUEST_KEY', 'The request identifier is invalid.');
  }
  return { key, replayed: false };
}

/** The response and the write are atomic: a crash cannot leave one without the other.
 * Receipts are retained so an old request can never become a new sale after expiry.
 * Failed operations roll back their reservation and may be corrected and tried again.
 */
export async function withRequestReceipt<T>(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  staffId: string,
  operation: string,
  input: unknown,
  attempt: IdempotencyAttempt | undefined,
  work: (tx: Transaction) => Promise<T>,
): Promise<T> {
  const key = attempt?.key;
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ operation, input }))
    .digest('hex');
  return prisma.$transaction(async (tx) => {
    if (key === undefined) return work(tx);
    const identity = { restaurantId, staffId, key };
    // Acquire the SQLite write lock before reading. Concurrent copies serialize,
    // and the loser reads the winner's committed receipt rather than doing work.
    await tx.$executeRaw`INSERT INTO "RequestReceipt" ("restaurantId", "staffId", "key", "requestHash")
      VALUES (${restaurantId}, ${staffId}, ${key}, ${requestHash})
      ON CONFLICT ("restaurantId", "staffId", "key") DO NOTHING`;
    const receipt = await tx.requestReceipt.findUniqueOrThrow({
      where: { restaurantId_staffId_key: identity },
    });
    if (receipt.requestHash !== requestHash) {
      throw new ApiError(
        409,
        'REQUEST_KEY_REUSED',
        'This request identifier belongs to a different action.',
      );
    }
    if (receipt.responseJson !== null) {
      if (attempt) attempt.replayed = true;
      return JSON.parse(receipt.responseJson) as T;
    }
    const result = await work(tx);
    await tx.requestReceipt.update({
      where: { restaurantId_staffId_key: identity },
      data: { responseJson: JSON.stringify(result) },
    });
    return result;
  });
}
