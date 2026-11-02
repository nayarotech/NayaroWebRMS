CREATE TABLE "PaymentItemAllocation" (
  "paymentId" TEXT NOT NULL REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "invoiceLineId" TEXT NOT NULL REFERENCES "InvoiceLine"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "quantity" INTEGER NOT NULL,
  "amountPaisa" INTEGER NOT NULL,
  PRIMARY KEY ("paymentId", "invoiceLineId"),
  CONSTRAINT "chk_payment_item_quantity" CHECK ("quantity" > 0),
  CONSTRAINT "chk_payment_item_amount" CHECK ("amountPaisa" >= 0)
);
CREATE INDEX "PaymentItemAllocation_invoiceLineId_idx" ON "PaymentItemAllocation"("invoiceLineId");
