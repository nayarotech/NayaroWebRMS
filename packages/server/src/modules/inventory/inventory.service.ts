import { readComboSnapshot, resolveCombo } from '../menu/combos';
import { z } from 'zod';
import type { NayaroPrismaClient } from '@nayaro/database';
import type { AvailabilityResponse, IngredientDto, InventoryResponse } from '@nayaro/shared';
import { ApiError } from '../../utils/apiError';
import { resolveBusinessDate } from '../../utils/businessDate';
import { correctionReason } from '../../utils/correction';
import type { Transaction } from '../../utils/idempotency';
import { linkedPayOut } from '../drawer/drawer.service';

const quantity = z.int().min(0).max(1_000_000_000);
export const ingredientSchema = z.object({
  name: z.string().trim().min(1).max(100),
  unit: z.enum(['g', 'ml', 'each']),
  lowStockMilli: quantity,
});
export const stockSchema = z
  .object({
    expectedVersion: z.int().min(0),
    kind: z.enum(['PURCHASE', 'COUNT', 'WASTE']),
    quantityMilli: quantity,
    reason: correctionReason,
    supplier: z.string().trim().max(160).optional(),
    costPaisa: quantity.optional(),
    expenseId: z.string().min(1).optional(),
    method: z.enum(['CASH', 'QR', 'CARD']).optional(),
    fromDrawer: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind !== 'COUNT' && value.quantityMilli === 0)
      ctx.addIssue({ code: 'custom', message: 'Enter a positive quantity.' });
    if (
      value.kind !== 'PURCHASE' &&
      (value.costPaisa !== undefined ||
        value.expenseId ||
        value.method ||
        value.fromDrawer ||
        value.supplier)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Cost, supplier and expense details belong only to purchases.',
      });
    if (
      value.kind === 'PURCHASE' &&
      (value.costPaisa ?? 0) > 0 &&
      !value.expenseId &&
      !value.method
    )
      ctx.addIssue({ code: 'custom', message: 'Choose how the purchase was paid.' });
    if (value.expenseId && !(value.costPaisa && value.costPaisa > 0))
      ctx.addIssue({ code: 'custom', message: 'Enter the cost of the linked purchase.' });
    if (value.fromDrawer && value.method !== 'CASH')
      ctx.addIssue({ code: 'custom', message: 'Only cash purchases can use the drawer.' });
  });
export const recipeSchema = z
  .object({
    expectedVersion: z.int().min(0),
    reason: correctionReason,
    ingredients: z
      .array(z.object({ ingredientId: z.string().min(1), quantityMilli: quantity.min(1) }))
      .max(100),
  })
  .refine(
    (value) =>
      new Set(value.ingredients.map((row) => row.ingredientId)).size === value.ingredients.length,
    'Choose each ingredient only once.',
  );

export async function availability(
  client: Pick<NayaroPrismaClient, 'menuItem'>,
  restaurantId: string,
): Promise<AvailabilityResponse> {
  const items = await client.menuItem.findMany({
    where: { restaurantId, isActive: true, category: { isActive: true } },
    include: { category: { select: { name: true } }, recipe: { include: { ingredient: true } } },
    orderBy: [{ category: { sortOrder: 'asc' } }, { sortOrder: 'asc' }, { name: 'asc' }],
  });
  return {
    items: await Promise.all(
      items.map(async (item) => ({
        id: item.id,
        name: item.name,
        category: item.category.name,
        isAvailable: item.isAvailable,
        recipeVersion: item.recipeVersion,
        stockAvailable:
          (await resolveCombo(client, restaurantId, item.comboComponents)).available &&
          item.recipe.every(
            (row) => row.ingredient.isActive && row.ingredient.onHandMilli >= row.quantityMilli,
          ),
      })),
    ),
  };
}
export async function inventory(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  rawQuery: unknown,
): Promise<InventoryResponse> {
  const query = z
    .object({ ingredientId: z.string().optional(), before: z.string().optional() })
    .parse(rawQuery);
  if (
    query.before &&
    !(await prisma.stockMovement.findFirst({
      where: {
        id: query.before,
        restaurantId,
        ...(query.ingredientId ? { ingredientId: query.ingredientId } : {}),
      },
    }))
  )
    throw new ApiError(404, 'MOVEMENT_NOT_FOUND', 'That stock entry does not exist.');
  const [ingredients, movements, recipes, menu, recipeChanges, availabilityChanges] =
    await Promise.all([
      prisma.ingredient.findMany({
        where: { restaurantId },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
      }),
      prisma.stockMovement.findMany({
        where: {
          restaurantId,
          ...(query.ingredientId ? { ingredientId: query.ingredientId } : {}),
        },
        include: {
          ingredient: { select: { name: true, unit: true } },
          staff: { select: { id: true, name: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 201,
        ...(query.before ? { cursor: { id: query.before }, skip: 1 } : {}),
      }),
      prisma.recipeIngredient.findMany({ where: { menuItem: { restaurantId } } }),
      availability(prisma, restaurantId),
      prisma.recipeChange.findMany({
        where: { restaurantId },
        include: { menuItem: { select: { name: true } }, staff: { select: { name: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
      }),
      prisma.menuAvailabilityChange.findMany({
        where: { restaurantId },
        include: { menuItem: { select: { name: true } }, staff: { select: { name: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
      }),
    ]);
  return {
    ingredients: ingredients.map((row) => ({
      ...row,
      unit: row.unit as IngredientDto['unit'],
      lowStock: row.isActive && row.onHandMilli <= row.lowStockMilli,
    })),
    movements: movements
      .slice(0, 200)
      .map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    moreMovements: movements.length > 200,
    recipes,
    menu: menu.items,
    recipeChanges: recipeChanges.map((row) => ({ ...row, createdAt: row.createdAt.toISOString() })),
    availabilityChanges: availabilityChanges.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}
export async function recordStock(
  tx: Transaction,
  restaurantId: string,
  staffId: string,
  ingredientId: string,
  raw: unknown,
) {
  const input = stockSchema.parse(raw);
  const ingredient = await tx.ingredient.findFirst({ where: { id: ingredientId, restaurantId } });
  if (!ingredient)
    throw new ApiError(404, 'INGREDIENT_NOT_FOUND', 'That ingredient does not exist.');
  if (!ingredient.isActive)
    throw new ApiError(
      409,
      'INGREDIENT_INACTIVE',
      'Reactivate this ingredient before recording stock.',
    );
  const deltaMilli =
    input.kind === 'COUNT'
      ? input.quantityMilli - ingredient.onHandMilli
      : input.kind === 'WASTE'
        ? -input.quantityMilli
        : input.quantityMilli;
  const next = ingredient.onHandMilli + deltaMilli;
  if (next < 0 || next > 1_000_000_000)
    throw new ApiError(
      409,
      'INVALID_STOCK_BALANCE',
      'That adjustment would leave an invalid stock balance.',
    );
  const claimed = await tx.ingredient.updateMany({
    where: { id: ingredientId, restaurantId, version: input.expectedVersion },
    data: { onHandMilli: next, version: { increment: 1 } },
  });
  if (claimed.count !== 1)
    throw new ApiError(
      409,
      'STOCK_CHANGED',
      'Stock changed on another device. Refresh and check the quantity.',
    );
  const settings = await tx.restaurantSettings.findUniqueOrThrow({ where: { restaurantId } });
  const businessDate = resolveBusinessDate(new Date(), settings.businessDayStartsAtMinutes, settings.timezone);
  let expenseId: string | null = null;
  if (input.kind === 'PURCHASE' && input.expenseId) {
    const expense = await tx.expense.findFirst({
      where: { id: input.expenseId, restaurantId, amountPaisa: input.costPaisa! },
      include: { stockMovement: true },
    });
    if (!expense || expense.stockMovement)
      throw new ApiError(
        409,
        'EXPENSE_UNAVAILABLE',
        'Choose an unlinked expense for the exact purchase cost.',
      );
    expenseId = expense.id;
  } else if (input.kind === 'PURCHASE' && (input.costPaisa ?? 0) > 0) {
    const cashMovementId = input.fromDrawer
      ? await linkedPayOut(
          tx,
          restaurantId,
          staffId,
          input.costPaisa!,
          `Stock purchase: ${ingredient.name}`,
        )
      : null;
    expenseId = (
      await tx.expense.create({
        data: {
          restaurantId,
          staffId,
          amountPaisa: input.costPaisa!,
          method: input.method!,
          category: 'Ingredients',
          supplier: input.supplier || null,
          note: input.reason,
          businessDate,
          cashMovementId,
        },
      })
    ).id;
  }
  const row = await tx.stockMovement.create({
    data: {
      restaurantId,
      ingredientId,
      staffId,
      kind: input.kind,
      deltaMilli,
      balanceAfterMilli: next,
      reason: input.reason,
      supplier: input.supplier || null,
      costPaisa: input.costPaisa ?? null,
      expenseId,
      businessDate,
    },
  });
  return { movement: { ...row, createdAt: row.createdAt.toISOString() } };
}

/** Called inside the dispatch transaction. No ticket or stock survives a failure. */
export async function consumeRecipeStock(
  tx: Transaction,
  restaurantId: string,
  staffId: string,
  kotId: string,
  lines: readonly { orderItemId: string; quantity: number }[],
) {
  const items = await tx.orderItem.findMany({
    where: { id: { in: lines.map((line) => line.orderItemId) }, order: { restaurantId } },
    include: { menuItem: { include: { recipe: { include: { ingredient: true } } } } },
  });
  const demand = new Map<
    string,
    {
      quantity: number;
      ingredient: (typeof items)[number]['menuItem']['recipe'][number]['ingredient'];
    }
  >();
  for (const item of items) {
    const count = lines.find((line) => line.orderItemId === item.id)!.quantity;
    if (!item.menuItem.isAvailable || !item.menuItem.isActive)
      throw new ApiError(
        409,
        'MENU_ITEM_UNAVAILABLE',
        `${item.nameSnapshot} is unavailable. Remove unsent items or ask the kitchen to update availability.`,
      );
    const components = readComboSnapshot(item.comboSnapshot);
    const dishes =
      components.length === 0
        ? [{ dish: item.menuItem, quantity: 1 }]
        : await Promise.all(
            components.map(async (part) => {
              const dish = await tx.menuItem.findFirst({
                where: { id: part.menuItemId, restaurantId },
                include: { recipe: { include: { ingredient: true } }, category: true },
              });
              if (
                !dish ||
                !dish.isActive ||
                !dish.isAvailable ||
                !dish.category.isActive ||
                dish.comboComponents !== '[]'
              )
                throw new ApiError(
                  409,
                  'COMBO_UNAVAILABLE',
                  `${part.name} in ${item.nameSnapshot} is unavailable.`,
                );
              return { dish, quantity: part.quantity };
            }),
          );
    for (const { dish, quantity } of dishes)
      for (const recipe of dish.recipe) {
        const total =
          (demand.get(recipe.ingredientId)?.quantity ?? 0) +
          recipe.quantityMilli * count * quantity;
        if (!Number.isSafeInteger(total) || total > 1_000_000_000)
          throw new ApiError(
            409,
            'STOCK_DEMAND_TOO_LARGE',
            'The recipe quantities exceed the stock limit.',
          );
        demand.set(recipe.ingredientId, { quantity: total, ingredient: recipe.ingredient });
      }
  }
  const settings = await tx.restaurantSettings.findUniqueOrThrow({ where: { restaurantId } });
  const businessDate = resolveBusinessDate(new Date(), settings.businessDayStartsAtMinutes, settings.timezone);
  for (const [ingredientId, { quantity, ingredient }] of [...demand].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!ingredient.isActive || ingredient.onHandMilli < quantity)
      throw new ApiError(
        409,
        'INSUFFICIENT_STOCK',
        `Not enough ${ingredient.name} for this kitchen dispatch. Check stock or adjust the unsent quantities.`,
      );
    const changed = await tx.ingredient.updateMany({
      where: {
        id: ingredientId,
        restaurantId,
        version: ingredient.version,
        onHandMilli: { gte: quantity },
        isActive: true,
      },
      data: { onHandMilli: { decrement: quantity }, version: { increment: 1 } },
    });
    if (changed.count !== 1)
      throw new ApiError(
        409,
        'STOCK_CHANGED',
        'Stock changed during dispatch. Refresh before sending again.',
      );
    await tx.stockMovement.create({
      data: {
        restaurantId,
        ingredientId,
        staffId,
        kind: 'DISPATCH',
        deltaMilli: -quantity,
        balanceAfterMilli: ingredient.onHandMilli - quantity,
        reason: `Kitchen ticket ${kotId}`,
        kotId,
        businessDate,
      },
    });
  }
}
