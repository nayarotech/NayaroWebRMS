import type { NayaroPrismaClient } from '@nayaro/database';
import type { Request } from 'express';
import { z } from 'zod';
import type { Logger } from '../../utils/logger';
import { clientAddress } from '../../utils/clientAddress';

export type AuditAction =
  | 'AUTH_LOGIN'
  | 'AUTH_LOGIN_FAILED'
  | 'AUTH_LOGOUT'
  | 'AUTH_PASSWORD_CHANGED'
  | 'TENANT_REGISTERED'
  | 'PLATFORM_ACCOUNT_CHANGED'
  | 'SUPPORT_VIEW_STARTED'
  | 'STAFF_CREATED'
  | 'STAFF_UPDATED'
  | 'STAFF_PASSWORD_RESET'
  | 'SETTINGS_RESTAURANT_UPDATED'
  | 'SETTINGS_FINANCIAL_UPDATED'
  | 'SETTINGS_OPERATIONAL_UPDATED'
  | 'INVOICE_VOIDED'
  | 'ORDER_VOIDED'
  | 'PAYMENT_REFUNDED'
  | 'DATA_EXPORTED';

export interface AuditEntry {
  readonly restaurantId: string;
  readonly staffId?: string | null;
  readonly action: AuditAction;
  readonly summary: string;
  readonly entityType?: string;
  readonly entityId?: string;
  readonly metadata?: Record<string, string | number | boolean | null>;
  readonly ipAddress?: string | null;
}

type AuditWriter = Pick<NayaroPrismaClient, 'auditLog'>;

/**
 * Writes one audit row. A failed audit write is logged but never fails the
 * operation it describes: the business action has already committed, and
 * reporting it as failed would invite a duplicate retry.
 */
export async function recordAudit(
  prisma: AuditWriter,
  entry: AuditEntry,
  logger?: Logger,
): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        restaurantId: entry.restaurantId,
        staffId: entry.staffId ?? null,
        action: entry.action,
        summary: entry.summary.slice(0, 500),
        entityType: entry.entityType ?? null,
        entityId: entry.entityId ?? null,
        metadata: entry.metadata === undefined ? null : JSON.stringify(entry.metadata),
        ipAddress: entry.ipAddress ?? null,
      },
    });
  } catch (error: unknown) {
    logger?.error(`Could not record audit event ${entry.action}`, error);
  }
}

/** Audit entry for the authenticated caller of a request. */
export function auditFromRequest(
  prisma: AuditWriter,
  req: Request,
  entry: Omit<AuditEntry, 'restaurantId' | 'staffId' | 'ipAddress'>,
  logger?: Logger,
): Promise<void> {
  if (!req.auth) return Promise.resolve();
  return recordAudit(
    prisma,
    {
      ...entry,
      restaurantId: req.auth.staff.restaurantId,
      staffId: req.auth.staff.id,
      ipAddress: clientAddress(req),
    },
    logger,
  );
}

const listQuerySchema = z.object({
  action: z.string().trim().max(64).optional(),
  before: z.string().trim().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function listAuditLog(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  rawQuery: unknown,
) {
  const query = listQuerySchema.parse(rawQuery);
  const rows = await prisma.auditLog.findMany({
    where: {
      restaurantId,
      ...(query.action ? { action: query.action } : {}),
      ...(query.before ? { createdAt: { lt: new Date(query.before) } } : {}),
    },
    orderBy: { createdAt: 'desc' },
    take: query.limit + 1,
    select: {
      id: true,
      action: true,
      summary: true,
      entityType: true,
      entityId: true,
      ipAddress: true,
      createdAt: true,
      staff: { select: { name: true, username: true, role: true } },
    },
  });
  const hasMore = rows.length > query.limit;
  const entries = rows.slice(0, query.limit).map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
  }));
  return { entries, hasMore };
}
