import { z } from 'zod';
import type { NayaroPrismaClient } from '@nayaro/database';
import type { OfferDefinition, OffersResponse, PromotionSummary } from '@nayaro/shared';
import { ApiError } from '../../utils/apiError';
import { applyRateBp } from '../../utils/money';
import { offerDefinitionSchema, updateOfferSchema } from './offers.schema';

type Tx = Parameters<Parameters<NayaroPrismaClient['$transaction']>[0]>[0];
type Client = Pick<NayaroPrismaClient, 'offer'>;
const idsSchema = z.array(z.string());
const snapshotSchema = z.object({
  offerId: z.string(),
  name: z.string(),
  rateBp: z.int().min(1).max(10000),
  regularUnitPricePaisa: z.int().min(0),
});
export function promotionSummary(raw: string | null): PromotionSummary | null {
  if (raw === null) return null;
  const { name, rateBp, regularUnitPricePaisa } = snapshotSchema.parse(JSON.parse(raw));
  return { name, rateBp, regularUnitPricePaisa };
}
export async function listOffers(prisma: Client, restaurantId: string): Promise<OffersResponse> {
  const rows = await prisma.offer.findMany({
    where: { restaurantId },
    orderBy: [{ startsAt: 'desc' }, { id: 'asc' }],
    include: { updatedByStaff: { select: { name: true } } },
  });
  return {
    offers: rows.map((row) => ({
      id: row.id,
      name: row.name,
      rateBp: row.rateBp,
      scope: z.enum(['ALL', 'ITEMS', 'CATEGORIES']).parse(row.scope),
      targetIds: idsSchema.parse(JSON.parse(row.targetIdsJson)),
      startsAt: row.startsAt.toISOString(),
      endsAt: row.endsAt.toISOString(),
      isActive: row.isActive,
      version: row.version,
      updatedAt: row.updatedAt.toISOString(),
      updatedBy: row.updatedByStaff.name,
    })),
  };
}
async function validateTargets(tx: Tx, restaurantId: string, input: OfferDefinition) {
  const count =
    input.scope === 'ALL'
      ? 0
      : input.scope === 'ITEMS'
        ? await tx.menuItem.count({
            where: {
              restaurantId,
              id: { in: [...input.targetIds] },
              isActive: true,
              category: { isActive: true },
            },
          })
        : await tx.menuCategory.count({
            where: { restaurantId, id: { in: [...input.targetIds] }, isActive: true },
          });
  if (count !== input.targetIds.length)
    throw new ApiError(
      409,
      'OFFER_TARGET_UNAVAILABLE',
      'Choose active dishes or categories from this restaurant.',
    );
}
const data = (input: OfferDefinition) => ({
  name: input.name,
  rateBp: input.rateBp,
  scope: input.scope,
  targetIdsJson: JSON.stringify(input.targetIds),
  startsAt: new Date(input.startsAt),
  endsAt: new Date(input.endsAt),
  isActive: input.isActive,
});
export async function createOffer(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  staffId: string,
  raw: unknown,
): Promise<OffersResponse> {
  const input = offerDefinitionSchema.parse(raw);
  await prisma.$transaction(async (tx) => {
    await validateTargets(tx, restaurantId, input);
    await tx.offer.create({
      data: { ...data(input), restaurantId, createdByStaffId: staffId, updatedByStaffId: staffId },
    });
  });
  return listOffers(prisma, restaurantId);
}
export async function updateOffer(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  staffId: string,
  id: string,
  raw: unknown,
): Promise<OffersResponse> {
  const patch = updateOfferSchema.parse(raw);
  await prisma.$transaction(async (tx) => {
    const existing = await tx.offer.findFirst({ where: { id, restaurantId } });
    if (!existing) throw new ApiError(404, 'OFFER_NOT_FOUND', 'That offer does not exist.');
    const input = offerDefinitionSchema.parse({
      ...existing,
      targetIds: idsSchema.parse(JSON.parse(existing.targetIdsJson)),
      startsAt: existing.startsAt.toISOString(),
      endsAt: existing.endsAt.toISOString(),
      ...patch,
    });
    // Disabling an offer must remain possible after one of its targets is retired.
    if (input.isActive) await validateTargets(tx, restaurantId, input);
    const changed = await tx.offer.updateMany({
      where: { id, restaurantId, version: patch.expectedVersion },
      data: { ...data(input), updatedByStaffId: staffId, version: { increment: 1 } },
    });
    if (changed.count !== 1)
      throw new ApiError(
        409,
        'OFFER_CHANGED',
        'This offer changed. Refresh before saving it again.',
      );
  });
  return listOffers(prisma, restaurantId);
}
/** Start inclusive, end exclusive. The server clock is the only eligibility clock. */
export async function activeOffers(prisma: Client, restaurantId: string, now = new Date()) {
  return prisma.offer.findMany({
    where: { restaurantId, isActive: true, startsAt: { lte: now }, endsAt: { gt: now } },
    orderBy: [{ rateBp: 'desc' }, { startsAt: 'asc' }, { id: 'asc' }],
  });
}
export function offerPrice(
  offers: Awaited<ReturnType<typeof activeOffers>>,
  item: { id: string; categoryId: string; pricePaisa: number },
) {
  const offer = offers.find(
    (row) =>
      row.scope === 'ALL' ||
      idsSchema
        .parse(JSON.parse(row.targetIdsJson))
        .includes(row.scope === 'ITEMS' ? item.id : item.categoryId),
  );
  const saving = offer ? applyRateBp(item.pricePaisa, offer.rateBp) : 0;
  const snapshot =
    offer && saving > 0
      ? JSON.stringify({
          offerId: offer.id,
          name: offer.name,
          rateBp: offer.rateBp,
          regularUnitPricePaisa: item.pricePaisa,
        })
      : null;
  return {
    pricePaisa: item.pricePaisa - saving,
    promotionSnapshot: snapshot,
    promotion: promotionSummary(snapshot),
  };
}
