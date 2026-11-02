import { z } from 'zod';
const shape = {
  name: z.string().trim().min(1).max(80),
  rateBp: z.int().min(1).max(10000),
  scope: z.enum(['ALL', 'ITEMS', 'CATEGORIES']),
  targetIds: z
    .array(z.string().min(1).max(128))
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, 'Choose each target only once.'),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  isActive: z.boolean(),
};
export const offerDefinitionSchema = z.object(shape).superRefine((value, ctx) => {
  if (Date.parse(value.endsAt) <= Date.parse(value.startsAt))
    ctx.addIssue({
      code: 'custom',
      path: ['endsAt'],
      message: 'End time must be after start time.',
    });
  if ((value.scope === 'ALL') !== (value.targetIds.length === 0))
    ctx.addIssue({
      code: 'custom',
      path: ['targetIds'],
      message: 'Choose targets for an item/category offer, or no targets for an all-menu offer.',
    });
});
export const updateOfferSchema = z
  .object(shape)
  .partial()
  .extend({ expectedVersion: z.int().min(0) })
  .refine((value) => Object.keys(value).length > 1, 'Nothing to update.');
