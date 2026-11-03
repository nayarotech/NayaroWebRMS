-- AlterTable
ALTER TABLE "Staff" ADD COLUMN "email" TEXT;
ALTER TABLE "Staff" ADD COLUMN "emailVerifiedAt" DATETIME;

-- CreateTable
CREATE TABLE "PendingRegistration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "workspace" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" DATETIME NOT NULL,
    "lastSentAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Staff_email_key" ON "Staff"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PendingRegistration_email_key" ON "PendingRegistration"("email");
