import { z } from 'zod';

/**
 * Floor input validation.
 *
 * Note what is absent from every schema: restaurantId. It is never accepted
 * from the client - it comes from the authenticated session, so a caller
 * cannot address another restaurant's floor by guessing an id.
 */
const name = z.string().trim().min(1, 'Name is required.').max(60, 'Name is too long.');

const sortOrder = z.int().min(0).max(9999);
const capacity = z.int().min(1, 'Capacity must be at least 1.').max(99);

export const createAreaSchema = z.object({
  name,
  sortOrder: sortOrder.optional(),
});

export const updateAreaSchema = z
  .object({
    name: name.optional(),
    sortOrder: sortOrder.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Nothing to update.',
  });

export const createTableSchema = z.object({
  areaId: z.string().min(1, 'Choose an area.'),
  name,
  capacity: capacity.optional(),
  sortOrder: sortOrder.optional(),
});

export const updateTableSchema = z
  .object({
    areaId: z.string().min(1).optional(),
    name: name.optional(),
    capacity: capacity.optional(),
    sortOrder: sortOrder.optional(),
    isActive: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Nothing to update.',
  });

export type CreateAreaInput = z.infer<typeof createAreaSchema>;
export type UpdateAreaInput = z.infer<typeof updateAreaSchema>;
export type CreateTableInput = z.infer<typeof createTableSchema>;
export type UpdateTableInput = z.infer<typeof updateTableSchema>;
