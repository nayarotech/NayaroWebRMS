import type { NayaroPrismaClient } from '@nayaro/database';
import type { FloorResponse } from '@nayaro/shared';
import { ApiError } from '../../utils/apiError';
import { toFloorAreas } from './floor.mapper';
import type { ActiveOrderSnapshot } from './floor.types';
import {
  createAreaSchema,
  createTableSchema,
  updateAreaSchema,
  updateTableSchema,
} from './floor.schema';

/**
 * Floor plan: areas and the tables inside them.
 *
 * EVERY function here takes `restaurantId` as its first argument and applies it
 * to every query. It comes from the authenticated session, never from the
 * request body - which is what makes it impossible for a signed-in user at one
 * restaurant to read or edit another's floor by guessing an id. That is the
 * rule for all business APIs from here on.
 */

/**
 * Reads the whole floor with each table's derived status.
 *
 * QUERY SHAPE, deliberately: this runs a small CONSTANT number of queries no
 * matter how many tables exist - areas, their tables, the active orders, those
 * orders' KOTs, those orders' active invoices. Statuses are then assembled in
 * memory. The obvious alternative, asking "is this table busy?" once per table,
 * is an N+1 that looks fine on a demo floor of six and falls over on fifty.
 */
export async function getFloor(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  options: { includeInactive?: boolean } = {},
): Promise<FloorResponse> {
  const includeInactive = options.includeInactive ?? false;

  const areas = await prisma.restaurantArea.findMany({
    where: { restaurantId, ...(includeInactive ? {} : { isActive: true }) },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      sortOrder: true,
      isActive: true,
      tables: {
        where: includeInactive ? {} : { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, capacity: true, sortOrder: true, isActive: true },
      },
    },
  });

  const activeOrders = await loadActiveOrdersByTable(prisma, restaurantId);
  return { areas: toFloorAreas(areas, activeOrders) };
}

/**
 * All open orders that occupy a table, keyed by table.
 *
 * `closedAt: null` is the canonical "still on the floor" marker - the same
 * column the partial unique index uses, which is what guarantees at most one
 * entry per table and lets this be a plain Map rather than a list.
 */
async function loadActiveOrdersByTable(
  prisma: NayaroPrismaClient,
  restaurantId: string,
): Promise<Map<string, ActiveOrderSnapshot>> {
  const orders = await prisma.order.findMany({
    where: { restaurantId, closedAt: null, tableId: { not: null } },
    select: {
      id: true,
      tableId: true,
      status: true,
      kots: { where: { status: { not: 'VOID' } }, select: { status: true } },
      invoices: { where: { status: 'ACTIVE' }, select: { id: true } },
    },
  });

  const byTable = new Map<string, ActiveOrderSnapshot>();
  for (const order of orders) {
    if (order.tableId === null) continue;
    byTable.set(order.tableId, {
      orderId: order.id,
      status: order.status,
      hasActiveInvoice: order.invoices.length > 0,
      kotStatuses: order.kots.map((kot) => kot.status),
    });
  }
  return byTable;
}

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

export async function createArea(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  rawInput: unknown,
): Promise<FloorResponse> {
  const input = createAreaSchema.parse(rawInput);

  await assertAreaNameAvailable(prisma, restaurantId, input.name, null);

  await prisma.restaurantArea.create({
    data: {
      restaurantId,
      name: input.name,
      sortOrder: input.sortOrder ?? (await nextAreaSortOrder(prisma, restaurantId)),
    },
  });

  return getFloor(prisma, restaurantId, { includeInactive: true });
}

export async function updateArea(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  areaId: string,
  rawInput: unknown,
): Promise<FloorResponse> {
  const input = updateAreaSchema.parse(rawInput);
  const area = await findAreaOrThrow(prisma, restaurantId, areaId);

  if (input.name !== undefined && input.name !== area.name) {
    await assertAreaNameAvailable(prisma, restaurantId, input.name, areaId);
  }

  // Deactivating an area must not silently hide tables that are still in use.
  // Making it an explicit refusal means the manager deactivates the tables
  // first and sees exactly what they are switching off.
  if (input.isActive === false && area.isActive) {
    const activeTables = await prisma.restaurantTable.count({
      where: { restaurantId, areaId, isActive: true },
    });
    if (activeTables > 0) {
      throw new ApiError(
        409,
        'AREA_HAS_ACTIVE_TABLES',
        `"${area.name}" still has ${String(activeTables)} active table(s). ` +
          `Deactivate them first, or move them to another area.`,
      );
    }
  }

  await prisma.restaurantArea.update({
    where: { id: areaId },
    data: {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
      ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
    },
  });

  return getFloor(prisma, restaurantId, { includeInactive: true });
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

export async function createTable(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  rawInput: unknown,
): Promise<FloorResponse> {
  const input = createTableSchema.parse(rawInput);

  // Scoped lookup: an areaId from another restaurant reads as "not found"
  // rather than leaking that it exists.
  await findAreaOrThrow(prisma, restaurantId, input.areaId);
  await assertTableNameAvailable(prisma, restaurantId, input.name, null);

  await prisma.restaurantTable.create({
    data: {
      restaurantId,
      areaId: input.areaId,
      name: input.name,
      capacity: input.capacity ?? 4,
      sortOrder: input.sortOrder ?? (await nextTableSortOrder(prisma, restaurantId, input.areaId)),
    },
  });

  return getFloor(prisma, restaurantId, { includeInactive: true });
}

export async function updateTable(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  tableId: string,
  rawInput: unknown,
): Promise<FloorResponse> {
  const input = updateTableSchema.parse(rawInput);
  await prisma.$transaction(async (tx) => {
    // Lock before checking occupancy. A transfer and deactivation must serialize.
    await tx.$executeRaw`UPDATE "RestaurantTable" SET "id" = "id" WHERE "id" = ${tableId} AND "restaurantId" = ${restaurantId}`;
    const table = await findTableOrThrow(tx, restaurantId, tableId);

    if (input.areaId !== undefined && input.areaId !== table.areaId) {
      await findAreaOrThrow(tx, restaurantId, input.areaId);
    }
    if (input.name !== undefined && input.name !== table.name) {
      await assertTableNameAvailable(tx, restaurantId, input.name, tableId);
    }

    // A table with people sitting at it cannot be taken out of service. The
    // order would keep pointing at a table that no longer appears on the floor,
    // and nobody would be able to close the bill.
    if (input.isActive === false && table.isActive) {
      const activeOrders = await tx.order.count({
        where: { restaurantId, tableId, closedAt: null },
      });
      if (activeOrders > 0) {
        throw new ApiError(
          409,
          'TABLE_IN_USE',
          `"${table.name}" has an open order. Settle or void it before ` +
            `taking the table out of service.`,
        );
      }
    }

    await tx.restaurantTable.update({
      where: { id: tableId },
      data: {
        ...(input.areaId === undefined ? {} : { areaId: input.areaId }),
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.capacity === undefined ? {} : { capacity: input.capacity }),
        ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
      },
    });
  });
  return getFloor(prisma, restaurantId, { includeInactive: true });
}

// ---------------------------------------------------------------------------
// Shared guards
// ---------------------------------------------------------------------------

async function findAreaOrThrow(
  prisma: Pick<NayaroPrismaClient, 'restaurantArea' | 'restaurantTable' | 'order'>,
  restaurantId: string,
  areaId: string,
): Promise<{ id: string; name: string; isActive: boolean }> {
  const area = await prisma.restaurantArea.findFirst({
    where: { id: areaId, restaurantId },
    select: { id: true, name: true, isActive: true },
  });
  if (!area) throw new ApiError(404, 'AREA_NOT_FOUND', 'That area no longer exists.');
  return area;
}

async function findTableOrThrow(
  prisma: Pick<NayaroPrismaClient, 'restaurantArea' | 'restaurantTable' | 'order'>,
  restaurantId: string,
  tableId: string,
): Promise<{ id: string; name: string; areaId: string; isActive: boolean }> {
  const table = await prisma.restaurantTable.findFirst({
    where: { id: tableId, restaurantId },
    select: { id: true, name: true, areaId: true, isActive: true },
  });
  if (!table) throw new ApiError(404, 'TABLE_NOT_FOUND', 'That table no longer exists.');
  return table;
}

/**
 * Name checks are done here rather than left to the unique index so the user
 * gets "There is already an area called Rooftop" instead of a database error.
 * The index remains the real guarantee; this is the readable path.
 */
async function assertAreaNameAvailable(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  name: string,
  exceptAreaId: string | null,
): Promise<void> {
  const existing = await prisma.restaurantArea.findFirst({
    where: { restaurantId, name },
    select: { id: true },
  });
  if (existing && existing.id !== exceptAreaId) {
    throw new ApiError(409, 'AREA_NAME_TAKEN', `There is already an area called "${name}".`);
  }
}

async function assertTableNameAvailable(
  prisma: Pick<NayaroPrismaClient, 'restaurantArea' | 'restaurantTable' | 'order'>,
  restaurantId: string,
  name: string,
  exceptTableId: string | null,
): Promise<void> {
  const existing = await prisma.restaurantTable.findFirst({
    where: { restaurantId, name },
    select: { id: true },
  });
  if (existing && existing.id !== exceptTableId) {
    // Table names are unique per RESTAURANT, not per area, so "Table 1" cannot
    // exist both downstairs and on the roof. That is intentional for V1: a KOT
    // that just says "Table 1" has to be unambiguous to the kitchen.
    throw new ApiError(
      409,
      'TABLE_NAME_TAKEN',
      `There is already a table called "${name}". Table names must be unique across the restaurant.`,
    );
  }
}

async function nextAreaSortOrder(
  prisma: NayaroPrismaClient,
  restaurantId: string,
): Promise<number> {
  const last = await prisma.restaurantArea.findFirst({
    where: { restaurantId },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  });
  return (last?.sortOrder ?? -1) + 1;
}

async function nextTableSortOrder(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  areaId: string,
): Promise<number> {
  const last = await prisma.restaurantTable.findFirst({
    where: { restaurantId, areaId },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  });
  return (last?.sortOrder ?? -1) + 1;
}
