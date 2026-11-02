import { z } from 'zod';

/**
 * Menu management input validation.
 *
 * Every field is whitelisted and mapped deliberately by the service. Nothing
 * here is spread into a Prisma `data` object: `update({ data: req.body })`
 * would let a client set `restaurantId` and move a dish into somebody else's
 * restaurant.
 */

const name = z.string().trim().min(1, 'A name is required.').max(80, 'That name is too long.');
const nameNp = z.string().trim().max(80);
/** Up to Rs 100,000 for one dish. Generous, and it catches a paisa/rupee mix-up. */
const pricePaisa = z
  .int()
  .min(0, 'A price cannot be negative.')
  .max(10_000_000, 'That price looks wrong. Prices are in paisa.');
const sortOrder = z.int().min(0).max(9999);

export const createMenuCategorySchema = z.object({
  name,
  nameNp: nameNp.optional(),
});

export const updateMenuCategorySchema = z
  .object({
    name: name.optional(),
    // Explicit null clears the Nepali name; omitting leaves it alone.
    nameNp: nameNp.nullable().optional(),
    sortOrder: sortOrder.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update.' });

export const componentsSchema = z
  .array(
    z.object({
      menuItemId: z.string().min(1),
      quantity: z.int().min(1).max(99),
    }),
  )
  .max(30)
  .refine(
    (rows) => new Set(rows.map((row) => row.menuItemId)).size === rows.length,
    'Choose each dish only once.',
  );

export const createMenuItemSchema = z.object({
  categoryId: z.string().min(1, 'Choose a category.'),
  name,
  nameNp: nameNp.optional(),
  pricePaisa,
  components: componentsSchema.optional(),
});

export const updateMenuItemSchema = z
  .object({
    name: name.optional(),
    nameNp: nameNp.nullable().optional(),
    categoryId: z.string().min(1).optional(),
    pricePaisa: pricePaisa.optional(),
    components: componentsSchema.optional(),
    isAvailable: z.boolean().optional(),
    isActive: z.boolean().optional(),
    sortOrder: sortOrder.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'Nothing to update.' });
