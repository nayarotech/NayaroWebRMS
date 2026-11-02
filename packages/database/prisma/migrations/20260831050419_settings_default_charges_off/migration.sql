-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_RestaurantSettings" (
    "restaurantId" TEXT NOT NULL PRIMARY KEY,
    "currencyCode" TEXT NOT NULL DEFAULT 'NPR',
    "vatEnabled" BOOLEAN NOT NULL DEFAULT false,
    "vatRateBp" INTEGER NOT NULL DEFAULT 1300,
    "serviceChargeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "serviceChargeRateBp" INTEGER NOT NULL DEFAULT 1000,
    "serviceChargeAppliesToTakeaway" BOOLEAN NOT NULL DEFAULT false,
    "roundGrandTotalToRupee" BOOLEAN NOT NULL DEFAULT true,
    "abbreviatedInvoiceAuthorized" BOOLEAN NOT NULL DEFAULT false,
    "abbreviatedInvoiceCeilingPaisa" INTEGER NOT NULL DEFAULT 1000000,
    "defaultInvoiceType" TEXT NOT NULL DEFAULT 'STANDARD',
    "invoicePrefix" TEXT NOT NULL DEFAULT 'INV',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kathmandu',
    "businessDayStartsAtMinutes" INTEGER NOT NULL DEFAULT 240,
    "printPanOnBill" BOOLEAN NOT NULL DEFAULT true,
    "showBsDateOnBill" BOOLEAN NOT NULL DEFAULT true,
    "printQrOnBill" BOOLEAN NOT NULL DEFAULT true,
    "billFooterText" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RestaurantSettings_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_RestaurantSettings" ("abbreviatedInvoiceAuthorized", "abbreviatedInvoiceCeilingPaisa", "billFooterText", "businessDayStartsAtMinutes", "createdAt", "currencyCode", "defaultInvoiceType", "invoicePrefix", "printPanOnBill", "printQrOnBill", "restaurantId", "roundGrandTotalToRupee", "serviceChargeAppliesToTakeaway", "serviceChargeEnabled", "serviceChargeRateBp", "showBsDateOnBill", "timezone", "updatedAt", "vatEnabled", "vatRateBp") SELECT "abbreviatedInvoiceAuthorized", "abbreviatedInvoiceCeilingPaisa", "billFooterText", "businessDayStartsAtMinutes", "createdAt", "currencyCode", "defaultInvoiceType", "invoicePrefix", "printPanOnBill", "printQrOnBill", "restaurantId", "roundGrandTotalToRupee", "serviceChargeAppliesToTakeaway", "serviceChargeEnabled", "serviceChargeRateBp", "showBsDateOnBill", "timezone", "updatedAt", "vatEnabled", "vatRateBp" FROM "RestaurantSettings";
DROP TABLE "RestaurantSettings";
ALTER TABLE "new_RestaurantSettings" RENAME TO "RestaurantSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
