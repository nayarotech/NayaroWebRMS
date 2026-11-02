ALTER TABLE "MenuItem" ADD COLUMN "recipeVersion" INTEGER NOT NULL DEFAULT 0;
CREATE TABLE "Ingredient" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "restaurantId" TEXT NOT NULL REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "name" TEXT NOT NULL,
  "unit" TEXT NOT NULL,
  "onHandMilli" INTEGER NOT NULL DEFAULT 0,
  "lowStockMilli" INTEGER NOT NULL DEFAULT 0,
  "version" INTEGER NOT NULL DEFAULT 0,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "chk_ingredient_stock" CHECK ("onHandMilli" >= 0 AND "lowStockMilli" >= 0),
  CONSTRAINT "chk_ingredient_unit" CHECK ("unit" IN ('g','ml','each'))
);
CREATE UNIQUE INDEX "Ingredient_restaurantId_name_key" ON "Ingredient"("restaurantId", "name");
CREATE TABLE "RecipeIngredient" (
  "menuItemId" TEXT NOT NULL REFERENCES "MenuItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "ingredientId" TEXT NOT NULL REFERENCES "Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "quantityMilli" INTEGER NOT NULL,
  PRIMARY KEY ("menuItemId", "ingredientId"),
  CONSTRAINT "chk_recipe_quantity" CHECK ("quantityMilli" > 0)
);
CREATE TABLE "StockMovement" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "restaurantId" TEXT NOT NULL REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "ingredientId" TEXT NOT NULL REFERENCES "Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "staffId" TEXT NOT NULL REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "kind" TEXT NOT NULL,
  "deltaMilli" INTEGER NOT NULL,
  "balanceAfterMilli" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "supplier" TEXT,
  "costPaisa" INTEGER,
  "businessDate" TEXT NOT NULL,
  "expenseId" TEXT REFERENCES "Expense"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "kotId" TEXT REFERENCES "Kot"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chk_stock_movement" CHECK ("balanceAfterMilli" >= 0 AND ("costPaisa" IS NULL OR "costPaisa" >= 0)),
  CONSTRAINT "chk_stock_kind" CHECK ("kind" IN ('PURCHASE','COUNT','WASTE','DISPATCH','SETTINGS'))
);
CREATE UNIQUE INDEX "StockMovement_expenseId_key" ON "StockMovement"("expenseId");
CREATE UNIQUE INDEX "StockMovement_kotId_ingredientId_key" ON "StockMovement"("kotId", "ingredientId");
CREATE INDEX "StockMovement_restaurantId_ingredientId_createdAt_idx" ON "StockMovement"("restaurantId", "ingredientId", "createdAt");
CREATE TABLE "MenuAvailabilityChange" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "restaurantId" TEXT NOT NULL REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "menuItemId" TEXT NOT NULL REFERENCES "MenuItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "staffId" TEXT NOT NULL REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "isAvailable" BOOLEAN NOT NULL,
  "reason" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "MenuAvailabilityChange_restaurantId_createdAt_idx" ON "MenuAvailabilityChange"("restaurantId", "createdAt");
CREATE TABLE "RecipeChange" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "restaurantId" TEXT NOT NULL REFERENCES "Restaurant"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "menuItemId" TEXT NOT NULL REFERENCES "MenuItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "staffId" TEXT NOT NULL REFERENCES "Staff"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  "reason" TEXT NOT NULL,
  "beforeJson" TEXT NOT NULL,
  "afterJson" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "RecipeChange_restaurantId_createdAt_idx" ON "RecipeChange"("restaurantId", "createdAt");
