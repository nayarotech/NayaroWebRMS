import { Router } from 'express';
import { z } from 'zod';
import type { NayaroPrismaClient } from '@nayaro/database';
import { requireAuthContext, requireRole } from '../../middleware/authentication';
import { ApiError } from '../../utils/apiError';
import { correctionReason } from '../../utils/correction';
import { resolveBusinessDate } from '../../utils/businessDate';
import {
  readIdempotencyAttempt,
  withRequestReceipt,
  type Transaction,
} from '../../utils/idempotency';
import type { RealtimeEmitter } from '../../socket/realtimeEmitter';
import {
  availability,
  ingredientSchema,
  inventory,
  recipeSchema,
  recordStock,
  stockSchema,
} from './inventory.service';

export function createInventoryRouter(
  prisma: NayaroPrismaClient,
  realtime: RealtimeEmitter,
): Router {
  const router = Router();
  router.get('/menu/availability', async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(await availability(prisma, staff.restaurantId));
  });
  router.use('/inventory', requireRole('OWNER', 'MANAGER'));
  router.get('/inventory/alerts', async (req, res) => {
    const { staff } = requireAuthContext(req);
    const ingredients = await prisma.ingredient.findMany({
      where: { restaurantId: staff.restaurantId, isActive: true },
      select: { id: true, name: true, onHandMilli: true, lowStockMilli: true },
    });
    res.json({
      ingredients: ingredients
        .filter((row) => row.onHandMilli <= row.lowStockMilli)
        .map((row) => ({ id: row.id, name: row.name })),
    });
  });
  router.get('/inventory', async (req, res) => {
    const { staff } = requireAuthContext(req);
    res.json(await inventory(prisma, staff.restaurantId, req.query));
  });
  const mutation = (
    path: string,
    schema: z.ZodType,
    work: (
      tx: Transaction,
      restaurantId: string,
      staffId: string,
      id: string,
      raw: unknown,
    ) => Promise<unknown>,
  ) => {
    router.post(path, async (req, res) => {
      const { staff } = requireAuthContext(req);
      const id = typeof req.params['id'] === 'string' ? req.params['id'] : '';
      const input = schema.parse(req.body);
      const attempt = readIdempotencyAttempt(req);
      if (!attempt.key)
        throw new ApiError(400, 'REQUEST_KEY_REQUIRED', 'A request identifier is required.');
      const result = await withRequestReceipt(
        prisma,
        staff.restaurantId,
        staff.id,
        `${path}:${id}`,
        input,
        attempt,
        (tx) => work(tx, staff.restaurantId, staff.id, id, input),
      );
      if (!attempt.replayed) realtime.menuUpdated({ restaurantId: staff.restaurantId });
      res.status(201).json(result);
    });
  };
  mutation(
    '/inventory/ingredients',
    ingredientSchema,
    async (tx, restaurantId, _staffId, _id, raw) => {
      const input = ingredientSchema.parse(raw);
      if (await tx.ingredient.findFirst({ where: { restaurantId, name: input.name } }))
        throw new ApiError(409, 'INGREDIENT_EXISTS', 'That ingredient already exists.');
      return { ingredient: await tx.ingredient.create({ data: { restaurantId, ...input } }) };
    },
  );
  mutation('/inventory/ingredients/:id/stock', stockSchema, recordStock);
  const settingsSchema = z.object({
    expectedVersion: z.int().min(0),
    lowStockMilli: z.int().min(0).max(1_000_000_000),
    isActive: z.boolean(),
    reason: correctionReason,
  });
  mutation(
    '/inventory/ingredients/:id/settings',
    settingsSchema,
    async (tx, restaurantId, staffId, id, raw) => {
      const input = settingsSchema.parse(raw);
      const ingredient = await tx.ingredient.findFirst({ where: { id, restaurantId } });
      if (!ingredient)
        throw new ApiError(404, 'INGREDIENT_NOT_FOUND', 'That ingredient does not exist.');
      const changed = await tx.ingredient.updateMany({
        where: { id, restaurantId, version: input.expectedVersion },
        data: {
          lowStockMilli: input.lowStockMilli,
          isActive: input.isActive,
          version: { increment: 1 },
        },
      });
      if (changed.count !== 1)
        throw new ApiError(409, 'STOCK_CHANGED', 'That ingredient changed. Refresh and try again.');
      const settings = await tx.restaurantSettings.findUniqueOrThrow({ where: { restaurantId } });
      await tx.stockMovement.create({
        data: {
          restaurantId,
          ingredientId: id,
          staffId,
          kind: 'SETTINGS',
          deltaMilli: 0,
          balanceAfterMilli: ingredient.onHandMilli,
          reason: `Settings (threshold ${input.lowStockMilli / 1000} ${ingredient.unit}, ${input.isActive ? 'active' : 'inactive'}): ${input.reason}`,
          businessDate: resolveBusinessDate(new Date(), settings.businessDayStartsAtMinutes, settings.timezone),
        },
      });
      return { updated: true };
    },
  );
  mutation('/inventory/recipes/:id', recipeSchema, async (tx, restaurantId, staffId, id, raw) => {
    const input = recipeSchema.parse(raw);
    const menuItem = await tx.menuItem.findFirst({ where: { id, restaurantId } });
    if (!menuItem) throw new ApiError(404, 'MENU_ITEM_NOT_FOUND', 'That dish does not exist.');
    if (menuItem.comboComponents !== '[]')
      throw new ApiError(
        409,
        'COMBO_RECIPE',
        'Edit ingredient recipes on the individual dishes in this bundle.',
      );
    const ingredients = await tx.ingredient.count({
      where: {
        id: { in: input.ingredients.map((row) => row.ingredientId) },
        restaurantId,
        isActive: true,
      },
    });
    if (ingredients !== input.ingredients.length)
      throw new ApiError(
        409,
        'INGREDIENT_UNAVAILABLE',
        'Choose active ingredients belonging to this restaurant.',
      );
    const changed = await tx.menuItem.updateMany({
      where: { id, restaurantId, recipeVersion: input.expectedVersion },
      data: { recipeVersion: { increment: 1 } },
    });
    if (changed.count !== 1)
      throw new ApiError(
        409,
        'RECIPE_CHANGED',
        'That recipe changed. Refresh and check it before saving.',
      );
    const previous = await tx.recipeIngredient.findMany({
      where: { menuItemId: id },
      include: { ingredient: { select: { name: true, unit: true } } },
    });
    const next = await tx.ingredient.findMany({
      where: { id: { in: input.ingredients.map((row) => row.ingredientId) }, restaurantId },
      select: { id: true, name: true, unit: true },
    });
    await tx.recipeChange.create({
      data: {
        restaurantId,
        menuItemId: id,
        staffId,
        reason: input.reason,
        beforeJson: JSON.stringify(
          previous.map((row) => ({
            ingredientId: row.ingredientId,
            name: row.ingredient.name,
            unit: row.ingredient.unit,
            quantityMilli: row.quantityMilli,
          })),
        ),
        afterJson: JSON.stringify(
          input.ingredients.map((row) => ({
            ...row,
            name: next.find((ingredient) => ingredient.id === row.ingredientId)!.name,
            unit: next.find((ingredient) => ingredient.id === row.ingredientId)!.unit,
          })),
        ),
      },
    });
    await tx.recipeIngredient.deleteMany({ where: { menuItemId: id } });
    if (input.ingredients.length)
      await tx.recipeIngredient.createMany({
        data: input.ingredients.map((row) => ({ menuItemId: id, ...row })),
      });
    return { saved: true };
  });
  const availableSchema = z.object({
    expectedIsAvailable: z.boolean(),
    isAvailable: z.boolean(),
    reason: correctionReason,
  });
  mutation(
    '/menu/availability/:id',
    availableSchema,
    async (tx, restaurantId, staffId, id, raw) => {
      const input = availableSchema.parse(raw);
      const changed = await tx.menuItem.updateMany({
        where: { id, restaurantId, isActive: true, isAvailable: input.expectedIsAvailable },
        data: { isAvailable: input.isAvailable },
      });
      if (changed.count !== 1)
        throw new ApiError(
          409,
          'AVAILABILITY_CHANGED',
          'Dish availability changed. Refresh before trying again.',
        );
      await tx.menuAvailabilityChange.create({
        data: {
          restaurantId,
          staffId,
          menuItemId: id,
          isAvailable: input.isAvailable,
          reason: input.reason,
        },
      });
      return { saved: true };
    },
  );
  return router;
}
