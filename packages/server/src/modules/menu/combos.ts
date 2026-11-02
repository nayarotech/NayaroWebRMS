import { z } from 'zod';
import type { NayaroPrismaClient } from '@nayaro/database';
import type { ComboComponent } from '@nayaro/shared';
import { ApiError } from '../../utils/apiError';
import { componentsSchema } from './menu.schema';

type Client = Pick<NayaroPrismaClient, 'menuItem'>;
const snapshotSchema = z.array(
  z.object({
    menuItemId: z.string(),
    quantity: z.int().min(1),
    name: z.string(),
    nameNp: z.string().nullable(),
  }),
);
export const readComponents = (raw: string) => componentsSchema.parse(JSON.parse(raw));
export const readComboSnapshot = (raw: string) => snapshotSchema.parse(JSON.parse(raw));

/** Called inside the catalogue write transaction; nested bundles are deliberately excluded. */
export async function validateComponents(
  client: Client,
  restaurantId: string,
  components: readonly ComboComponent[],
  itemId?: string,
) {
  if (components.length === 0) return;
  const dishes = await client.menuItem.findMany({
    where: {
      restaurantId,
      id: { in: components.map((row) => row.menuItemId) },
      isActive: true,
      category: { isActive: true },
    },
  });
  if (
    dishes.length !== components.length ||
    dishes.some((dish) => dish.id === itemId || readComponents(dish.comboComponents).length > 0)
  ) {
    throw new ApiError(
      409,
      'INVALID_COMBO',
      'Choose active individual dishes from this restaurant. Bundles cannot contain other bundles.',
    );
  }
  if (itemId) {
    const parents = await client.menuItem.findMany({
      where: { restaurantId },
      select: { comboComponents: true },
    });
    if (
      parents.some((row) =>
        readComponents(row.comboComponents).some((part) => part.menuItemId === itemId),
      )
    )
      throw new ApiError(
        409,
        'DISH_IN_COMBO',
        'This dish belongs to a bundle. Remove it from that bundle before making it a bundle.',
      );
    const item = await client.menuItem.findUniqueOrThrow({
      where: { id: itemId },
      select: { recipe: true },
    });
    if (item.recipe.length > 0)
      throw new ApiError(
        409,
        'COMBO_HAS_RECIPE',
        'Clear this dish’s ingredient recipe before making it a bundle. Bundles consume their dishes’ recipes.',
      );
  }
}

/** Aggregate shared ingredients across all component dishes for one bundle. */
export async function resolveCombo(client: Client, restaurantId: string, raw: string) {
  const components = readComponents(raw);
  if (components.length === 0) return { snapshot: [], available: true };
  const dishes = await client.menuItem.findMany({
    where: {
      restaurantId,
      id: { in: components.map((row) => row.menuItemId) },
    },
    include: { category: true, recipe: { include: { ingredient: true } } },
  });
  const demand = new Map<string, { quantity: number; onHand: number; active: boolean }>();
  let available = dishes.length === components.length;
  const snapshot = components.map((part) => {
    const dish = dishes.find((row) => row.id === part.menuItemId);
    if (!dish) {
      available = false;
      return { ...part, name: '', nameNp: null };
    }
    available &&=
      dish.isActive &&
      dish.isAvailable &&
      dish.category.isActive &&
      readComponents(dish.comboComponents).length === 0;
    for (const recipe of dish.recipe) {
      const quantity =
        (demand.get(recipe.ingredientId)?.quantity ?? 0) + recipe.quantityMilli * part.quantity;
      demand.set(recipe.ingredientId, {
        quantity,
        onHand: recipe.ingredient.onHandMilli,
        active: recipe.ingredient.isActive,
      });
    }
    return { ...part, name: dish.name, nameNp: dish.nameNp };
  });
  return {
    snapshot,
    available:
      available && [...demand.values()].every((row) => row.active && row.onHand >= row.quantity),
  };
}
