-- Cash drawer: shifts and pay-in / pay-out movements.
--
-- WRITTEN BY HAND, like 20260906020000, because the CHECK constraints below
-- are something Prisma cannot express. Two new tables only - no existing table
-- is touched, so nothing can be rebuilt out from under an older constraint.
-- assertDatabaseIntegrity() verifies all three new CHECKs on every startup.

-- CreateTable
CREATE TABLE "Shift" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "restaurantId" TEXT NOT NULL,
    "businessDate" TEXT NOT NULL,
    "openedByStaffId" TEXT NOT NULL,
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openingFloatPaisa" INTEGER NOT NULL,
    "closedByStaffId" TEXT,
    "closedAt" DATETIME,
    "expectedCashPaisa" INTEGER,
    "countedCashPaisa" INTEGER,
    "closeNote" TEXT,
    CONSTRAINT "Shift_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Shift_openedByStaffId_fkey" FOREIGN KEY ("openedByStaffId") REFERENCES "Staff" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Shift_closedByStaffId_fkey" FOREIGN KEY ("closedByStaffId") REFERENCES "Staff" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "chk_shift_amounts" CHECK (
        "openingFloatPaisa" >= 0
        AND ("countedCashPaisa" IS NULL OR "countedCashPaisa" >= 0)
    ),
    CONSTRAINT "chk_shift_closed_state" CHECK (
        ("closedAt" IS NULL AND "closedByStaffId" IS NULL
            AND "expectedCashPaisa" IS NULL AND "countedCashPaisa" IS NULL)
        OR
        ("closedAt" IS NOT NULL AND "closedByStaffId" IS NOT NULL
            AND "expectedCashPaisa" IS NOT NULL AND "countedCashPaisa" IS NOT NULL)
    )
);

-- CreateTable
CREATE TABLE "CashMovement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "restaurantId" TEXT NOT NULL,
    "shiftId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amountPaisa" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CashMovement_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CashMovement_shiftId_fkey" FOREIGN KEY ("shiftId") REFERENCES "Shift" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "CashMovement_staffId_fkey" FOREIGN KEY ("staffId") REFERENCES "Staff" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "chk_cash_movement_amount" CHECK ("amountPaisa" > 0)
);

-- One open drawer per restaurant. Two cashiers pressing "Open drawer" at once
-- get one shift and one refusal, decided by the database.
CREATE UNIQUE INDEX "uq_shift_open_per_restaurant" ON "Shift"("restaurantId") WHERE "closedAt" IS NULL;

-- CreateIndex
CREATE INDEX "Shift_restaurantId_openedAt_idx" ON "Shift"("restaurantId", "openedAt");

-- CreateIndex
CREATE INDEX "Shift_restaurantId_businessDate_idx" ON "Shift"("restaurantId", "businessDate");

-- CreateIndex
CREATE INDEX "CashMovement_shiftId_idx" ON "CashMovement"("shiftId");

-- CreateIndex
CREATE INDEX "CashMovement_restaurantId_createdAt_idx" ON "CashMovement"("restaurantId", "createdAt");
