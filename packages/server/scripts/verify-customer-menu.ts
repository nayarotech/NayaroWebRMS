/** Guest QR menu: public allowlist, opt-in, tenant isolation, safe payload and live stock. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CustomerMenuResponse, LoginResponse } from '@nayaro/shared';
import { startNayaroServer, stopNayaroServer } from '../src/server';
import { registerTenant } from '../src/modules/tenant/tenant.service';
import { hashPassword } from '../src/modules/auth/password';

const root = mkdtempSync(join(tmpdir(), 'nayaro-customer-menu-'));
let handle: Awaited<ReturnType<typeof startNayaroServer>> | undefined;
let checks = 0;
async function call<T>(
  method: string,
  path: string,
  status: number,
  token?: string,
  body?: unknown,
) {
  const response = await fetch(`${handle!.baseUrl}${path}`, {
    method,
    headers: {
      Connection: 'close',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.equal(response.status, status, `${method} ${path}: ${text}`);
  checks++;
  return { data: (text ? JSON.parse(text) : null) as T, response };
}
try {
  handle = await startNayaroServer({
    allowDirectRegistration: true,
    host: '0.0.0.0',
    port: 4355,
    databaseFilePath: join(root, 'data.db'),
    silent: true,
  });
  const { prisma } = handle;
  const setup = await registerTenant(prisma, {
    restaurant: { slug: 'verify-restaurant', name: 'Guest restaurant', address: 'Kathmandu', phone: '12345678' },
    owner: { name: 'Owner', username: 'owner', password: 'customer-menu-test' },
  });
  const restaurantId = setup.restaurantId;
  const path = `/public/menu?workspace=verify-restaurant`;
  const token = (
    await call<LoginResponse>('POST', '/auth/login', 200, undefined, {
      workspace: 'verify-restaurant', username: 'owner',
      password: 'customer-menu-test',
    })
  ).data.token;
  await call('GET', path, 404);
  await call('GET', '/public/menu', 404);
  await call('GET', '/public/menu?workspace=unknown', 404);
  await call('GET', '/public/menu?workspace=a&workspace=b', 404);
  for (const role of ['CASHIER', 'WAITER', 'KITCHEN', 'MANAGER'] as const) {
    await prisma.staff.create({
      data: {
        restaurantId,
        name: role,
        username: role.toLowerCase(),
        role,
        passwordHash: await hashPassword('customer-menu-test'),
      },
    });
    const roleToken = (
      await call<LoginResponse>('POST', '/auth/login', 200, undefined, {
        workspace: 'verify-restaurant', username: role.toLowerCase(),
        password: 'customer-menu-test',
      })
    ).data.token;
    await call(
      'PATCH',
      '/management/settings/operational',
      role === 'MANAGER' ? 200 : 403,
      roleToken,
      { customerMenuEnabled: true },
    );
  }
  await call('PATCH', '/management/settings/operational', 400, token, {
    customerMenuEnabled: 'true',
  });
  await call('PATCH', '/management/settings/operational', 200, token, {
    customerMenuEnabled: true,
  });
  const category = await prisma.menuCategory.create({
    data: { restaurantId, name: 'Meals', nameNp: 'खाना' },
  });
  const hiddenCategory = await prisma.menuCategory.create({
    data: { restaurantId, name: 'Hidden category', isActive: false },
  });
  const createDish = (name: string, extra = {}) =>
    prisma.menuItem.create({
      data: {
        restaurantId,
        categoryId: category.id,
        name,
        nameNp: 'नेपाली',
        pricePaisa: 25000,
        ...extra,
      },
    });
  const main = await createDish('Rice');
  const side = await createDish('Side');
  const soldOut = await createDish('Sold out dish', { isAvailable: false });
  await createDish('Retired dish', { isActive: false });
  await createDish('Hidden dish', { categoryId: hiddenCategory.id });
  const bundle = await createDish('Lunch set', {
    pricePaisa: 35000,
    comboComponents: JSON.stringify([
      { menuItemId: main.id, quantity: 2 },
      { menuItemId: side.id, quantity: 1 },
    ]),
  });
  const ingredient = await prisma.ingredient.create({
    data: { restaurantId, name: 'Secret ingredient', unit: 'g', onHandMilli: 2500 },
  });
  for (const dish of [main, side])
    await prisma.recipeIngredient.create({
      data: { menuItemId: dish.id, ingredientId: ingredient.id, quantityMilli: 1000 },
    });
  const other = await prisma.restaurant.create({
    data: { name: 'Other restaurant', address: '', phone: '', panNumber: '' },
  });
  const otherCategory = await prisma.menuCategory.create({
    data: { restaurantId: other.id, name: 'Other category' },
  });
  await prisma.menuItem.create({
    data: {
      restaurantId: other.id,
      categoryId: otherCategory.id,
      name: 'Other dish',
      pricePaisa: 500,
    },
  });
  await call('GET', `/public/menu?workspace=${other.slug}`, 404);

  const opened = await call<CustomerMenuResponse>('GET', path, 200, 'invalid-ignored-staff-token');
  assert.match(opened.response.headers.get('cache-control')!, /no-store/);
  assert.deepEqual(Object.keys(opened.data).sort(), ['categories', 'charges', 'restaurant']);
  assert.deepEqual(Object.keys(opened.data.restaurant).sort(), ['address', 'name', 'phone']);
  assert.equal(opened.data.restaurant.name, 'Guest restaurant');
  assert.deepEqual(opened.data.charges, { vatRateBp: 0, serviceChargeRateBp: 0 });
  assert.equal(opened.data.categories.length, 1);
  const items = opened.data.categories[0]!.items;
  assert.deepEqual(items.map((row) => row.name).sort(), [
    'Lunch set',
    'Rice',
    'Side',
    'Sold out dish',
  ]);
  for (const item of items)
    assert.deepEqual(Object.keys(item).sort(), [
      'components',
      'id',
      'isAvailable',
      'name',
      'nameNp',
      'pricePaisa',
      'promotion',
    ]);
  const guestBundle = items.find((row) => row.id === bundle.id)!;
  assert.equal(guestBundle.pricePaisa, 35000);
  assert.equal(guestBundle.isAvailable, false); // Aggregate 3000, not 1000 per dish.
  assert.deepEqual(
    guestBundle.components.map((row) => [row.name, row.quantity]),
    [
      ['Rice', 2],
      ['Side', 1],
    ],
  );
  assert(!items.find((row) => row.id === soldOut.id)!.isAvailable);
  const serialized = JSON.stringify(opened.data);
  for (const secret of [
    'passwordHash',
    'onHandMilli',
    'recipeVersion',
    'Secret ingredient',
    'staffId',
    'panNumber',
    'Other dish',
    'Retired dish',
    'Hidden dish',
  ])
    assert(!serialized.includes(secret), secret);
  await prisma.ingredient.update({ where: { id: ingredient.id }, data: { onHandMilli: 10000 } });
  await prisma.menuItem.update({ where: { id: main.id }, data: { pricePaisa: 27000 } });
  await prisma.restaurantSettings.update({
    where: { restaurantId },
    data: { vatEnabled: true, serviceChargeEnabled: true },
  });
  const fresh = (await call<CustomerMenuResponse>('GET', path, 200)).data;
  assert(fresh.categories[0]!.items.find((row) => row.id === bundle.id)!.isAvailable);
  assert.equal(fresh.categories[0]!.items.find((row) => row.id === main.id)!.pricePaisa, 27000);
  assert.deepEqual(fresh.charges, { vatRateBp: 1300, serviceChargeRateBp: 1000 });

  for (const endpoint of [
    '/menu',
    '/inventory',
    '/management/menu',
    '/floor',
    '/kitchen/tickets',
  ])
    await call('GET', endpoint, 401);
  await call('POST', '/public/menu', 401, undefined, {});
  await call('GET', '/public/menu/private', 401);
  assert.equal(await prisma.order.count(), 0);
  assert.equal(await prisma.stockMovement.count(), 0);
  await call('PATCH', '/management/settings/operational', 200, token, {
    customerMenuEnabled: false,
  });
  await call('GET', path, 404);
  console.log(
    `PASS: customer QR menu (${checks} HTTP checks), opt-in and disable, role permissions, guest isolation, safe fields, current prices and stock, set menus and workspace-scoped links.`,
  );
} finally {
  if (handle) await stopNayaroServer(handle);
  rmSync(root, { recursive: true, force: true });
}
