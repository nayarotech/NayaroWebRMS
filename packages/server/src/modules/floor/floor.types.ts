import type { KotStatus, OrderStatus } from '@nayaro/database';

/**
 * Wire contracts live in @nayaro/shared so the renderer consumes the identical
 * types. Re-exported here so nothing inside this module has to know that.
 */
export type {
  CreateAreaRequest,
  CreateTableRequest,
  FloorArea,
  FloorResponse,
  FloorTable,
  TableStatus,
  UpdateAreaRequest,
  UpdateTableRequest,
} from '@nayaro/shared';

/** The shape the mapper needs from an area query. Internal to this module. */
export interface TableRow {
  readonly id: string;
  readonly name: string;
  readonly capacity: number;
  readonly sortOrder: number;
  readonly isActive: boolean;
}

export interface AreaRow {
  readonly id: string;
  readonly name: string;
  readonly sortOrder: number;
  readonly isActive: boolean;
  readonly tables: readonly TableRow[];
}

/**
 * Everything status derivation needs about the one active order at a table,
 * flattened so the mapper never touches Prisma types.
 */
export interface ActiveOrderSnapshot {
  readonly orderId: string;
  readonly status: OrderStatus;
  readonly hasActiveInvoice: boolean;
  /** Non-VOID KOTs only - a voided ticket must not colour the floor. */
  readonly kotStatuses: readonly KotStatus[];
}
