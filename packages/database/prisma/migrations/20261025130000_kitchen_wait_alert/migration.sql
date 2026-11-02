ALTER TABLE "RestaurantSettings" ADD COLUMN "kitchenNewTicketAlertMinutes" INTEGER NOT NULL DEFAULT 5 CHECK ("kitchenNewTicketAlertMinutes" BETWEEN 1 AND 60);
