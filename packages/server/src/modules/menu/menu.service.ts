import { activeOffers, offerPrice } from '../offers/offers.service';
import { readComponents } from './combos';
import type { NayaroPrismaClient } from '@nayaro/database';
import type { MenuResponse } from '@nayaro/shared';
import { availability } from '../inventory/inventory.service';

/**
 * The sellable menu.
 *
 * Two different flags decide visibility and they mean different things:
 *
 *   isActive     catalogue membership. A retired dish keeps isActive=false so
 *                every historical OrderItem still resolves to a real row.
 *   isAvailable  sold out today. Flipped constantly during service; the dish
 *                stays on the menu and comes back tomorrow.
 *
 * The POS hides both, because in both cases the answer to "can I sell this
 * right now?" is no. A greyed-out tile a cashier keeps trying to press is
 * worse than an absent one during a rush.
 */
export async function getMenu(
  prisma: NayaroPrismaClient,
  restaurantId: string,
): Promise<MenuResponse> {
  const categories = await prisma.menuCategory.findMany({
    where: { restaurantId, isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: {
      id: true,
      name: true,
      nameNp: true,
      items: {
        where: { isActive: true, isAvailable: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        select: { id: true, name: true, nameNp: true, pricePaisa: true, comboComponents: true },
      },
    },
  });

  const stock = await availability(prisma, restaurantId);
  const offers = await activeOffers(prisma, restaurantId);
  const sellable = new Set(
    stock.items.filter((item) => item.stockAvailable).map((item) => item.id),
  );
  return {
    // A category whose every dish is sold out is dropped rather than shown
    // empty: a tab that leads nowhere costs a cashier a tap to discover.
    categories: categories
      .map((category) => ({
        ...category,
        items: category.items
          .filter((item) => sellable.has(item.id))
          .map(({ comboComponents, ...item }) => ({
            ...item,
            pricePaisa: offerPrice(offers, { ...item, categoryId: category.id }).pricePaisa,
            promotion: offerPrice(offers, { ...item, categoryId: category.id }).promotion,
            components: readComponents(comboComponents).map((part) => ({
              quantity: part.quantity,
              name:
                categories.flatMap((row) => row.items).find((dish) => dish.id === part.menuItemId)
                  ?.name ?? 'Unavailable dish',
            })),
          })),
      }))
      .filter((category) => category.items.length > 0),
  };
}
