CREATE TABLE "PayrollProfile" (
 "staffId" TEXT NOT NULL PRIMARY KEY REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "restaurantId" TEXT NOT NULL REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "monthlySalaryPaisa" INTEGER NOT NULL CHECK ("monthlySalaryPaisa" >= 0 AND "monthlySalaryPaisa" <= 1000000000),
 "version" INTEGER NOT NULL DEFAULT 0,
 "updatedByStaffId" TEXT NOT NULL REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "updatedAt" DATETIME NOT NULL
);
CREATE INDEX "PayrollProfile_restaurantId_idx" ON "PayrollProfile"("restaurantId");
CREATE TABLE "PayrollRecord" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "restaurantId" TEXT NOT NULL REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "staffId" TEXT NOT NULL REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "staffNameSnapshot" TEXT NOT NULL,
 "month" TEXT NOT NULL,
 "baseSalaryPaisa" INTEGER NOT NULL,
 "allowancesPaisa" INTEGER NOT NULL DEFAULT 0,
 "deductionsPaisa" INTEGER NOT NULL DEFAULT 0,
 "note" TEXT NOT NULL DEFAULT '',
 "status" TEXT NOT NULL DEFAULT 'DRAFT' CHECK ("status" IN ('DRAFT', 'APPROVED')),
 "version" INTEGER NOT NULL DEFAULT 0,
 "createdByStaffId" TEXT NOT NULL REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "updatedByStaffId" TEXT NOT NULL REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "approvedByStaffId" TEXT REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "approvedAt" DATETIME,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 "updatedAt" DATETIME NOT NULL,
 CHECK ("baseSalaryPaisa" >= 0 AND "allowancesPaisa" >= 0 AND "deductionsPaisa" >= 0 AND "deductionsPaisa" <= "baseSalaryPaisa" + "allowancesPaisa" AND "baseSalaryPaisa" + "allowancesPaisa" <= 1000000000),
 CHECK (("status" = 'DRAFT' AND "approvedAt" IS NULL AND "approvedByStaffId" IS NULL) OR ("status" = 'APPROVED' AND "approvedAt" IS NOT NULL AND "approvedByStaffId" IS NOT NULL))
);
CREATE UNIQUE INDEX "PayrollRecord_restaurantId_staffId_month_key" ON "PayrollRecord"("restaurantId", "staffId", "month");
CREATE INDEX "PayrollRecord_restaurantId_month_idx" ON "PayrollRecord"("restaurantId", "month");
CREATE TABLE "PayrollPayment" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "restaurantId" TEXT NOT NULL REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "payrollRecordId" TEXT NOT NULL REFERENCES "PayrollRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "paidByStaffId" TEXT NOT NULL REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "kind" TEXT NOT NULL CHECK ("kind" IN ('ADVANCE', 'SALARY')),
 "amountPaisa" INTEGER NOT NULL CHECK ("amountPaisa" > 0 AND "amountPaisa" <= 1000000000),
 "method" TEXT NOT NULL CHECK ("method" IN ('CASH', 'QR', 'CARD')),
 "reference" TEXT,
 "note" TEXT NOT NULL,
 "businessDate" TEXT NOT NULL,
 "expenseId" TEXT NOT NULL UNIQUE REFERENCES "Expense"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "PayrollPayment_payrollRecordId_createdAt_idx" ON "PayrollPayment"("payrollRecordId", "createdAt");
CREATE TABLE "PayrollAudit" (
 "id" TEXT NOT NULL PRIMARY KEY,
 "restaurantId" TEXT NOT NULL REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "payrollRecordId" TEXT NOT NULL REFERENCES "PayrollRecord"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "staffId" TEXT NOT NULL REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
 "kind" TEXT NOT NULL CHECK ("kind" IN ('CREATE', 'EDIT', 'APPROVE', 'REOPEN')),
 "beforeJson" TEXT,
 "afterJson" TEXT NOT NULL,
 "note" TEXT NOT NULL,
 "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "PayrollAudit_payrollRecordId_createdAt_idx" ON "PayrollAudit"("payrollRecordId", "createdAt");
