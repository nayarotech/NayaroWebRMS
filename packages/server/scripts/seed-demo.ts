/**
 * Creates the demonstration restaurants through the real API, so every order,
 * kitchen ticket, invoice, payment, refund and stock movement goes through the
 * same business rules a live restaurant uses.
 *
 *   npm run demo:seed
 *
 * Idempotent: an existing demo workspace is left untouched. Delete the local
 * database file (packages/server/.data/nayaro.db) to start over.
 *
 * DEMO_PASSWORD overrides the sign-in password for every demo account.
 */
import { randomUUID } from 'node:crypto';
import type {
  CustomerStatementResponse,
  IngredientDto,
  InvoiceDto,
  LoginResponse,
  OrderDto,
  OrderResponse,
  SendToKitchenResponse,
} from '@nayaro/shared';
import { createPrismaClient } from '@nayaro/database';
import { startNayaroServer, stopNayaroServer, type NayaroServerHandle } from '../src/server';
import { resolveBusinessDate } from '../src/utils/businessDate';
import { createLogger } from '../src/utils/logger';
import { loadEnvironment, resolveDatabaseLocation } from './env';

loadEnvironment();

const PASSWORD = process.env['DEMO_PASSWORD'] ?? 'Demo@2026';
const DEMO_WORKSPACE = 'himalayan-kitchen';
const SECOND_WORKSPACE = 'everest-cafe';
const HISTORY_DAYS = 13;
const DAY_MS = 24 * 60 * 60 * 1000;

const databaseFilePath = resolveDatabaseLocation();
const authToken = process.env['DATABASE_AUTH_TOKEN'];

{
  const probe = createPrismaClient({ databaseFilePath, ...(authToken ? { authToken } : {}) });
  try {
    const existing = await probe.restaurant
      .findUnique({ where: { slug: DEMO_WORKSPACE }, select: { id: true } })
      .catch(() => null);
    if (existing) {
      console.log(`Demo workspace "${DEMO_WORKSPACE}" already exists; nothing to do.`);
      console.log('Delete packages/server/.data/nayaro.db and run again to start over.');
      process.exit(0);
    }
  } finally {
    await probe.$disconnect();
  }
}

const handle: NayaroServerHandle = await startNayaroServer({
  host: '127.0.0.1',
  port: 0,
  databaseFilePath,
  ...(authToken ? { databaseAuthToken: authToken } : {}),
  apiRequestsPerMinute: 1_000_000,
  registrationsPerHour: 100,
  logger: createLogger({ scope: 'demo-seed', silent: true }),
});
const prisma = handle.prisma;

async function api<T>(path: string, body?: unknown, token?: string, method?: string): Promise<T> {
  const verb = method ?? (body === undefined ? 'GET' : 'POST');
  const response = await fetch(handle.baseUrl + path, {
    method: verb,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined
        ? {}
        : { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const result: unknown = text.length > 0 ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`${verb} ${path}: ${text}`);
  return result as T;
}

async function signIn(workspace: string, username: string): Promise<string> {
  return (
    await api<LoginResponse>('/auth/login', {
      workspace,
      username,
      password: PASSWORD,
      deviceLabel: 'Demo setup',
    })
  ).token;
}

type Catalogue = readonly {
  readonly name: string;
  readonly np: string;
  readonly items: readonly (readonly [string, string, number])[];
}[];

const HIMALAYAN_MENU: Catalogue = [
  {
    name: 'Momo',
    np: 'मोमो',
    items: [
      ['Chicken Momo', 'चिकन मोमो', 22000],
      ['Veg Momo', 'भेज मोमो', 18000],
      ['Buff Momo', 'बफ मोमो', 20000],
      ['Chicken Jhol Momo', 'चिकन झोल मोमो', 26000],
      ['C-Momo Chilli', 'सी-मोमो चिल्ली', 28000],
    ],
  },
  {
    name: 'Chowmein',
    np: 'चाउमिन',
    items: [
      ['Chicken Chowmein', 'चिकन चाउमिन', 24000],
      ['Veg Chowmein', 'भेज चाउमिन', 19000],
      ['Mixed Chowmein', 'मिक्स चाउमिन', 28000],
    ],
  },
  {
    name: 'Starters',
    np: 'स्टार्टर',
    items: [
      ['Chicken Chilli', 'चिकन चिल्ली', 36000],
      ['Paneer Chilli', 'पनीर चिल्ली', 32000],
      ['Chicken Sekuwa', 'चिकन सेकुवा', 38000],
      ['French Fries', 'फ्रेन्च फ्राइज', 18000],
      ['Crispy Corn', 'क्रिस्पी कर्न', 22000],
    ],
  },
  {
    name: 'Meals',
    np: 'खाना',
    items: [
      ['Chicken Thakali Set', 'चिकन थकाली सेट', 48000],
      ['Veg Thakali Set', 'भेज थकाली सेट', 38000],
      ['Mutton Thakali Set', 'खसी थकाली सेट', 62000],
      ['Chicken Fried Rice', 'चिकन फ्राइड राइस', 26000],
    ],
  },
  {
    name: 'Drinks',
    np: 'पेय',
    items: [
      ['Fresh Lime Soda', 'फ्रेस लाइम सोडा', 14000],
      ['Masala Tea', 'मसला चिया', 6000],
      ['Cappuccino', 'क्यापुचिनो', 16000],
      ['Mango Lassi', 'आँप लस्सी', 18000],
      ['Coke', 'कोक', 9000],
      ['Mineral Water', 'पानी', 4000],
    ],
  },
  {
    name: 'Desserts',
    np: 'मिठाई',
    items: [
      ['Chocolate Brownie', 'चकलेट ब्राउनी', 24000],
      ['Vanilla Ice Cream', 'भेनिला आइसक्रिम', 14000],
      ['Juju Dhau', 'जुजु धौ', 15000],
    ],
  },
];

type Line = readonly [string, number, string?];

const SALE_PATTERNS: readonly (readonly Line[])[] = [
  [['Chicken Momo', 2], ['Fresh Lime Soda', 2]],
  [['Veg Momo', 2], ['Chicken Chowmein', 1], ['Masala Tea', 2]],
  [['Chicken Thakali Set', 2], ['Mineral Water', 1]],
  [['Chicken Chilli', 1], ['French Fries', 1], ['Coke', 2]],
  [['Paneer Chilli', 1], ['Veg Chowmein', 2], ['Cappuccino', 2]],
  [['Chicken Momo', 3], ['Chicken Fried Rice', 2], ['Fresh Lime Soda', 3]],
  [['Mutton Thakali Set', 2], ['Veg Thakali Set', 1], ['Mango Lassi', 3]],
  [['Chocolate Brownie', 2], ['Vanilla Ice Cream', 2], ['Cappuccino', 2]],
  [['Buff Momo', 2], ['C-Momo Chilli', 1], ['Coke', 2]],
  [['Chicken Sekuwa', 1], ['Chicken Jhol Momo', 2], ['Masala Tea', 3]],
  [['Crispy Corn', 1], ['Mixed Chowmein', 1], ['Juju Dhau', 2]],
];

async function seedHimalayanKitchen(): Promise<void> {
  console.log(`Creating "${DEMO_WORKSPACE}"…`);
  await api('/tenants/register', {
    restaurant: {
      slug: DEMO_WORKSPACE,
      name: 'Himalayan Kitchen',
      address: 'Jhamsikhel Road, Lalitpur',
      phone: '01-5550123',
      panNumber: '609876543',
      contactEmail: 'hello@himalayankitchen.example',
    },
    owner: { name: 'Aarav Shrestha', username: 'owner', password: PASSWORD },
    settings: { vatEnabled: true, vatRateBp: 1300, serviceChargeEnabled: true, serviceChargeRateBp: 1000 },
  });
  const restaurant = await prisma.restaurant.update({
    where: { slug: DEMO_WORKSPACE },
    data: { status: 'ACTIVE', plan: 'PROFESSIONAL', subscriptionEndsAt: null },
  });
  const owner = await signIn(DEMO_WORKSPACE, 'owner');

  for (const [name, username, role, duties] of [
    ['Sunita Karki', 'manager', 'MANAGER', {}],
    ['Bikash Tamang', 'cashier', 'CASHIER', {}],
    ['Maya Gurung', 'waiter', 'WAITER', {}],
    ['Rohan Rai', 'rohan', 'WAITER', {}],
    ['Suman Thapa', 'kitchen', 'KITCHEN', {}],
    ['Anita Lama', 'anita', 'KITCHEN', { canTakeOrders: true }],
  ] as const) {
    await api('/management/staff', { name, username, role, password: PASSWORD, ...duties }, owner);
  }
  const cashier = await signIn(DEMO_WORKSPACE, 'cashier');
  const waiter = await signIn(DEMO_WORKSPACE, 'waiter');
  const kitchen = await signIn(DEMO_WORKSPACE, 'kitchen');

  await api(
    '/management/settings/operational',
    { billFooterText: 'Thank you for dining with us. See you again soon!', customerMenuEnabled: true },
    owner,
    'PATCH',
  );
  await api(
    '/loyalty/settings',
    { enabled: true, earnEveryPaisa: 10000, pointValuePaisa: 100, expectedVersion: 0 },
    owner,
    'PATCH',
  );

  const tables: { id: string; name: string }[] = [];
  for (const [areaIndex, areaName] of ['Main Hall', 'Rooftop', 'Garden'].entries()) {
    const floor = await api<{ areas: { id: string; name: string }[] }>(
      '/floor/areas',
      { name: areaName, sortOrder: areaIndex },
      owner,
    );
    const areaId = floor.areas.find((area) => area.name === areaName)!.id;
    const count = areaIndex === 0 ? 8 : areaIndex === 1 ? 6 : 4;
    const prefix = areaIndex === 0 ? 'T' : areaIndex === 1 ? 'R' : 'G';
    for (let number = 1; number <= count; number += 1) {
      const name = `${prefix}${String(number)}`;
      const updated = await api<{ areas: { tables: { id: string; name: string }[] }[] }>(
        '/floor/tables',
        { areaId, name, capacity: number % 4 === 0 ? 6 : number % 3 === 0 ? 2 : 4, sortOrder: number },
        owner,
      );
      tables.push(updated.areas.flatMap((area) => area.tables).find((table) => table.name === name)!);
    }
  }

  const dishes: Record<string, string> = {};
  for (const category of HIMALAYAN_MENU) {
    const menu = await api<{ categories: { id: string; name: string }[] }>(
      '/management/menu/categories',
      { name: category.name, nameNp: category.np },
      owner,
    );
    const categoryId = menu.categories.find((row) => row.name === category.name)!.id;
    for (const [name, nameNp, pricePaisa] of category.items) {
      const updated = await api<{ categories: { items: { id: string; name: string }[] }[] }>(
        '/management/menu/items',
        { categoryId, name, nameNp, pricePaisa },
        owner,
      );
      dishes[name] = updated.categories.flatMap((row) => row.items).find((item) => item.name === name)!.id;
    }
  }

  const ingredients: Record<string, IngredientDto> = {};
  for (const [name, unit, amount, low, cost, supplier] of [
    ['Chicken', 'g', 60_000_000, 8_000_000, 2_160_000, 'Himalayan Fresh Supplies'],
    ['Flour', 'g', 50_000_000, 6_000_000, 350_000, 'Valley Food Traders'],
    ['Rice', 'g', 50_000_000, 8_000_000, 550_000, 'Valley Food Traders'],
    ['Cooking Oil', 'ml', 30_000_000, 4_000_000, 720_000, 'Valley Food Traders'],
    ['Cabbage', 'g', 30_000_000, 4_000_000, 180_000, 'Morning Vegetable Market'],
    ['Paneer', 'g', 6_000_000, 1_500_000, 480_000, 'Local Dairy Cooperative'],
    ['Milk', 'ml', 15_000_000, 3_000_000, 180_000, 'Local Dairy Cooperative'],
    ['Tea Leaves', 'g', 1_200_000, 500_000, 96_000, 'Ilam Tea House'],
    ['Mutton', 'g', 40_000_000, 3_000_000, 4_800_000, 'Himalayan Fresh Supplies'],
  ] as const) {
    const ingredient = (
      await api<{ ingredient: IngredientDto }>(
        '/inventory/ingredients',
        { name, unit, lowStockMilli: low },
        owner,
      )
    ).ingredient;
    await api(
      `/inventory/ingredients/${ingredient.id}/stock`,
      {
        expectedVersion: 0,
        kind: 'PURCHASE',
        quantityMilli: amount,
        costPaisa: cost,
        method: 'QR',
        supplier,
        reason: 'Weekly supplies',
      },
      owner,
    );
    ingredients[name] = ingredient;
  }
  for (const [dish, recipe] of [
    ['Chicken Momo', [['Chicken', 100_000], ['Flour', 70_000], ['Cooking Oil', 10_000]]],
    ['Veg Momo', [['Cabbage', 100_000], ['Flour', 70_000], ['Cooking Oil', 10_000]]],
    ['Chicken Thakali Set', [['Chicken', 150_000], ['Rice', 150_000], ['Cooking Oil', 15_000]]],
    ['Mutton Thakali Set', [['Mutton', 180_000], ['Rice', 150_000], ['Cooking Oil', 15_000]]],
    ['Paneer Chilli', [['Paneer', 120_000], ['Cooking Oil', 20_000]]],
    ['Masala Tea', [['Milk', 150_000], ['Tea Leaves', 5_000]]],
  ] as const) {
    await api(
      `/inventory/recipes/${dishes[dish]!}`,
      {
        expectedVersion: 0,
        reason: 'Standard kitchen portion',
        ingredients: recipe.map(([name, quantityMilli]) => ({
          ingredientId: ingredients[name]!.id,
          quantityMilli,
        })),
      },
      owner,
    );
  }

  const customers: { id: string; name: string }[] = [];
  for (const [name, phone, address] of [
    ['Himalayan Design Studio', '9801234567', 'Jhamsikhel'],
    ['Valley Cycling Club', '9812345678', 'Patan Durbar Square'],
    ['Lalitpur Book Circle', '9841122334', 'Kupondole'],
    ['Priya Maharjan', '9860011223', 'Sanepa'],
  ] as const) {
    customers.push((await api<CustomerStatementResponse>('/customers', { name, phone, address }, owner)).customer);
  }

  async function order(lines: readonly Line[], tableIndex: number | null, token = waiter): Promise<OrderDto> {
    let result: OrderDto | undefined;
    for (const [name, quantity, note] of lines) {
      result = (
        await api<OrderResponse>(
          '/orders/items',
          {
            target: result
              ? { kind: 'ORDER', orderId: result.id, expectedVersion: result.version }
              : tableIndex === null
                ? { kind: 'TAKEAWAY' }
                : { kind: 'TABLE', tableId: tables[tableIndex]!.id },
            menuItemId: dishes[name],
            quantity,
            ...(note ? { note } : {}),
          },
          token,
        )
      ).order;
    }
    return result!;
  }

  async function dispatch(
    open: OrderDto,
    status: 'NEW' | 'PREPARING' | 'READY' | 'SERVED',
  ): Promise<SendToKitchenResponse> {
    const result = await api<SendToKitchenResponse>(
      `/orders/${open.id}/send-kot`,
      { expectedVersion: open.version },
      waiter,
    );
    for (const step of ['PREPARING', 'READY', 'SERVED'] as const) {
      if (status === 'NEW') break;
      await api(`/kitchen/tickets/${result.kot.id}/status`, { status: step }, kitchen, 'PATCH');
      if (step === status) break;
    }
    return result;
  }

  async function issue(open: OrderDto, buyerName?: string): Promise<InvoiceDto> {
    return (
      await api<{ invoice: InvoiceDto }>(
        `/orders/${open.id}/invoice`,
        { expectedVersion: open.version, ...(buyerName ? { buyerName } : {}) },
        cashier,
      )
    ).invoice;
  }

  async function pay(invoice: InvoiceDto, method: string, customerId?: string): Promise<InvoiceDto> {
    return (
      await api<{ invoice: InvoiceDto }>(
        `/invoices/${invoice.id}/payments`,
        {
          expectedOrderVersion: invoice.orderVersion,
          method,
          amountPaisa: invoice.settlement.remainingPaisa,
          ...(customerId ? { customerId } : {}),
        },
        cashier,
      )
    ).invoice;
  }

  /**
   * Moves a completed sale to an earlier business day so reports and the
   * dashboard have history. Only paid, non-cash sales are moved, so no cash
   * drawer total is affected.
   */
  async function backdate(invoice: InvoiceDto, daysAgo: number, minuteOfDay: number): Promise<void> {
    const at = new Date(Date.now() - daysAgo * DAY_MS);
    at.setHours(0, 0, 0, 0);
    const when = new Date(at.getTime() + minuteOfDay * 60_000);
    const businessDate = resolveBusinessDate(when, 240);
    await prisma.$transaction([
      prisma.order.update({
        where: { id: invoice.orderId },
        data: { businessDate, createdAt: new Date(when.getTime() - 50 * 60_000), closedAt: when },
      }),
      prisma.orderItem.updateMany({
        where: { orderId: invoice.orderId },
        data: { createdAt: new Date(when.getTime() - 50 * 60_000) },
      }),
      prisma.kot.updateMany({
        where: { orderId: invoice.orderId },
        data: {
          createdAt: new Date(when.getTime() - 45 * 60_000),
          startedAt: new Date(when.getTime() - 40 * 60_000),
          readyAt: new Date(when.getTime() - 25 * 60_000),
          servedAt: new Date(when.getTime() - 20 * 60_000),
        },
      }),
      prisma.invoice.update({ where: { id: invoice.id }, data: { businessDate, issuedAt: when } }),
      prisma.payment.updateMany({ where: { invoiceId: invoice.id }, data: { createdAt: when } }),
    ]);
  }

  console.log('  history…');
  let sale = 0;
  for (let daysAgo = HISTORY_DAYS; daysAgo >= 1; daysAgo -= 1) {
    const weekday = new Date(Date.now() - daysAgo * DAY_MS).getDay();
    const covers = 9 + ((daysAgo * 7) % 5) + (weekday === 5 || weekday === 6 ? 5 : 0);
    for (let index = 0; index < covers; index += 1) {
      const lines = SALE_PATTERNS[(sale * 5 + daysAgo) % SALE_PATTERNS.length]!;
      const takeaway = sale % 6 === 0;
      const open = await order(lines, takeaway ? null : sale % tables.length);
      const sent = await dispatch(open, 'SERVED');
      const invoice = await issue(sent.order);
      await pay(invoice, sale % 3 === 0 ? 'CARD' : 'QR');
      const lunch = index < covers / 2;
      await backdate(invoice, daysAgo, (lunch ? 11 * 60 + 30 : 18 * 60 + 15) + ((index * 23) % 150));
      sale += 1;
    }
  }

  console.log('  today’s service…');
  await api('/shifts', { openingFloatPaisa: 500_000 }, cashier);
  const paidToday: InvoiceDto[] = [];
  for (let index = 0; index < 14; index += 1) {
    const open = await order(SALE_PATTERNS[index % SALE_PATTERNS.length]!, index % 6 === 0 ? null : index % tables.length);
    const sent = await dispatch(open, 'SERVED');
    const customer = index >= 10 ? customers[index - 10] : undefined;
    const invoice = await issue(sent.order, customer?.name);
    paidToday.push(await pay(invoice, customer ? 'CREDIT' : ['CASH', 'QR', 'CARD'][index % 3]!, customer?.id));
  }

  const firstCustomer = await api<CustomerStatementResponse>(`/customers/${customers[0]!.id}/statement`, undefined, owner);
  await api(
    `/customers/${customers[0]!.id}/repayments`,
    {
      expectedVersion: firstCustomer.customer.version,
      amountPaisa: Math.floor(firstCustomer.customer.balancePaisa / 2 / 100) * 100,
      method: 'CASH',
      note: 'Office lunch account repayment',
    },
    cashier,
  );
  const refunded = paidToday[4]!;
  await api(
    `/payments/${refunded.settlement.payments[0]!.id}/refunds`,
    { amountPaisa: 20_000, expectedRefundedPaisa: 0, reason: 'One unopened drink returned by the guest' },
    owner,
  );

  const today = resolveBusinessDate(new Date(), 240);
  for (const [category, supplier, note, amountPaisa, method, drawer] of [
    ['Utilities', 'Nepal Electricity Authority', 'Monthly electricity bill', 1_245_000, 'QR', 'EXTERNAL'],
    ['Wages', 'Weekend service team', 'Evening service allowance', 200_000, 'CASH', 'NEW'],
    ['Maintenance', 'Kitchen Care Services', 'Exhaust filter cleaning', 85_000, 'CASH', 'NEW'],
    ['Other', 'Neighbourhood Stationery', 'Receipt rolls and order pads', 45_000, 'CASH', 'NEW'],
  ] as const) {
    await api('/expenses', { amountPaisa, method, category, supplier, note, businessDate: today, drawer }, owner);
  }
  const mutton = await prisma.ingredient.findUniqueOrThrow({ where: { id: ingredients['Mutton']!.id } });
  // Leaves mutton below its reorder level so the low-stock alert has something to show.
  await api(
    `/inventory/ingredients/${mutton.id}/stock`,
    {
      expectedVersion: mutton.version,
      kind: 'WASTE',
      quantityMilli: Math.max(0, mutton.onHandMilli - 2_400_000),
      reason: 'Freezer temperature fault',
    },
    owner,
  );

  console.log('  tables in service…');
  await order([['Chicken Momo', 2, 'Less spicy'], ['Veg Momo', 1], ['Fresh Lime Soda', 2]], 0);
  for (const [tableIndex, status, lines] of [
    [1, 'NEW', [['Chicken Momo', 2], ['Chicken Chowmein', 1, 'No onion']]],
    [2, 'PREPARING', [['Chicken Thakali Set', 2], ['Mineral Water', 1]]],
    [3, 'READY', [['Veg Momo', 2], ['French Fries', 1]]],
    [8, 'NEW', [['Chicken Chilli', 1], ['Coke', 2]]],
    [9, 'PREPARING', [['Paneer Chilli', 1], ['Veg Chowmein', 2]]],
    [10, 'SERVED', [['Chicken Fried Rice', 2], ['Fresh Lime Soda', 2]]],
  ] as const) {
    await dispatch(await order(lines, tableIndex), status);
  }
  const awaitingPayment = await dispatch(
    await order([['Mutton Thakali Set', 2], ['Mango Lassi', 2], ['Juju Dhau', 2]], 4),
    'SERVED',
  );
  const partial = await issue(awaitingPayment.order);
  await api(
    `/invoices/${partial.id}/payments`,
    { expectedOrderVersion: partial.orderVersion, method: 'QR', amountPaisa: 100_000, reference: 'First share' },
    cashier,
  );
  await dispatch(await order([['Chicken Sekuwa', 1], ['Masala Tea', 2]], null), 'PREPARING');

  void restaurant;
}

async function seedSecondTenant(): Promise<void> {
  console.log(`Creating "${SECOND_WORKSPACE}"…`);
  await api('/tenants/register', {
    restaurant: { slug: SECOND_WORKSPACE, name: 'Everest Café', address: 'Thamel, Kathmandu' },
    owner: { name: 'Nima Sherpa', username: 'owner', password: PASSWORD },
  });
  const owner = await signIn(SECOND_WORKSPACE, 'owner');
  const menu = await api<{ categories: { id: string }[] }>(
    '/management/menu/categories',
    { name: 'Coffee' },
    owner,
  );
  for (const [name, pricePaisa] of [
    ['Americano', 15000],
    ['Café Latte', 18000],
    ['Himalayan Honey Cake', 26000],
  ] as const) {
    await api('/management/menu/items', { categoryId: menu.categories[0]!.id, name, pricePaisa }, owner);
  }
}

try {
  await seedHimalayanKitchen();
  await seedSecondTenant();
  console.log(`
Demo ready.

  Workspace: ${DEMO_WORKSPACE}
  Accounts:  owner, manager, cashier, waiter, kitchen
  Password:  ${process.env['DEMO_PASSWORD'] ? '(DEMO_PASSWORD)' : PASSWORD}

  A second restaurant, "${SECOND_WORKSPACE}" (owner), shows tenant isolation.`);
} finally {
  await stopNayaroServer(handle);
}
