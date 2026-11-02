CREATE TABLE "Customer" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "restaurantId" TEXT NOT NULL REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "name" TEXT NOT NULL,
  "phone" TEXT,
  "address" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "version" INTEGER NOT NULL DEFAULT 0,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "Customer_restaurantId_name_idx" ON "Customer"("restaurantId", "name");
ALTER TABLE "Payment" ADD COLUMN "customerId" TEXT REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Payment" ADD COLUMN "creditAssignedAt" DATETIME;
ALTER TABLE "Payment" ADD COLUMN "creditAssignedByStaffId" TEXT REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Payment_restaurantId_customerId_idx" ON "Payment"("restaurantId", "customerId");
CREATE TABLE "CreditRepayment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "restaurantId" TEXT NOT NULL REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "customerId" TEXT NOT NULL REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "amountPaisa" INTEGER NOT NULL,
  "method" TEXT NOT NULL,
  "reference" TEXT,
  "note" TEXT,
  "businessDate" TEXT NOT NULL,
  "receivedByStaffId" TEXT NOT NULL REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reversedAt" DATETIME,
  "reversalBusinessDate" TEXT,
  "reversalReason" TEXT,
  "reversedByStaffId" TEXT REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "chk_credit_repayment_amount" CHECK ("amountPaisa" > 0),
  CONSTRAINT "chk_credit_repayment_method" CHECK ("method" IN ('CASH', 'QR', 'CARD')),
  CONSTRAINT "chk_credit_repayment_reversal" CHECK (
    ("reversedAt" IS NULL AND "reversedByStaffId" IS NULL AND "reversalBusinessDate" IS NULL AND "reversalReason" IS NULL) OR
    ("reversedAt" IS NOT NULL AND "reversedByStaffId" IS NOT NULL AND "reversalBusinessDate" IS NOT NULL AND "reversalReason" IS NOT NULL)
  )
);
CREATE INDEX "CreditRepayment_restaurantId_customerId_idx" ON "CreditRepayment"("restaurantId", "customerId");
CREATE INDEX "CreditRepayment_restaurantId_businessDate_idx" ON "CreditRepayment"("restaurantId", "businessDate");
CREATE INDEX "CreditRepayment_restaurantId_createdAt_idx" ON "CreditRepayment"("restaurantId", "createdAt");
