-- Phase 4H: management actor on settings, seller snapshot on invoices.
--
-- WRITTEN BY HAND, deliberately. Prisma's SQLite migrator resolves some column
-- additions with a RedefineTables strategy: it builds a new table from the
-- schema, copies rows and drops the original. That silently discards the
-- CHECK constraints added by hand in 20260831041217, and "Invoice" carries two
-- of them (chk_invoice_totals, chk_invoice_non_negative).
--
-- Plain ALTER TABLE ADD COLUMN adds a nullable column in place, touching no
-- constraint, no index and no data. assertDatabaseIntegrity() re-verifies all
-- eleven CHECKs on the next startup either way.

-- Who last changed money-affecting configuration.
ALTER TABLE "RestaurantSettings" ADD COLUMN "updatedByStaffId" TEXT
    REFERENCES "Staff" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seller identity as issued. An invoice must reproduce itself without reading
-- today's restaurant record.
ALTER TABLE "Invoice" ADD COLUMN "sellerName" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "sellerAddress" TEXT;
ALTER TABLE "Invoice" ADD COLUMN "sellerPan" TEXT;
