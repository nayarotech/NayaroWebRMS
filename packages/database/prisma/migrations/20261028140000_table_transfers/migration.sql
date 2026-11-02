CREATE TABLE "OrderTableTransfer" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "restaurantId" TEXT NOT NULL REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "orderId" TEXT REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  "orderNumber" INTEGER NOT NULL,
  "fromTableId" TEXT NOT NULL REFERENCES "RestaurantTable"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "toTableId" TEXT NOT NULL REFERENCES "RestaurantTable"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "fromTableName" TEXT NOT NULL,
  "toTableName" TEXT NOT NULL,
  "staffId" TEXT NOT NULL REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chk_transfer_different_tables" CHECK ("fromTableId" <> "toTableId")
);
CREATE INDEX "OrderTableTransfer_restaurantId_createdAt_idx" ON "OrderTableTransfer"("restaurantId", "createdAt");
CREATE INDEX "OrderTableTransfer_orderId_idx" ON "OrderTableTransfer"("orderId");
