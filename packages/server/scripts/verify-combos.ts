/** Fixed bundles: real migrations, services, kitchen snapshots and stock accounting. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyPendingMigrations,
  createPrismaClient,
  assertDatabaseIntegrity,
} from '@nayaro/database';
import { registerTenant } from '../src/modules/tenant/tenant.service';
import * as menu from '../src/modules/menu/menu.management';
import { getMenu } from '../src/modules/menu/menu.service';
import * as orders from '../src/modules/orders/orders.service';
import { issueInvoice } from '../src/modules/billing/billing.service';
import { ApiError } from '../src/utils/apiError';

const root = mkdtempSync(join(tmpdir(), 'nayaro-combos-'));
const databaseFilePath = join(root, 'data.db');
await applyPendingMigrations({ databaseFilePath });
const prisma = createPrismaClient({ databaseFilePath });
const rejected = (code: string) => (error: unknown) =>
  error instanceof ApiError && error.code === code;
try {
  const { restaurantId, ownerStaffId: staffId } = await registerTenant(prisma, {
    restaurant: { slug: 'verify-restaurant', name: 'Bundle kitchen' },
    owner: { name: 'Owner', username: 'owner', password: 'bundle-test-password' },
  });
  const category = await prisma.menuCategory.create({ data: { restaurantId, name: 'Meals' } });
  const dish = async (name: string) =>
    prisma.menuItem.create({
      data: { restaurantId, categoryId: category.id, name, pricePaisa: 15000 },
    });
  const main = await dish('Main');
  const side = await dish('Side');
  const ingredient = await prisma.ingredient.create({
    data: { restaurantId, name: 'Rice', unit: 'g', onHandMilli: 15000 },
  });
  for (const item of [main, side])
    await prisma.recipeIngredient.create({
      data: { menuItemId: item.id, ingredientId: ingredient.id, quantityMilli: 1000 },
    });
  const components = [
    { menuItemId: main.id, quantity: 2 },
    { menuItemId: side.id, quantity: 1 },
  ];
  const catalogue = await menu.createItem(prisma, restaurantId, {
    categoryId: category.id,
    name: 'Lunch set',
    pricePaisa: 25000,
    components,
  });
  const bundle = catalogue.categories
    .flatMap((row) => row.items)
    .find((row) => row.name === 'Lunch set')!;
  assert.deepEqual(bundle.components, components);
  assert.deepEqual(
    (await getMenu(prisma, restaurantId)).categories[0]!.items.find((row) => row.id === bundle.id)!
      .components,
    [
      { name: 'Main', quantity: 2 },
      { name: 'Side', quantity: 1 },
    ],
  );
  await assert.rejects(
    menu.updateItem(prisma, restaurantId, main.id, {
      components: [{ menuItemId: side.id, quantity: 1 }],
    }),
    rejected('DISH_IN_COMBO'),
  );
  await assert.rejects(
    menu.updateItem(prisma, restaurantId, bundle.id, {
      components: [{ menuItemId: bundle.id, quantity: 1 }],
    }),
    rejected('INVALID_COMBO'),
  );
  await assert.rejects(
    menu.createItem(prisma, restaurantId, {
      categoryId: category.id,
      name: 'Nested',
      pricePaisa: 100,
      components: [{ menuItemId: bundle.id, quantity: 1 }],
    }),
    rejected('INVALID_COMBO'),
  );
  await assert.rejects(
    menu.updateItem(prisma, restaurantId, bundle.id, {
      components: [{ menuItemId: main.id, quantity: 0 }],
    }),
  );
  await assert.rejects(
    menu.updateItem(prisma, restaurantId, bundle.id, {
      components: [components[0], components[0]],
    }),
  );
  const other = await prisma.restaurant.create({
    data: { name: 'Other', address: '', phone: '', panNumber: '' },
  });
  const otherCategory = await prisma.menuCategory.create({
    data: { restaurantId: other.id, name: 'Other' },
  });
  const foreignDish = await prisma.menuItem.create({
    data: {
      restaurantId: other.id,
      categoryId: otherCategory.id,
      name: 'Foreign',
      pricePaisa: 100,
    },
  });
  await assert.rejects(
    menu.updateItem(prisma, restaurantId, bundle.id, {
      components: [{ menuItemId: foreignDish.id, quantity: 1 }],
    }),
    rejected('INVALID_COMBO'),
  );

  let { order } = await orders.addItem(prisma, restaurantId, staffId, {
    target: { kind: 'TAKEAWAY' },
    menuItemId: bundle.id,
    quantity: 2,
    note: 'No chilli',
  });
  assert.equal(order.subtotalPaisa, 50000);
  // A change in contents produces a distinct line even at the same bundle price.
  await menu.updateItem(prisma, restaurantId, bundle.id, {
    components: [{ menuItemId: side.id, quantity: 2 }],
  });
  await menu.updateItem(prisma, restaurantId, main.id, { name: 'Renamed main' });
  ({ order } = await orders.addItem(prisma, restaurantId, staffId, {
    target: { kind: 'ORDER', orderId: order.id, expectedVersion: order.version },
    menuItemId: bundle.id,
    note: 'No chilli',
  }));
  assert.equal(order.items.length, 2);
  assert.equal(order.items[0]!.components![0]!.name, 'Main');
  const input = { expectedVersion: order.version };
  const attempt = { key: 'bundle-dispatch-0001', replayed: false };
  const sent = await orders.sendToKitchen(prisma, restaurantId, staffId, order.id, input, attempt);
  assert.deepEqual(
    sent.kot.items.map((row) => [row.name, row.quantity]),
    [
      ['Main', 4],
      ['Side', 2],
      ['Side', 2],
    ],
  );
  assert(sent.kot.items.every((row) => row.note === 'Lunch set · No chilli'));
  assert.equal(
    (await prisma.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } })).onHandMilli,
    7000,
  );
  const replay = await orders.sendToKitchen(
    prisma,
    restaurantId,
    staffId,
    order.id,
    input,
    attempt,
  );
  assert.equal(replay.kot.id, sent.kot.id);
  assert.equal(attempt.replayed, true);
  assert.equal(await prisma.stockMovement.count(), 1);
  const invoice = await issueInvoice(prisma, restaurantId, staffId, order.id, {
    expectedVersion: sent.order.version,
  });
  assert.equal(invoice.subtotalPaisa, 75000);
  assert.equal(invoice.lines.length, 2);
  assert(
    invoice.lines.every((row) => row.description === 'Lunch set' && row.unitPricePaisa === 25000),
  );

  // Shared ingredients must cover the combined component requirement.
  await menu.updateItem(prisma, restaurantId, bundle.id, { components });
  await prisma.ingredient.update({ where: { id: ingredient.id }, data: { onHandMilli: 2500 } });
  assert(
    !(await getMenu(prisma, restaurantId)).categories
      .flatMap((row) => row.items)
      .some((row) => row.id === bundle.id),
  );
  await assert.rejects(
    orders.addItem(prisma, restaurantId, staffId, {
      target: { kind: 'TAKEAWAY' },
      menuItemId: bundle.id,
    }),
    rejected('COMBO_UNAVAILABLE'),
  );
  await prisma.ingredient.update({ where: { id: ingredient.id }, data: { onHandMilli: 15000 } });
  const draft = (
    await orders.addItem(prisma, restaurantId, staffId, {
      target: { kind: 'TAKEAWAY' },
      menuItemId: bundle.id,
      quantity: 6,
    })
  ).order;
  await assert.rejects(
    orders.sendToKitchen(prisma, restaurantId, staffId, draft.id, {
      expectedVersion: draft.version,
    }),
    rejected('INSUFFICIENT_STOCK'),
  );
  assert.equal(await prisma.kot.count(), 1);
  assert.equal(
    (await orders.getOrder(prisma, restaurantId, draft.id)).order.version,
    draft.version,
  );
  await prisma.menuItem.update({ where: { id: side.id }, data: { isAvailable: false } });
  assert(
    !(await getMenu(prisma, restaurantId)).categories
      .flatMap((row) => row.items)
      .some((row) => row.id === bundle.id),
  );
  await assert.rejects(
    orders.sendToKitchen(prisma, restaurantId, staffId, draft.id, {
      expectedVersion: draft.version,
    }),
    rejected('COMBO_UNAVAILABLE'),
  );
  assert.equal(
    (await prisma.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } })).onHandMilli,
    15000,
  );
  await prisma.menuItem.update({ where: { id: side.id }, data: { isAvailable: true } });
  const cancelDraft = (
    await orders.addItem(prisma, restaurantId, staffId, {
      target: { kind: 'TAKEAWAY' },
      menuItemId: bundle.id,
      quantity: 2,
    })
  ).order;
  const cancelSent = await orders.sendToKitchen(prisma, restaurantId, staffId, cancelDraft.id, {
    expectedVersion: cancelDraft.version,
  });
  const cancelled = await orders.cancelOrderItem(
    prisma,
    restaurantId,
    staffId,
    cancelDraft.id,
    cancelDraft.items[0]!.id,
    { quantity: 1, reason: 'Guest cancelled one whole set' },
  );
  assert.equal(cancelled.order.subtotalPaisa, 25000);
  assert.equal(cancelled.order.items[0]!.dispatchedQuantity, 2);
  assert.equal(cancelSent.kot.items[0]!.quantity, 4);
  assert.equal(
    (await prisma.ingredient.findUniqueOrThrow({ where: { id: ingredient.id } })).onHandMilli,
    9000,
  );
  const adjustedInvoice = await issueInvoice(prisma, restaurantId, staffId, cancelDraft.id, {
    expectedVersion: cancelled.order.version,
  });
  assert.equal(adjustedInvoice.subtotalPaisa, 25000);
  assert.equal(adjustedInvoice.lines[0]!.quantity, 1);
  await assertDatabaseIntegrity(prisma);
  console.log(
    'PASS: fixed bundles, validation, tenant isolation, frozen contents, kitchen quantities, recipe aggregation, retry safety, billing and atomic shortage rollback.',
  );
} finally {
  await prisma.$disconnect();
  rmSync(root, { recursive: true, force: true });
}
