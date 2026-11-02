import type { Client } from '@libsql/client';

/** Seed the historical schema without asking today's Prisma client to write newer columns. */
export async function createLegacyInvoiceFixture(
  sqlite: Client,
  restaurantId: string,
  staffId: string,
  includeLine = false,
) {
  const order = { id: 'legacy-order' },
    invoice = { id: 'legacy-invoice' };
  const at = new Date().toISOString();
  await sqlite.execute({
    sql: 'INSERT INTO "Order" ("id", "restaurantId", "orderNumber", "type", "status", "openedByStaffId", "businessDate", "closedAt", "updatedAt") VALUES (?, ?, 1, \'TAKEAWAY\', \'PAID\', ?, \'2026-10-27\', ?, ?)',
    args: [order.id, restaurantId, staffId, at, at],
  });
  await sqlite.execute({
    sql: 'INSERT INTO "Invoice" ("id", "restaurantId", "orderId", "invoiceNumber", "fiscalYearStartBsYear", "issuedByStaffId", "businessDate", "subtotalPaisa", "grandTotalPaisa") VALUES (?, ?, ?, 1, 2083, ?, \'2026-10-27\', 10000, 10000)',
    args: [invoice.id, restaurantId, order.id, staffId],
  });
  if (includeLine)
    await sqlite.execute({
      sql: 'INSERT INTO "InvoiceLine" ("id", "invoiceId", "lineNumber", "description", "quantity", "unitPricePaisa", "lineTotalPaisa") VALUES (?, ?, 1, \'Legacy item\', 1, 10000, 10000)',
      args: ['legacy-line', invoice.id],
    });
  return { order, invoice };
}

/** A restaurant row as it existed before the multi-tenant migration. */
export async function createLegacyRestaurant(sqlite: Client): Promise<{ id: string }> {
  const id = 'legacy-restaurant';
  await sqlite.execute({
    sql: 'INSERT INTO "Restaurant" ("id", "name", "address", "phone", "panNumber", "updatedAt") VALUES (?, \'Existing restaurant\', \'\', \'\', \'\', ?)',
    args: [id, new Date().toISOString()],
  });
  return { id };
}
