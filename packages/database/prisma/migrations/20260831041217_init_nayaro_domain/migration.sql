/*
  MANUALLY EXTENDED after `prisma migrate dev --create-only`.

  11 CHECK constraints were hand-added to the CREATE TABLE statements below.
  Prisma cannot express CHECK constraints in schema.prisma, and SQLite cannot
  ALTER TABLE ADD CONSTRAINT, so they must live inside CREATE TABLE.

  WARNING: a future migration that RECREATES any of these tables
  (Prisma emits "-- RedefineTables" for column drops, type changes and FK
  changes on SQLite) will SILENTLY DROP these constraints. Prisma does not
  treat them as drift and reports "up to date". Any such migration must
  re-add them by hand.
*/

/*
  Warnings:

  - You are about to drop the `_nayaro_health_probe` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "_nayaro_health_probe";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "Restaurant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "panNumber" TEXT NOT NULL,
    "logoPath" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "RestaurantSettings" (
    "restaurantId" TEXT NOT NULL PRIMARY KEY,
    "currencyCode" TEXT NOT NULL DEFAULT 'NPR',
    "vatEnabled" BOOLEAN NOT NULL DEFAULT true,
    "vatRateBp" INTEGER NOT NULL DEFAULT 1300,
    "serviceChargeEnabled" BOOLEAN NOT NULL DEFAULT true,
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

-- CreateTable
CREATE TABLE "RestaurantCounter" (
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nextValue" INTEGER NOT NULL DEFAULT 1,

    PRIMARY KEY ("restaurantId", "name"),
    CONSTRAINT "RestaurantCounter_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "chk_restaurant_counter_next_value" CHECK (
        "nextValue" >= 1
    )
);

-- CreateTable
CREATE TABLE "Staff" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Staff_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RestaurantArea" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RestaurantArea_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RestaurantTable" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "restaurantId" TEXT NOT NULL,
    "areaId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 4,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "RestaurantTable_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "RestaurantTable_areaId_fkey" FOREIGN KEY ("areaId") REFERENCES "RestaurantArea" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MenuCategory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "restaurantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameNp" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MenuCategory_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MenuItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "restaurantId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameNp" TEXT,
    "pricePaisa" INTEGER NOT NULL,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MenuItem_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "MenuItem_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "MenuCategory" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "restaurantId" TEXT NOT NULL,
    "orderNumber" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "tableId" TEXT,
    "customerLabel" TEXT,
    "openedByStaffId" TEXT NOT NULL,
    "businessDate" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "discountType" TEXT NOT NULL DEFAULT 'NONE',
    "discountValue" INTEGER NOT NULL DEFAULT 0,
    "discountApprovedByStaffId" TEXT,
    "closedAt" DATETIME,
    "voidReason" TEXT,
    "voidedByStaffId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Order_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Order_tableId_fkey" FOREIGN KEY ("tableId") REFERENCES "RestaurantTable" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Order_openedByStaffId_fkey" FOREIGN KEY ("openedByStaffId") REFERENCES "Staff" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Order_discountApprovedByStaffId_fkey" FOREIGN KEY ("discountApprovedByStaffId") REFERENCES "Staff" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Order_voidedByStaffId_fkey" FOREIGN KEY ("voidedByStaffId") REFERENCES "Staff" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "chk_order_closed_state" CHECK (
        ("status" IN ('DRAFT','OPEN','BILLED') AND "closedAt" IS NULL)
        OR ("status" IN ('PAID','VOID') AND "closedAt" IS NOT NULL)
    ),
    CONSTRAINT "chk_order_type_table" CHECK (
        ("type" = 'DINE_IN' AND "tableId" IS NOT NULL)
        OR ("type" = 'TAKEAWAY' AND "tableId" IS NULL)
    )
);

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "nameSnapshot" TEXT NOT NULL,
    "nameNpSnapshot" TEXT,
    "unitPricePaisa" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OrderItem_menuItemId_fkey" FOREIGN KEY ("menuItemId") REFERENCES "MenuItem" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "chk_order_item_quantity" CHECK (
        "quantity" > 0 AND "unitPricePaisa" >= 0
    )
);

-- CreateTable
CREATE TABLE "OrderItemCancellation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orderItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "cancelledByStaffId" TEXT NOT NULL,
    "cancelledAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OrderItemCancellation_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "OrderItemCancellation_cancelledByStaffId_fkey" FOREIGN KEY ("cancelledByStaffId") REFERENCES "Staff" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "chk_order_item_cancellation_quantity" CHECK (
        "quantity" > 0
    )
);

-- CreateTable
CREATE TABLE "Kot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "restaurantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "kotNumber" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "createdByStaffId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "readyAt" DATETIME,
    "servedAt" DATETIME,
    "voidedAt" DATETIME,
    "voidReason" TEXT,
    "voidedByStaffId" TEXT,
    CONSTRAINT "Kot_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Kot_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Kot_createdByStaffId_fkey" FOREIGN KEY ("createdByStaffId") REFERENCES "Staff" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Kot_voidedByStaffId_fkey" FOREIGN KEY ("voidedByStaffId") REFERENCES "Staff" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "KotItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kotId" TEXT NOT NULL,
    "orderItemId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "noteSnapshot" TEXT,
    CONSTRAINT "KotItem_kotId_fkey" FOREIGN KEY ("kotId") REFERENCES "Kot" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "KotItem_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "chk_kot_item_quantity" CHECK (
        "quantity" > 0
    )
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "restaurantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "invoiceType" TEXT NOT NULL DEFAULT 'STANDARD',
    "invoiceNumber" INTEGER NOT NULL,
    "fiscalYearStartBsYear" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "issuedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issuedByStaffId" TEXT NOT NULL,
    "businessDate" TEXT NOT NULL,
    "buyerName" TEXT,
    "buyerPan" TEXT,
    "buyerAddress" TEXT,
    "subtotalPaisa" INTEGER NOT NULL,
    "discountType" TEXT NOT NULL DEFAULT 'NONE',
    "discountValue" INTEGER NOT NULL DEFAULT 0,
    "discountPaisa" INTEGER NOT NULL DEFAULT 0,
    "serviceChargeRateBp" INTEGER NOT NULL DEFAULT 0,
    "serviceChargePaisa" INTEGER NOT NULL DEFAULT 0,
    "vatRateBp" INTEGER NOT NULL DEFAULT 0,
    "vatPaisa" INTEGER NOT NULL DEFAULT 0,
    "roundingAdjustmentPaisa" INTEGER NOT NULL DEFAULT 0,
    "grandTotalPaisa" INTEGER NOT NULL,
    "voidedAt" DATETIME,
    "voidReason" TEXT,
    "voidedByStaffId" TEXT,
    "cbmsSyncedAt" DATETIME,
    "cbmsReference" TEXT,
    "cbmsPayloadHash" TEXT,
    CONSTRAINT "Invoice_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Invoice_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Invoice_issuedByStaffId_fkey" FOREIGN KEY ("issuedByStaffId") REFERENCES "Staff" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Invoice_voidedByStaffId_fkey" FOREIGN KEY ("voidedByStaffId") REFERENCES "Staff" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "chk_invoice_totals" CHECK (
        "subtotalPaisa" - "discountPaisa" + "serviceChargePaisa" + "vatPaisa"
        + "roundingAdjustmentPaisa" = "grandTotalPaisa"
    ),
    CONSTRAINT "chk_invoice_non_negative" CHECK (
        "subtotalPaisa" >= 0 AND "discountPaisa" >= 0 AND "serviceChargePaisa" >= 0
        AND "vatPaisa" >= 0 AND "grandTotalPaisa" >= 0
    )
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invoiceId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "orderItemId" TEXT,
    "description" TEXT NOT NULL,
    "descriptionNp" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPricePaisa" INTEGER NOT NULL,
    "lineTotalPaisa" INTEGER NOT NULL,
    CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "InvoiceLine_orderItemId_fkey" FOREIGN KEY ("orderItemId") REFERENCES "OrderItem" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "chk_invoice_line_amounts" CHECK (
        "quantity" > 0 AND "unitPricePaisa" >= 0
        AND "lineTotalPaisa" = "quantity" * "unitPricePaisa"
    )
);

-- CreateTable
CREATE TABLE "InvoicePrint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "invoiceId" TEXT NOT NULL,
    "copySequence" INTEGER NOT NULL,
    "printedByStaffId" TEXT NOT NULL,
    "printedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InvoicePrint_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "InvoicePrint_printedByStaffId_fkey" FOREIGN KEY ("printedByStaffId") REFERENCES "Staff" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "chk_invoice_print_copy_sequence" CHECK (
        "copySequence" >= 1
    )
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "restaurantId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "amountPaisa" INTEGER NOT NULL,
    "tenderedPaisa" INTEGER,
    "reference" TEXT,
    "creditAccountName" TEXT,
    "receivedByStaffId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "voidedAt" DATETIME,
    "voidReason" TEXT,
    "voidedByStaffId" TEXT,
    CONSTRAINT "Payment_restaurantId_fkey" FOREIGN KEY ("restaurantId") REFERENCES "Restaurant" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Payment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Payment_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Payment_receivedByStaffId_fkey" FOREIGN KEY ("receivedByStaffId") REFERENCES "Staff" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "Payment_voidedByStaffId_fkey" FOREIGN KEY ("voidedByStaffId") REFERENCES "Staff" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "chk_payment_amount" CHECK (
        "amountPaisa" > 0
        AND ("tenderedPaisa" IS NULL OR "tenderedPaisa" >= "amountPaisa")
    )
);

-- CreateIndex
CREATE INDEX "Staff_restaurantId_isActive_idx" ON "Staff"("restaurantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Staff_restaurantId_username_key" ON "Staff"("restaurantId", "username");

-- CreateIndex
CREATE INDEX "RestaurantArea_restaurantId_sortOrder_idx" ON "RestaurantArea"("restaurantId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantArea_restaurantId_name_key" ON "RestaurantArea"("restaurantId", "name");

-- CreateIndex
CREATE INDEX "RestaurantTable_restaurantId_areaId_sortOrder_idx" ON "RestaurantTable"("restaurantId", "areaId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "RestaurantTable_restaurantId_name_key" ON "RestaurantTable"("restaurantId", "name");

-- CreateIndex
CREATE INDEX "MenuCategory_restaurantId_sortOrder_idx" ON "MenuCategory"("restaurantId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "MenuCategory_restaurantId_name_key" ON "MenuCategory"("restaurantId", "name");

-- CreateIndex
CREATE INDEX "MenuItem_restaurantId_categoryId_sortOrder_idx" ON "MenuItem"("restaurantId", "categoryId", "sortOrder");

-- CreateIndex
CREATE INDEX "MenuItem_restaurantId_isActive_idx" ON "MenuItem"("restaurantId", "isActive");

-- CreateIndex
CREATE INDEX "Order_restaurantId_status_idx" ON "Order"("restaurantId", "status");

-- CreateIndex
CREATE INDEX "Order_restaurantId_businessDate_idx" ON "Order"("restaurantId", "businessDate");

-- CreateIndex
CREATE UNIQUE INDEX "Order_restaurantId_orderNumber_key" ON "Order"("restaurantId", "orderNumber");

-- CreateIndex
CREATE UNIQUE INDEX "uq_order_active_per_table" ON "Order"("restaurantId", "tableId") WHERE "closedAt" IS NULL AND "tableId" IS NOT NULL;

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE INDEX "OrderItem_menuItemId_idx" ON "OrderItem"("menuItemId");

-- CreateIndex
CREATE INDEX "OrderItemCancellation_orderItemId_idx" ON "OrderItemCancellation"("orderItemId");

-- CreateIndex
CREATE INDEX "Kot_restaurantId_status_idx" ON "Kot"("restaurantId", "status");

-- CreateIndex
CREATE INDEX "Kot_orderId_idx" ON "Kot"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Kot_restaurantId_kotNumber_key" ON "Kot"("restaurantId", "kotNumber");

-- CreateIndex
CREATE INDEX "KotItem_kotId_idx" ON "KotItem"("kotId");

-- CreateIndex
CREATE INDEX "KotItem_orderItemId_idx" ON "KotItem"("orderItemId");

-- CreateIndex
CREATE INDEX "Invoice_restaurantId_businessDate_idx" ON "Invoice"("restaurantId", "businessDate");

-- CreateIndex
CREATE INDEX "Invoice_restaurantId_status_idx" ON "Invoice"("restaurantId", "status");

-- CreateIndex
CREATE INDEX "Invoice_orderId_idx" ON "Invoice"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_restaurantId_invoiceType_fiscalYearStartBsYear_invoiceNumber_key" ON "Invoice"("restaurantId", "invoiceType", "fiscalYearStartBsYear", "invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "uq_invoice_active_per_order" ON "Invoice"("orderId") WHERE "status" = 'ACTIVE';

-- CreateIndex
CREATE INDEX "InvoiceLine_invoiceId_idx" ON "InvoiceLine"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoiceLine_invoiceId_lineNumber_key" ON "InvoiceLine"("invoiceId", "lineNumber");

-- CreateIndex
CREATE INDEX "InvoicePrint_invoiceId_idx" ON "InvoicePrint"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "InvoicePrint_invoiceId_copySequence_key" ON "InvoicePrint"("invoiceId", "copySequence");

-- CreateIndex
CREATE INDEX "Payment_orderId_idx" ON "Payment"("orderId");

-- CreateIndex
CREATE INDEX "Payment_invoiceId_idx" ON "Payment"("invoiceId");

-- CreateIndex
CREATE INDEX "Payment_restaurantId_createdAt_idx" ON "Payment"("restaurantId", "createdAt");
