ALTER TABLE "OrderItem" ADD COLUMN "promotionSnapshot" TEXT;
ALTER TABLE "InvoiceLine" ADD COLUMN "promotionSnapshot" TEXT;
CREATE TABLE "Offer" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "restaurantId" TEXT NOT NULL REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "name" TEXT NOT NULL,
 "rateBp" INTEGER NOT NULL CHECK ("rateBp" > 0 AND "rateBp" <= 10000),
 "scope" TEXT NOT NULL CHECK ("scope" IN ('ALL', 'ITEMS', 'CATEGORIES')),
 "targetIdsJson" TEXT NOT NULL,
 "startsAt" DATETIME NOT NULL,
 "endsAt" DATETIME NOT NULL,
 "isActive" BOOLEAN NOT NULL DEFAULT true,
 "version" INTEGER NOT NULL DEFAULT 0,
 "createdByStaffId" TEXT NOT NULL REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "updatedByStaffId" TEXT NOT NULL REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" DATETIME NOT NULL,
 CHECK ("endsAt" > "startsAt")
);
CREATE INDEX "Offer_restaurantId_isActive_startsAt_endsAt_idx" ON "Offer"("restaurantId", "isActive", "startsAt", "endsAt");
