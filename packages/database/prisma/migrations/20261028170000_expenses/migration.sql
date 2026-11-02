CREATE TABLE "Expense" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "restaurantId" TEXT NOT NULL REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "staffId" TEXT NOT NULL REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "amountPaisa" INTEGER NOT NULL,
  "method" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "supplier" TEXT,
  "note" TEXT NOT NULL,
  "businessDate" TEXT NOT NULL,
  "receiptName" TEXT,
  "receiptMime" TEXT,
  "receiptBase64" TEXT,
  "cashMovementId" TEXT REFERENCES "CashMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chk_expense_amount" CHECK ("amountPaisa" > 0),
  CONSTRAINT "chk_expense_method" CHECK ("method" IN ('CASH','QR','CARD'))
);
CREATE UNIQUE INDEX "Expense_cashMovementId_key" ON "Expense"("cashMovementId");
CREATE INDEX "Expense_restaurantId_businessDate_idx" ON "Expense"("restaurantId", "businessDate");
