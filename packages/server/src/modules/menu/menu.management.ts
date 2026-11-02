import type { NayaroPrismaClient } from '@nayaro/database';
import type { ManagedMenuResponse } from '@nayaro/shared';
import { readComponents, validateComponents } from './combos';
import { ApiError } from '../../utils/apiError';
import {
  createMenuCategorySchema,
  createMenuItemSchema,
  updateMenuCategorySchema,
  updateMenuItemSchema,
} from './menu.schema';

/**
 * Menu management: the screen an owner uses to say what the restaurant sells.
 *
 * TWO FLAGS, TWO MEANINGS, and keeping them apart is the whole design:
 *
 *   isAvailable  sold out TODAY. Flipped constantly during service by whoever
 *                is nearest the screen. The dish stays on the menu and comes
 *                back tomorrow.
 *   isActive     catalogue membership. A dish taken off the menu for good.
 *                Never deleted, because every historical OrderItem points at it.
 *
 * NOTHING here deletes. The `OrderItem -> MenuItem` foreign key is RESTRICT, so
 * a dish that has ever been ordered cannot be removed even by mistake - the
 * database enforces what this service promises.
 *
 * Editing a live item does NOT rewrite history: orders carry their own name and
 * price snapshots, taken when the item was added. Renaming "Chicken Momo" to
 * "Chicken Momo (Half)" changes tomorrow's menu and nothing about yesterday's
 * bills.
 */

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The whole catalogue, including what the POS hides.
 *
 * Deliberately different from `getMenu`, which serves the till and shows only
 * what can be sold right now. A manager comes to this screen precisely to find
 * the sold-out and retired items, so hiding them would hide the work.
 */
export async function getManagedMenu(
  prisma: NayaroPrismaClient,
  restaurantId: string,
): Promise<ManagedMenuResponse> {
  const categories = await prisma.menuCategory.findMany({
    where: { restaurantId },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      nameNp: true,
      sortOrder: true,
      isActive: true,
      items: {
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: {
          id: true,
          name: true,
          nameNp: true,
          categoryId: true,
          pricePaisa: true,
          comboComponents: true,
          isAvailable: true,
          isActive: true,
          sortOrder: true,
        },
      },
    },
  });
  return {
    categories: categories.map((category) => ({
      ...category,
      items: category.items.map(({ comboComponents, ...item }) => ({
        ...item,
        components: readComponents(comboComponents),
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export async function createCategory(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  rawInput: unknown,
): Promise<ManagedMenuResponse> {
  const input = createMenuCategorySchema.parse(rawInput);
  await assertCategoryNameFree(prisma, restaurantId, input.name, null);

  await prisma.menuCategory.create({
    data: {
      restaurantId,
      name: input.name,
      nameNp: input.nameNp ?? null,
      sortOrder: await nextCategorySortOrder(prisma, restaurantId),
    },
  });
  return getManagedMenu(prisma, restaurantId);
}

export async function updateCategory(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  categoryId: string,
  rawInput: unknown,
): Promise<ManagedMenuResponse> {
  const input = updateMenuCategorySchema.parse(rawInput);
  const category = await findCategoryOrThrow(prisma, restaurantId, categoryId);

  if (input.name !== undefined && input.name !== category.name) {
    await assertCategoryNameFree(prisma, restaurantId, input.name, categoryId);
  }

  // Retiring a category must not silently retire the dishes inside it. Doing
  // that quietly would take items off the menu that nobody decided to remove,
  // and the manager would discover it when a customer asked for one. Refuse,
  // and say how many are in the way.
  if (input.isActive === false && category.isActive) {
    const activeItems = await prisma.menuItem.count({
      where: { restaurantId, categoryId, isActive: true },
    });
    if (activeItems > 0) {
      throw new ApiError(
        409,
        'CATEGORY_HAS_ACTIVE_ITEMS',
        `"${category.name}" still has ${String(activeItems)} item(s) on the menu. ` +
          `Remove or move them first.`,
      );
    }
  }

  await prisma.menuCategory.update({
    where: { id: categoryId },
    data: {
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.nameNp === undefined ? {} : { nameNp: normaliseOptional(input.nameNp) }),
      ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
      ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
    },
  });
  return getManagedMenu(prisma, restaurantId);
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export async function createItem(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  rawInput: unknown,
): Promise<ManagedMenuResponse> {
  const input = createMenuItemSchema.parse(rawInput);
  const category = await findCategoryOrThrow(prisma, restaurantId, input.categoryId);
  if (!category.isActive) {
    throw new ApiError(
      409,
      'CATEGORY_INACTIVE',
      `"${category.name}" is not on the menu. Put the category back before adding items to it.`,
    );
  }
  await assertItemNameFree(prisma, restaurantId, input.name, null);

  await prisma.$transaction(async (tx) => {
    await validateComponents(tx, restaurantId, input.components ?? []);
    await tx.menuItem.create({
      data: {
        restaurantId,
        categoryId: input.categoryId,
        name: input.name,
        nameNp: input.nameNp ?? null,
        pricePaisa: input.pricePaisa,
        comboComponents: JSON.stringify(input.components ?? []),
        sortOrder: await nextItemSortOrder(tx, restaurantId, input.categoryId),
      },
    });
  });
  return getManagedMenu(prisma, restaurantId);
}

export async function updateItem(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  itemId: string,
  rawInput: unknown,
): Promise<ManagedMenuResponse> {
  const input = updateMenuItemSchema.parse(rawInput);
  const item = await findItemOrThrow(prisma, restaurantId, itemId);

  if (input.name !== undefined && input.name !== item.name) {
    await assertItemNameFree(prisma, restaurantId, input.name, itemId);
  }
  if (input.categoryId !== undefined && input.categoryId !== item.categoryId) {
    const target = await findCategoryOrThrow(prisma, restaurantId, input.categoryId);
    if (!target.isActive) {
      throw new ApiError(
        409,
        'CATEGORY_INACTIVE',
        `"${target.name}" is not on the menu, so items cannot be moved into it.`,
      );
    }
  }

  await prisma.$transaction(async (tx) => {
    if (input.components !== undefined)
      await validateComponents(tx, restaurantId, input.components, itemId);
    await tx.menuItem.update({
      where: { id: itemId },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.nameNp === undefined ? {} : { nameNp: normaliseOptional(input.nameNp) }),
        ...(input.categoryId === undefined ? {} : { categoryId: input.categoryId }),
        ...(input.pricePaisa === undefined ? {} : { pricePaisa: input.pricePaisa }),
        ...(input.components === undefined
          ? {}
          : { comboComponents: JSON.stringify(input.components) }),
        ...(input.isAvailable === undefined ? {} : { isAvailable: input.isAvailable }),
        ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
        ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
      },
    });
  });
  return getManagedMenu(prisma, restaurantId);
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

async function findCategoryOrThrow(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  categoryId: string,
): Promise<{ id: string; name: string; isActive: boolean }> {
  const category = await prisma.menuCategory.findFirst({
    where: { id: categoryId, restaurantId },
    select: { id: true, name: true, isActive: true },
  });
  if (!category) throw new ApiError(404, 'CATEGORY_NOT_FOUND', 'That category no longer exists.');
  return category;
}

async function findItemOrThrow(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  itemId: string,
): Promise<{ id: string; name: string; categoryId: string }> {
  const item = await prisma.menuItem.findFirst({
    where: { id: itemId, restaurantId },
    select: { id: true, name: true, categoryId: true },
  });
  if (!item) throw new ApiError(404, 'MENU_ITEM_NOT_FOUND', 'That item no longer exists.');
  return item;
}

/**
 * Names are unique per restaurant, and checked here so the user reads "There is
 * already an item called Coke" instead of a database error. The unique index
 * remains the real guarantee.
 */
async function assertCategoryNameFree(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  name: string,
  exceptId: string | null,
): Promise<void> {
  const existing = await prisma.menuCategory.findFirst({
    where: { restaurantId, name },
    select: { id: true },
  });
  if (existing && existing.id !== exceptId) {
    throw new ApiError(409, 'CATEGORY_NAME_TAKEN', `There is already a category called "${name}".`);
  }
}

async function assertItemNameFree(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  name: string,
  exceptId: string | null,
): Promise<void> {
  const existing = await prisma.menuItem.findFirst({
    where: { restaurantId, name },
    select: { id: true, isActive: true },
  });
  if (existing && existing.id !== exceptId) {
    throw new ApiError(
      409,
      'MENU_ITEM_NAME_TAKEN',
      existing.isActive
        ? `There is already an item called "${name}".`
        : `A retired item is still called "${name}". Rename it, or put it back on the menu instead.`,
    );
  }
}

/** New things go at the end of the list they belong to. */
async function nextCategorySortOrder(
  prisma: NayaroPrismaClient,
  restaurantId: string,
): Promise<number> {
  const last = await prisma.menuCategory.findFirst({
    where: { restaurantId },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  });
  return (last?.sortOrder ?? -1) + 1;
}

async function nextItemSortOrder(
  prisma: Pick<NayaroPrismaClient, 'menuItem'>,
  restaurantId: string,
  categoryId: string,
): Promise<number> {
  const last = await prisma.menuItem.findFirst({
    where: { restaurantId, categoryId },
    orderBy: { sortOrder: 'desc' },
    select: { sortOrder: true },
  });
  return (last?.sortOrder ?? -1) + 1;
}

/** Empty string means "clear it", not "store a blank". */
function normaliseOptional(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
