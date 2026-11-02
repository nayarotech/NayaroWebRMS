import { activeOffers, offerPrice } from '../offers/offers.service';
import type { NayaroPrismaClient } from '@nayaro/database';
import type { CustomerMenuResponse } from '@nayaro/shared';
import { ApiError } from '../../utils/apiError';
import { availability } from '../inventory/inventory.service';
import { resolveCombo } from './combos';

/** Every response is explicitly mapped to the public contract, including nested bundle dishes. */
export async function getCustomerMenu(
  prisma: NayaroPrismaClient,
  restaurantId: string,
): Promise<CustomerMenuResponse> {
  return prisma.$transaction(async (tx) => {
    const restaurant = await tx.restaurant.findFirst({
      where: { id: restaurantId, settings: { customerMenuEnabled: true } },
      select: {
        name: true,
        address: true,
        phone: true,
        settings: {
          select: {
            vatEnabled: true,
            vatRateBp: true,
            serviceChargeEnabled: true,
            serviceChargeRateBp: true,
          },
        },
      },
    });
    if (!restaurant?.settings)
      throw new ApiError(
        404,
        'MENU_UNAVAILABLE',
        'The restaurant’s menu is not available. Please ask a member of staff.',
      );
    const categories = await tx.menuCategory.findMany({
      where: { restaurantId, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        nameNp: true,
        items: {
          where: { restaurantId, isActive: true },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: {
            id: true,
            name: true,
            nameNp: true,
            pricePaisa: true,
            isAvailable: true,
            comboComponents: true,
          },
        },
      },
    });
    const stock = await availability(tx, restaurantId);
    const offers = await activeOffers(tx, restaurantId);
    const available = new Set(stock.items.filter((row) => row.stockAvailable).map((row) => row.id));
    return {
      restaurant: { name: restaurant.name, address: restaurant.address, phone: restaurant.phone },
      charges: {
        vatRateBp: restaurant.settings.vatEnabled ? restaurant.settings.vatRateBp : 0,
        serviceChargeRateBp: restaurant.settings.serviceChargeEnabled
          ? restaurant.settings.serviceChargeRateBp
          : 0,
      },
      categories: await Promise.all(
        categories
          .filter((category) => category.items.length > 0)
          .map(async (category) => ({
            id: category.id,
            name: category.name,
            nameNp: category.nameNp,
            items: await Promise.all(
              category.items.map(async (item) => ({
                id: item.id,
                name: item.name,
                nameNp: item.nameNp,
                pricePaisa: offerPrice(offers, { ...item, categoryId: category.id }).pricePaisa,
                promotion: offerPrice(offers, { ...item, categoryId: category.id }).promotion,
                isAvailable: item.isAvailable && available.has(item.id),
                components: (
                  await resolveCombo(tx, restaurantId, item.comboComponents)
                ).snapshot.map(({ name, nameNp, quantity }) => ({ name, nameNp, quantity })),
              })),
            ),
          })),
      ),
    };
  });
}
