export { createPrismaClient } from './client';
export type { CreatePrismaClientOptions, NayaroPrismaClient } from './client';

export { applyPendingMigrations } from './migrator';
export type { ApplyMigrationsOptions, MigrationReport } from './migrator';

export { ensureDataLayout, resolveDataLayout, toDatabaseFileUrl, toDatabaseUrl } from './paths';

export {
  applyStagedRestore,
  cancelStagedRestore,
  hasStagedRestore,
  RestoreRejectedError,
  stageRestore,
} from './restore';
export type { AppliedRestore } from './restore';
export type { NayaroDataLayout } from './paths';

export {
  assertDatabaseIntegrity,
  findMissingCheckConstraints,
  DatabaseIntegrityError,
  REQUIRED_CHECK_CONSTRAINTS,
} from './integrity';
export type { MissingCheckConstraint } from './integrity';

/**
 * Domain enums, re-exported from the generated client.
 *
 * Consumers import StaffRole/OrderStatus/... from `@nayaro/database` rather
 * than reaching into `src/generated/prisma`, so the generated output stays an
 * implementation detail of this package.
 */
export {
  StaffRole,
  OrderType,
  OrderStatus,
  DiscountType,
  KotStatus,
  InvoiceType,
  InvoiceStatus,
  PaymentMethod,
  CashMovementType,
  TenantStatus,
} from './generated/prisma/enums';
