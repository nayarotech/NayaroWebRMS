-- CreateTable
CREATE TABLE "SiteVisitor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "firstSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "currentPath" TEXT,
    "signedIn" BOOLEAN NOT NULL DEFAULT false,
    "sessions" INTEGER NOT NULL DEFAULT 1,
    "country" TEXT,
    "device" TEXT,
    "browser" TEXT,
    "os" TEXT
);

-- CreateTable
CREATE TABLE "SitePageView" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "visitorId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "referrer" TEXT,
    "utmSource" TEXT,
    "country" TEXT,
    "device" TEXT,
    "browser" TEXT,
    "os" TEXT,
    "signedIn" BOOLEAN NOT NULL DEFAULT false,
    "isNewSession" BOOLEAN NOT NULL DEFAULT false,
    "isNewVisitor" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SitePageView_visitorId_fkey" FOREIGN KEY ("visitorId") REFERENCES "SiteVisitor" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "SiteVisitor_lastSeenAt_idx" ON "SiteVisitor"("lastSeenAt");

-- CreateIndex
CREATE INDEX "SitePageView_createdAt_idx" ON "SitePageView"("createdAt");

-- CreateIndex
CREATE INDEX "SitePageView_visitorId_idx" ON "SitePageView"("visitorId");
