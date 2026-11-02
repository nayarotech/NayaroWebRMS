/**
 * Phase 4H backend verification.
 *
 *   npm run verify:management --workspace @nayaro/server
 *
 * THE FRESH-INSTALL TEST. Everything below runs against an EMPTY database and
 * reaches it only through the product's own HTTP API. There is no dev seed, no
 * SQL, no Prisma Studio and no hand-inserted row anywhere in the setup path -
 * because a restaurant that installs Nayaro RMS has none of those either.
 *
 * The few direct database reads that do appear are ASSERTIONS about what the
 * API did, never fixtures.
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import type {
  InvoiceDto,
  ManagedMenuResponse,
  MenuResponse,
  OrderDto,
  SettingsResponse,
  StaffListResponse,
} from '@nayaro/shared';
import {
  ensureDataLayout,
  resolveDataLayout,
} from '@nayaro/database';
import { createLogger } from '../src/utils/logger';
import { startNayaroServer, stopNayaroServer, type NayaroServerHandle } from '../src/server';

const ROOT = resolve(tmpdir(), 'nayaro-4h-verify');
const RESTORE_ROOT = resolve(tmpdir(), 'nayaro-4h-restore');
const PORT = 4333;

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: unknown): void {
  if (ok) pass += 1;
  else fail += 1;
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  -> ${String(detail)}`}`,
  );
}

interface Res {
  readonly status: number;
  readonly body: unknown;
}

function callOn(
  port: number,
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<Res> {
  return new Promise((res, rej) => {
    const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        agent: false,
        headers: {
          ...(payload === null ? {} : { 'Content-Type': 'application/json' }),
          ...(opts.token === undefined ? {} : { Authorization: `Bearer ${opts.token}` }),
        },
      },
      (r) => {
        let raw = '';
        r.setEncoding('utf8');
        r.on('data', (c: string) => (raw += c));
        r.on('end', () => {
          let body: unknown = null;
          if (raw.length > 0) {
            try {
              body = JSON.parse(raw) as unknown;
            } catch {
              body = raw;
            }
          }
          res({ status: r.statusCode ?? 0, body });
        });
      },
    );
    req.on('error', rej);
    if (payload !== null) req.write(payload);
    req.end();
  });
}
const call = (m: string, p: string, o: { token?: string; body?: unknown } = {}): Promise<Res> =>
  callOn(PORT, m, p, o);

const errorCode = (body: unknown): string | undefined =>
  (body as { error?: { code?: string } } | null)?.error?.code;
const menuOf = (body: unknown): ManagedMenuResponse => body as ManagedMenuResponse;
const staffOf = (body: unknown): StaffListResponse => body as StaffListResponse;
const orderOf = (body: unknown): OrderDto => (body as { order: OrderDto }).order;
const invoiceOf = (body: unknown): InvoiceDto => (body as { invoice: InvoiceDto }).invoice;
const findItem = (menu: ManagedMenuResponse, name: string) =>
  menu.categories.flatMap((c) => c.items).find((i) => i.name === name);
const findCategory = (menu: ManagedMenuResponse, name: string) =>
  menu.categories.find((c) => c.name === name);

async function main(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true });
  rmSync(RESTORE_ROOT, { recursive: true, force: true });
  const layout = ensureDataLayout(resolveDataLayout(ROOT));
  const handle: NayaroServerHandle = await startNayaroServer({
    port: PORT,
    databaseFilePath: layout.databaseFilePath,
    logger: createLogger({ scope: 'verify-management', silent: true }),
  });
  const { prisma } = handle;

  try {
    // =====================================================================
    // FRESH INSTALL - product flows only
    // =====================================================================
    console.log('[fresh install] an empty database');
    check('no restaurant exists', (await prisma.restaurant.count()) === 0);
    check('no staff exist', (await prisma.staff.count()) === 0);
    check('no menu exists', (await prisma.menuItem.count()) === 0);

    console.log('\n[setup] bootstrap through the public endpoint');
    let r = await call('POST', '/tenants/register', {
      body: {
        restaurant: { slug: 'verify-restaurant',
          name: 'Himali Bhansa Ghar',
          address: 'Jhamsikhel, Lalitpur',
          phone: '01-5432198',
          panNumber: '601234567',
        },
        owner: { name: 'Rajan Shrestha', username: 'rajan.s', password: 'correct-horse-battery' },
      },
    });
    check('bootstrap -> 201', r.status === 201, r.status);
    const tokenFor = async (u: string, p: string): Promise<string> =>
      (
        (await call('POST', '/auth/login', { body: { workspace: 'verify-restaurant', username: u, password: p } })).body as {
          token?: string;
        }
      ).token ?? '';
    const owner = await tokenFor('rajan.s', 'correct-horse-battery');
    check('the owner can sign in', owner.length > 0);
    check('and is the only account', (await prisma.staff.count()) === 1);
    check('with still no menu', (await prisma.menuItem.count()) === 0);

    // ------------------------------------------------------------- staff
    console.log('\n[staff] creating the team');
    for (const [name, username, role] of [
      ['Sunita Karki', 'sunita.k', 'MANAGER'],
      ['Bikash Tamang', 'bikash.t', 'CASHIER'],
      ['Maya Gurung', 'maya.g', 'KITCHEN'],
    ] as const) {
      const created = await call('POST', '/management/staff', {
        token: owner,
        body: { name, username, password: 'staff1234', role },
      });
      check(`created ${role} ${username}`, created.status === 201, created.status);
    }
    const manager = await tokenFor('sunita.k', 'staff1234');
    const cashier = await tokenFor('bikash.t', 'staff1234');
    const kitchen = await tokenFor('maya.g', 'staff1234');
    check(
      'all three can sign in',
      [manager, cashier, kitchen].every((t) => t.length > 0),
    );

    r = await call('GET', '/management/staff', { token: owner });
    const staffList = staffOf(r.body);
    check('four accounts listed', staffList.staff.length === 4, staffList.staff.length);
    check(
      'the owner is marked as self',
      staffList.staff.find((s) => s.isSelf)?.username === 'rajan.s',
    );
    check('no password hash is exposed', !/passwordHash|scrypt\$/.test(JSON.stringify(r.body)));

    r = await call('POST', '/management/staff', {
      token: owner,
      body: { name: 'Duplicate', username: 'bikash.t', password: 'staff1234', role: 'CASHIER' },
    });
    check('a duplicate username -> 409', r.status === 409, r.status);
    check('code USERNAME_TAKEN', errorCode(r.body) === 'USERNAME_TAKEN');

    console.log('\n[staff] the last owner cannot be removed');
    const ownerRow = staffList.staff.find((s) => s.role === 'OWNER');
    r = await call('PATCH', `/management/staff/${ownerRow?.id ?? ''}`, {
      token: owner,
      body: { isActive: false },
    });
    check('deactivating the only owner -> 409', r.status === 409, r.status);
    check('code LAST_OWNER', errorCode(r.body) === 'LAST_OWNER');
    r = await call('PATCH', `/management/staff/${ownerRow?.id ?? ''}`, {
      token: owner,
      body: { role: 'MANAGER' },
    });
    check('demoting the only owner -> 409', r.status === 409, r.status);
    check(
      'the owner is untouched',
      (await prisma.staff.findFirstOrThrow({ where: { username: 'rajan.s' } })).role === 'OWNER',
    );

    console.log('\n[staff] a manager cannot reach an owner');
    r = await call('PATCH', `/management/staff/${ownerRow?.id ?? ''}`, {
      token: manager,
      body: { name: 'Hijacked' },
    });
    check('manager editing an owner -> 403', r.status === 403, r.status);
    check('code OWNER_REQUIRED', errorCode(r.body) === 'OWNER_REQUIRED');
    r = await call('POST', `/management/staff/${ownerRow?.id ?? ''}/password`, {
      token: manager,
      body: { newPassword: 'hijacked-password' },
    });
    check('manager resetting an owner password -> 403', r.status === 403, r.status);
    check(
      'the owner password still works',
      (await tokenFor('rajan.s', 'correct-horse-battery')).length > 0,
    );
    r = await call('POST', '/management/staff', {
      token: manager,
      body: { name: 'New Owner', username: 'sneaky.o', password: 'staff1234', role: 'OWNER' },
    });
    check('manager creating an owner -> 403', r.status === 403, r.status);

    console.log('\n[staff] deactivation takes effect immediately');
    const cashierRow = staffList.staff.find((s) => s.username === 'bikash.t');
    check(
      'the cashier can read the floor before',
      (await call('GET', '/floor', { token: cashier })).status === 200,
    );
    await call('PATCH', `/management/staff/${cashierRow?.id ?? ''}`, {
      token: manager,
      body: { isActive: false },
    });
    check(
      'after deactivation the session is rejected',
      (await call('GET', '/floor', { token: cashier })).status === 401,
      (await call('GET', '/floor', { token: cashier })).status,
    );
    check('and they cannot sign in again', (await tokenFor('bikash.t', 'staff1234')).length === 0);
    await call('PATCH', `/management/staff/${cashierRow?.id ?? ''}`, {
      token: manager,
      body: { isActive: true },
    });
    const cashier2 = await tokenFor('bikash.t', 'staff1234');
    check('reactivating lets them back in', cashier2.length > 0);

    console.log('\n[passwords]');
    const kitchenRow = staffList.staff.find((s) => s.username === 'maya.g');
    r = await call('POST', '/auth/password', {
      token: kitchen,
      body: { currentPassword: 'wrong-password', newPassword: 'a-new-password' },
    });
    check('a wrong current password -> 400', r.status === 400, r.status);
    check('code CURRENT_PASSWORD_WRONG', errorCode(r.body) === 'CURRENT_PASSWORD_WRONG');
    check('the old password still works', (await tokenFor('maya.g', 'staff1234')).length > 0);

    const kitchenSession = await tokenFor('maya.g', 'staff1234');
    r = await call('POST', '/auth/password', {
      token: kitchenSession,
      body: { currentPassword: 'staff1234', newPassword: 'a-much-better-password' },
    });
    check('changing your own password -> 204', r.status === 204, r.status);
    check('the OLD password stops working', (await tokenFor('maya.g', 'staff1234')).length === 0);
    check(
      'the NEW password works',
      (await tokenFor('maya.g', 'a-much-better-password')).length > 0,
    );
    check(
      'and old sessions were revoked',
      (await call('GET', '/kitchen/tickets', { token: kitchenSession })).status === 401,
    );

    r = await call('POST', `/management/staff/${kitchenRow?.id ?? ''}/password`, {
      token: manager,
      body: { newPassword: 'manager-set-this' },
    });
    check('a manager may reset a subordinate -> 204', r.status === 204, r.status);
    check('the reset password works', (await tokenFor('maya.g', 'manager-set-this')).length > 0);
    r = await call('POST', `/management/staff/${kitchenRow?.id ?? ''}/password`, {
      token: cashier2,
      body: { newPassword: 'nope' },
    });
    check('a cashier may not reset anyone -> 403', r.status === 403, r.status);
    r = await call(
      'POST',
      '/management/staff/' +
        String(staffList.staff.find((s) => s.username === 'sunita.k')?.id) +
        '/password',
      {
        token: manager,
        body: { newPassword: 'reset-myself' },
      },
    );
    check('you cannot reset your own password this way -> 400', r.status === 400, r.status);
    check('code USE_CHANGE_PASSWORD', errorCode(r.body) === 'USE_CHANGE_PASSWORD');

    // -------------------------------------------------------------- menu
    console.log('\n[menu] building a menu from nothing');
    check(
      'the POS menu is empty',
      ((await call('GET', '/menu', { token: cashier2 })).body as MenuResponse).categories.length ===
        0,
    );

    r = await call('POST', '/management/menu/categories', {
      token: manager,
      body: { name: 'Momo', nameNp: 'मोमो' },
    });
    check('create category -> 201', r.status === 201, r.status);
    r = await call('POST', '/management/menu/categories', {
      token: manager,
      body: { name: 'Drinks' },
    });
    check('a second category', r.status === 201);
    let menu = menuOf(r.body);
    check(
      'both listed in order',
      menu.categories.map((c) => c.name).join(',') === 'Momo,Drinks',
      menu.categories.map((c) => c.name).join(','),
    );

    r = await call('POST', '/management/menu/categories', {
      token: manager,
      body: { name: 'Momo' },
    });
    check(
      'a duplicate category -> 409',
      r.status === 409 && errorCode(r.body) === 'CATEGORY_NAME_TAKEN',
    );

    const momoCat = findCategory(menu, 'Momo');
    const drinksCat = findCategory(menu, 'Drinks');
    r = await call('POST', '/management/menu/items', {
      token: manager,
      body: { categoryId: momoCat?.id, name: 'Chicken Momo', nameNp: 'चिकन मोमो', pricePaisa: 22000 },
    });
    check('create item -> 201', r.status === 201, r.status);
    r = await call('POST', '/management/menu/items', {
      token: manager,
      body: { categoryId: drinksCat?.id, name: 'Coke', pricePaisa: 9000 },
    });
    menu = menuOf(r.body);
    check('two items on the menu', menu.categories.flatMap((c) => c.items).length === 2);
    check(
      'the POS can now see them',
      ((await call('GET', '/menu', { token: cashier2 })).body as MenuResponse).categories.flatMap(
        (c) => c.items,
      ).length === 2,
    );

    r = await call('POST', '/management/menu/items', {
      token: manager,
      body: { categoryId: momoCat?.id, name: 'Coke', pricePaisa: 100 },
    });
    check(
      'a duplicate item name -> 409',
      r.status === 409 && errorCode(r.body) === 'MENU_ITEM_NAME_TAKEN',
    );
    r = await call('POST', '/management/menu/items', {
      token: manager,
      body: { categoryId: momoCat?.id, name: 'Bad Price', pricePaisa: -1 },
    });
    check('a negative price -> 400', r.status === 400, r.status);

    console.log('\n[menu] category deactivation is guarded');
    r = await call('PATCH', `/management/menu/categories/${momoCat?.id ?? ''}`, {
      token: manager,
      body: { isActive: false },
    });
    check('a category with live items -> 409', r.status === 409, r.status);
    check('code CATEGORY_HAS_ACTIVE_ITEMS', errorCode(r.body) === 'CATEGORY_HAS_ACTIVE_ITEMS');
    check('it says how many are in the way', /1 item/.test(JSON.stringify(r.body)));
    check(
      'children were NOT silently deactivated',
      (await prisma.menuItem.count({ where: { isActive: true } })) === 2,
    );

    console.log('\n[menu] availability');
    const cokeItem = findItem(menu, 'Coke');
    r = await call('PATCH', `/management/menu/items/${cokeItem?.id ?? ''}`, {
      token: manager,
      body: { isAvailable: false },
    });
    check('mark sold out -> 200', r.status === 200, r.status);
    check(
      'the POS stops offering it',
      !((await call('GET', '/menu', { token: cashier2 })).body as MenuResponse).categories
        .flatMap((c) => c.items)
        .some((i) => i.name === 'Coke'),
    );
    check(
      'but management still shows it',
      findItem(menuOf((await call('GET', '/management/menu', { token: manager })).body), 'Coke') !==
        undefined,
    );
    await call('PATCH', `/management/menu/items/${cokeItem?.id ?? ''}`, {
      token: manager,
      body: { isAvailable: true },
    });
    check(
      'marking it back returns it to the POS',
      ((await call('GET', '/menu', { token: cashier2 })).body as MenuResponse).categories
        .flatMap((c) => c.items)
        .some((i) => i.name === 'Coke'),
    );

    console.log('\n[menu] authorization + isolation');
    check(
      'CASHIER cannot manage the menu',
      (await call('GET', '/management/menu', { token: cashier2 })).status === 403,
    );
    check(
      'KITCHEN cannot manage the menu',
      (
        await call('GET', '/management/menu', {
          token: await tokenFor('maya.g', 'manager-set-this'),
        })
      ).status === 403,
    );
    r = await call('POST', '/management/menu/items', {
      token: cashier2,
      body: { categoryId: momoCat?.id, name: 'Sneaky', pricePaisa: 1 },
    });
    check('a cashier cannot create an item -> 403', r.status === 403, r.status);

    // ---------------------------------------------------------- settings
    console.log('\n[settings]');
    r = await call('GET', '/management/settings', { token: manager });
    check('settings read -> 200', r.status === 200, r.status);
    let settings = r.body as SettingsResponse;
    check(
      'the restaurant details came from bootstrap',
      settings.restaurant.name === 'Himali Bhansa Ghar',
    );
    check('PAN was captured', settings.restaurant.panNumber === '601234567');
    check('VAT is OFF by default', settings.financial.vatEnabled === false);
    check('service charge is OFF by default', settings.financial.serviceChargeEnabled === false);
    check('nobody has edited settings yet', settings.updatedBy === null);

    r = await call('PATCH', '/management/settings/financial', {
      token: manager,
      body: { vatEnabled: true },
    });
    check('a MANAGER cannot change tax settings -> 403', r.status === 403, r.status);
    r = await call('PATCH', '/management/settings/financial', {
      token: owner,
      body: { vatEnabled: true, serviceChargeEnabled: true, roundGrandTotalToRupee: true },
    });
    check('the OWNER can -> 200', r.status === 200, r.status);
    settings = r.body as SettingsResponse;
    check(
      'VAT is on at 13%',
      settings.financial.vatEnabled && settings.financial.vatRateBp === 1300,
    );
    check(
      'the change records who made it',
      settings.updatedBy === 'Rajan Shrestha',
      settings.updatedBy,
    );

    r = await call('PATCH', '/management/settings/financial', {
      token: owner,
      body: { vatRateBp: 20000 },
    });
    check('a rate above 100% -> 400', r.status === 400, r.status);
    r = await call('PATCH', '/management/settings/restaurant', {
      token: owner,
      body: { panNumber: 'not-a-pan' },
    });
    check('a malformed PAN -> 400', r.status === 400, r.status);
    r = await call('PATCH', '/management/settings/operational', {
      token: manager,
      body: { billFooterText: 'Thank you, please visit again' },
    });
    check('a MANAGER may change display settings -> 200', r.status === 200, r.status);
    check(
      'the footer was stored',
      (r.body as SettingsResponse).operational.billFooterText === 'Thank you, please visit again',
    );
    check(
      'CASHIER cannot read settings',
      (await call('GET', '/management/settings', { token: cashier2 })).status === 403,
    );

    // --------------------------------------------------------- the floor
    console.log('\n[floor] configured through the product');
    r = await call('POST', '/floor/areas', { token: manager, body: { name: 'Ground Floor' } });
    check('area created', r.status === 201, r.status);
    const areaId = (r.body as { areas: { id: string; name: string }[] }).areas[0]?.id;
    r = await call('POST', '/floor/tables', {
      token: manager,
      body: { areaId, name: 'Table 1', capacity: 4 },
    });
    check('table created', r.status === 201, r.status);
    const tableId = (r.body as { areas: { tables: { id: string; name: string }[] }[] }).areas
      .flatMap((a) => a.tables)
      .find((t) => t.name === 'Table 1')?.id;

    // ------------------------------------------------- the golden loop
    console.log('\n[golden loop] on a restaurant configured entirely through the UI');
    const menuForPos = (await call('GET', '/menu', { token: cashier2 })).body as MenuResponse;
    const momoId = menuForPos.categories
      .flatMap((c) => c.items)
      .find((i) => i.name === 'Chicken Momo')?.id;
    let order = orderOf(
      (
        await call('POST', '/orders/items', {
          token: cashier2,
          body: { target: { kind: 'TABLE', tableId }, menuItemId: momoId, quantity: 2 },
        })
      ).body,
    );
    order = orderOf(
      (
        await call('POST', `/orders/${order.id}/send-kot`, {
          token: cashier2,
          body: { expectedVersion: order.version },
        })
      ).body,
    );
    check('order sent to the kitchen', order.status === 'OPEN');
    const invoice = invoiceOf(
      (
        await call('POST', `/orders/${order.id}/invoice`, {
          token: cashier2,
          body: { expectedVersion: order.version },
        })
      ).body,
    );
    check('invoice issued', invoice.invoiceNumber === 1, invoice.invoiceNumber);
    check(
      'with VAT charged from the new setting',
      invoice.vat.amountPaisa > 0,
      invoice.vat.amountPaisa,
    );
    check('and service charge', invoice.serviceCharge.amountPaisa > 0);

    console.log('\n[seller snapshot] the invoice records who issued it');
    check('seller name frozen', invoice.seller.name === 'Himali Bhansa Ghar', invoice.seller.name);
    check('seller PAN frozen', invoice.seller.pan === '601234567');
    await call('PATCH', '/management/settings/restaurant', {
      token: owner,
      body: { name: 'Himali Bhansa Ghar Pvt Ltd', panNumber: '609999999' },
    });
    const reread = (
      (await call('GET', `/orders/${order.id}/billing`, { token: cashier2 })).body as {
        invoice: InvoiceDto;
      }
    ).invoice;
    check(
      'renaming the restaurant does NOT rewrite the issued invoice',
      reread.seller.name === 'Himali Bhansa Ghar',
      reread.seller.name,
    );
    check('nor its PAN', reread.seller.pan === '601234567', reread.seller.pan);
    check(
      'while settings show the new name',
      ((await call('GET', '/management/settings', { token: owner })).body as SettingsResponse)
        .restaurant.name === 'Himali Bhansa Ghar Pvt Ltd',
    );

    const payVersion = (await prisma.order.findFirstOrThrow({ where: { id: order.id } })).version;
    r = await call('POST', `/invoices/${invoice.id}/payments`, {
      token: cashier2,
      body: {
        expectedOrderVersion: payVersion,
        method: 'CASH',
        amountPaisa: invoice.grandTotalPaisa,
      },
    });
    check('paid -> 201', r.status === 201, r.status);
    check(
      'THE WHOLE LOOP RAN WITH NO SEED AND NO SQL',
      (await prisma.order.findFirstOrThrow({ where: { id: order.id } })).status === 'PAID',
    );
    check(
      'the table is free again',
      (
        (await call('GET', '/floor', { token: cashier2 })).body as {
          areas: { tables: { name: string; status: string }[] }[];
        }
      ).areas
        .flatMap((a) => a.tables)
        .find((t) => t.name === 'Table 1')?.status === 'AVAILABLE',
    );

    console.log('\n[history] menu edits do not rewrite it');
    await call('PATCH', `/management/menu/items/${momoId ?? ''}`, {
      token: manager,
      body: { name: 'Chicken Momo (Steamed)', pricePaisa: 30000 },
    });
    const afterEdit = (
      (await call('GET', `/orders/${order.id}/billing`, { token: cashier2 })).body as {
        invoice: InvoiceDto;
      }
    ).invoice;
    check(
      'the invoice line keeps the original name',
      afterEdit.lines[0]?.description === 'Chicken Momo',
      afterEdit.lines[0]?.description,
    );
    check('and the original price', afterEdit.lines[0]?.unitPricePaisa === 22000);
    check('and the same grand total', afterEdit.grandTotalPaisa === invoice.grandTotalPaisa);

    console.log('\n[menu] an item that has been ordered cannot be deleted');
    check(
      'no DELETE route exists for a menu item',
      (await call('DELETE', `/management/menu/items/${momoId ?? ''}`, { token: owner })).status ===
        404,
    );
    check(
      'nor for a category',
      (await call('DELETE', `/management/menu/categories/${momoCat?.id ?? ''}`, { token: owner }))
        .status === 404,
    );
    check(
      'nor for staff',
      (await call('DELETE', `/management/staff/${cashierRow?.id ?? ''}`, { token: owner }))
        .status === 404,
    );

    console.log('\n[isolation] management is scoped to the signed-in restaurant');
    const other = await prisma.restaurant.create({
      data: { name: 'Other', address: '', phone: '', panNumber: '' },
    });
    const otherCat = await prisma.menuCategory.create({
      data: { restaurantId: other.id, name: 'Other Menu' },
    });
    const otherStaff = await prisma.staff.create({
      data: {
        restaurantId: other.id,
        name: 'Other Owner',
        username: 'other.o',
        passwordHash: 'x',
        role: 'OWNER',
      },
    });
    check(
      "another restaurant's category is invisible",
      !JSON.stringify(
        menuOf((await call('GET', '/management/menu', { token: owner })).body),
      ).includes('Other Menu'),
    );
    check(
      "cannot edit another restaurant's category -> 404",
      (
        await call('PATCH', `/management/menu/categories/${otherCat.id}`, {
          token: owner,
          body: { name: 'Hijacked' },
        })
      ).status === 404,
    );
    check(
      "another restaurant's staff are invisible",
      !staffOf((await call('GET', '/management/staff', { token: owner })).body).staff.some(
        (s) => s.username === 'other.o',
      ),
    );
    check(
      "cannot edit another restaurant's staff -> 404",
      (
        await call('PATCH', `/management/staff/${otherStaff.id}`, {
          token: owner,
          body: { name: 'Hijacked' },
        })
      ).status === 404,
    );
    check(
      'their data is untouched',
      (await prisma.staff.findFirstOrThrow({ where: { id: otherStaff.id } })).name ===
        'Other Owner',
    );

    console.log('\n[errors] nothing leaks');
    const bodies = [
      (
        await call('POST', '/management/staff', {
          token: owner,
          body: { name: 'x', username: 'bikash.t', password: 'staff1234', role: 'CASHIER' },
        })
      ).body,
      (await call('POST', '/management/menu/categories', { token: owner, body: { name: 'Momo' } }))
        .body,
    ];
    check(
      'no Prisma or SQLite detail in any error',
      !bodies.some((b) => /prisma|sqlite|constraint failed|P20\d\d/i.test(JSON.stringify(b))),
      JSON.stringify(bodies).slice(0, 120),
    );
  } finally {
    await stopNayaroServer(handle).catch(() => undefined);
  }

  console.log(`\n${fail === 0 ? `ALL ${String(pass)} CHECKS PASSED` : `${String(fail)} FAILED`}`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error('VERIFICATION ERROR:', error);
  process.exitCode = 1;
});
