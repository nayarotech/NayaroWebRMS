CREATE TABLE "PaymentRefund" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "restaurantId" TEXT NOT NULL REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "paymentId" TEXT NOT NULL REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "customerId" TEXT REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "amountPaisa" INTEGER NOT NULL,
  "method" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "businessDate" TEXT NOT NULL,
  "staffId" TEXT NOT NULL REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "cashMovementId" TEXT REFERENCES "CashMovement"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chk_refund_amount" CHECK ("amountPaisa" > 0),
  CONSTRAINT "chk_refund_method" CHECK ("method" IN ('CASH','QR','CARD','CREDIT'))
);
CREATE UNIQUE INDEX "PaymentRefund_cashMovementId_key" ON "PaymentRefund"("cashMovementId");
CREATE INDEX "PaymentRefund_paymentId_idx" ON "PaymentRefund"("paymentId");
CREATE INDEX "PaymentRefund_restaurantId_businessDate_idx" ON "PaymentRefund"("restaurantId", "businessDate");
CREATE INDEX "PaymentRefund_customerId_idx" ON "PaymentRefund"("customerId");
