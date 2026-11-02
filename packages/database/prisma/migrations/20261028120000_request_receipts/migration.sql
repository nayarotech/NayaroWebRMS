CREATE TABLE "RequestReceipt" (
    "restaurantId" TEXT NOT NULL,
    "staffId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY ("restaurantId", "staffId", "key")
);
