import type { NayaroPrismaClient } from './client';

/**
 * Guards the SQLite schema invariants that Prisma cannot express.
 *
 * WHY THIS EXISTS
 *
 * CHECK constraints enforce rules the type system cannot: that a PAID
 * order has a closing timestamp, that a DINE_IN order has a table, that an
 * invoice's components actually sum to its total. They are hand-written into
 * the migration's CREATE TABLE statements because Prisma has no syntax for
 * them and SQLite has no ALTER TABLE ADD CONSTRAINT.
 *
 * That makes them fragile in one specific way, which we verified rather than
 * assumed: when a future migration changes a column type, drops a column or
 * alters a foreign key, Prisma emits "-- RedefineTables" for SQLite - it
 * rebuilds the table from its own datamodel, which knows nothing about our
 * CHECKs. They are dropped silently. `prisma migrate status` still reports
 * "up to date", because Prisma does not treat them as drift.
 *
 * Losing them would not break anything loudly. It would just quietly permit a
 * bill whose numbers do not add up. So we check on every startup, after
 * migrations, and refuse to run against a weakened schema.
 */

/** Every CHECK constraint the production schema must have. */
export const REQUIRED_CHECK_CONSTRAINTS: ReadonlyArray<{
  readonly table: string;
  readonly constraint: string;
}> = [
  { table: 'OrderTableTransfer', constraint: 'chk_transfer_different_tables' },
  { table: 'CreditRepayment', constraint: 'chk_credit_repayment_amount' },
  { table: 'CreditRepayment', constraint: 'chk_credit_repayment_method' },
  { table: 'CreditRepayment', constraint: 'chk_credit_repayment_reversal' },
  { table: 'Order', constraint: 'chk_order_closed_state' },
  { table: 'Order', constraint: 'chk_order_type_table' },
  { table: 'OrderItem', constraint: 'chk_order_item_quantity' },
  { table: 'OrderItemCancellation', constraint: 'chk_order_item_cancellation_quantity' },
  { table: 'KotItem', constraint: 'chk_kot_item_quantity' },
  { table: 'Invoice', constraint: 'chk_invoice_totals' },
  { table: 'Invoice', constraint: 'chk_invoice_non_negative' },
  { table: 'InvoiceLine', constraint: 'chk_invoice_line_amounts' },
  { table: 'InvoicePrint', constraint: 'chk_invoice_print_copy_sequence' },
  { table: 'Payment', constraint: 'chk_payment_amount' },
  { table: 'PaymentItemAllocation', constraint: 'chk_payment_item_quantity' },
  { table: 'PaymentItemAllocation', constraint: 'chk_payment_item_amount' },
  { table: 'PaymentRefund', constraint: 'chk_refund_amount' },
  { table: 'PaymentRefund', constraint: 'chk_refund_method' },
  { table: 'Expense', constraint: 'chk_expense_amount' },
  { table: 'Expense', constraint: 'chk_expense_method' },
  { table: 'Ingredient', constraint: 'chk_ingredient_stock' },
  { table: 'Ingredient', constraint: 'chk_ingredient_unit' },
  { table: 'RecipeIngredient', constraint: 'chk_recipe_quantity' },
  { table: 'StockMovement', constraint: 'chk_stock_movement' },
  { table: 'StockMovement', constraint: 'chk_stock_kind' },
  { table: 'RestaurantCounter', constraint: 'chk_restaurant_counter_next_value' },
  { table: 'Shift', constraint: 'chk_shift_amounts' },
  { table: 'Shift', constraint: 'chk_shift_closed_state' },
  { table: 'CashMovement', constraint: 'chk_cash_movement_amount' },
];

export interface MissingCheckConstraint {
  readonly table: string;
  readonly constraint: string;
  /** True when the whole table is gone, not merely its constraint. */
  readonly tableMissing: boolean;
}

/**
 * Raised when the live schema is weaker than the schema we shipped. Carries the
 * specific missing constraints so an operator can act, but no file paths and no
 * SQL - this message may surface in a dialog.
 */
export class DatabaseIntegrityError extends Error {
  readonly missing: readonly MissingCheckConstraint[];

  constructor(missing: readonly MissingCheckConstraint[]) {
    const detail = missing.map((m) => `${m.table}.${m.constraint}`).join(', ');
    super(
      `Nayaro RMS cannot start: the database is missing ${String(missing.length)} ` +
        `required integrity constraint(s): ${detail}. This usually means a schema ` +
        `upgrade rebuilt a table without restoring its constraints. Running in this ` +
        `state risks recording bills that do not add up, so startup has been stopped.`,
    );
    this.name = 'DatabaseIntegrityError';
    this.missing = missing;
  }
}

/**
 * Reads the live `CREATE TABLE` text out of sqlite_master and reports which
 * required constraints are absent.
 *
 * Deliberately inspects the database rather than the migration files: what a
 * migration once created and what the table looks like now are different
 * questions, and only the second one matters.
 */
export async function findMissingCheckConstraints(
  prisma: NayaroPrismaClient,
): Promise<MissingCheckConstraint[]> {
  const rows = await prisma.$queryRaw<{ name: string; sql: string | null }[]>`
    SELECT name, sql FROM sqlite_master WHERE type = 'table'
  `;

  const ddlByTable = new Map(rows.map((row) => [row.name, row.sql ?? '']));
  const missing: MissingCheckConstraint[] = [];

  for (const required of REQUIRED_CHECK_CONSTRAINTS) {
    const ddl = ddlByTable.get(required.table);
    if (ddl === undefined) {
      missing.push({ ...required, tableMissing: true });
      continue;
    }
    if (!ddl.includes(`CONSTRAINT "${required.constraint}"`)) {
      missing.push({ ...required, tableMissing: false });
    }
  }

  return missing;
}

/**
 * Startup gate. Throws `DatabaseIntegrityError` if anything is missing.
 *
 * Must run AFTER migrations: a migration is exactly the thing that can remove
 * a constraint, so checking beforehand would validate the wrong schema.
 */
export async function assertDatabaseIntegrity(prisma: NayaroPrismaClient): Promise<void> {
  const missing = await findMissingCheckConstraints(prisma);
  if (missing.length > 0) {
    throw new DatabaseIntegrityError(missing);
  }
}
