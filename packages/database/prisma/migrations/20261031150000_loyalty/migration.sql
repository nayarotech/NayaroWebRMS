ALTER TABLE "RestaurantSettings" ADD COLUMN "loyaltyEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "RestaurantSettings" ADD COLUMN "loyaltyEarnEveryPaisa" INTEGER NOT NULL DEFAULT 10000 CHECK ("loyaltyEarnEveryPaisa" >= 100);
ALTER TABLE "RestaurantSettings" ADD COLUMN "loyaltyPointValuePaisa" INTEGER NOT NULL DEFAULT 100 CHECK ("loyaltyPointValuePaisa" > 0);
ALTER TABLE "RestaurantSettings" ADD COLUMN "loyaltyVersion" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Order" ADD COLUMN "loyaltyCustomerId" TEXT REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Order" ADD COLUMN "loyaltyPointsToRedeem" INTEGER NOT NULL DEFAULT 0 CHECK ("loyaltyPointsToRedeem" >= 0);
ALTER TABLE "Order" ADD COLUMN "loyaltyPointValuePaisa" INTEGER NOT NULL DEFAULT 0 CHECK ("loyaltyPointValuePaisa" >= 0);
ALTER TABLE "Invoice" ADD COLUMN "loyaltySnapshot" TEXT;
CREATE TABLE "LoyaltyEntry" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "restaurantId" TEXT NOT NULL REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "customerId" TEXT NOT NULL REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "invoiceId" TEXT NOT NULL REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "staffId" TEXT NOT NULL REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "key" TEXT NOT NULL UNIQUE,
 "kind" TEXT NOT NULL CHECK ("kind" IN ('EARN', 'EARN_ADJUSTMENT', 'REDEEM', 'REDEEM_VOID', 'REDEEM_REFUND')),
 "reason" TEXT,
 "deltaPoints" INTEGER NOT NULL CHECK ("deltaPoints" != 0),
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK (("kind" IN ('EARN', 'REDEEM_VOID', 'REDEEM_REFUND') AND "deltaPoints" > 0) OR ("kind" IN ('REDEEM', 'EARN_ADJUSTMENT') AND "deltaPoints" < 0))
);
CREATE INDEX "LoyaltyEntry_restaurantId_customerId_createdAt_idx" ON "LoyaltyEntry"("restaurantId", "customerId", "createdAt");
CREATE INDEX "LoyaltyEntry_invoiceId_idx" ON "LoyaltyEntry"("invoiceId");
