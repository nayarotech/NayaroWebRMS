import { Router } from 'express';
import type { NayaroPrismaClient } from '@nayaro/database';
import { ApiError } from '../../utils/apiError';
import { getCustomerMenu } from './customerMenu.service';
import { workspaceSchema } from '../tenant/tenant.schema';
import { tenantBlock } from '../tenant/tenant.service';

export function createCustomerMenuRouter(prisma: NayaroPrismaClient): Router {
  const router = Router();
  router.get('/public/menu', async (req, res) => {
    // Disabled menus and failures must not be cached either.
    res.setHeader('Cache-Control', 'no-store, must-revalidate');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    const workspace = workspaceSchema.safeParse(req.query['workspace']);
    const restaurant = workspace.success
      ? await prisma.restaurant.findUnique({
          where: { slug: workspace.data },
          select: { id: true, isActive: true, status: true, subscriptionEndsAt: true },
        })
      : null;
    if (!restaurant || tenantBlock(restaurant) !== null) {
      throw new ApiError(
        404,
        'MENU_UNAVAILABLE',
        'The restaurant’s menu is not available. Please ask a member of staff.',
      );
    }
    res.json(await getCustomerMenu(prisma, restaurant.id));
  });
  return router;
}
