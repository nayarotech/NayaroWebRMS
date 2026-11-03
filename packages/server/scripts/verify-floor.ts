/**
 * Phase 4B backend verification - drives the real HTTP API.
 *
 *   npm run verify:floor --workspace @nayaro/server
 *
 * Disposable temp data root, non-default port. Never touches the dev database.
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import type { FloorResponse } from '@nayaro/shared';
import { ensureDataLayout, resolveDataLayout } from '@nayaro/database';
import { createLogger } from '../src/utils/logger';
import { startNayaroServer, stopNayaroServer, type NayaroServerHandle } from '../src/server';
import { hashPassword } from '../src/modules/auth/password';
import { deriveTableStatus } from '../src/modules/floor/floor.mapper';

const ROOT = resolve(tmpdir(), 'nayaro-4b-verify');
const PORT = 4328;

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

function call(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<Res> {
  return new Promise((res, rej) => {
    const payload = opts.body === undefined ? null : JSON.stringify(opts.body);
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: PORT,
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

const errorCode = (body: unknown): string | undefined =>
  (body as { error?: { code?: string } } | null)?.error?.code;

async function main(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true });
  const layout = ensureDataLayout(resolveDataLayout(ROOT));
  const handle: NayaroServerHandle = await startNayaroServer({
    allowDirectRegistration: true,
    port: PORT,
    databaseFilePath: layout.databaseFilePath,
    logger: createLogger({ scope: 'verify-floor', silent: true }),
  });
  const { prisma } = handle;

  try {
    // ------------------------------------------------ pure derivation tests
    console.log('[derived status] precedence, tested directly');
    check('no active order -> AVAILABLE', deriveTableStatus(undefined) === 'AVAILABLE');
    check(
      'DRAFT, no KOT -> OCCUPIED',
      deriveTableStatus({
        orderId: 'o',
        status: 'DRAFT',
        hasActiveInvoice: false,
        kotStatuses: [],
      }) === 'OCCUPIED',
    );
    check(
      'OPEN, KOT NEW -> PREPARING',
      deriveTableStatus({
        orderId: 'o',
        status: 'OPEN',
        hasActiveInvoice: false,
        kotStatuses: ['NEW'],
      }) === 'PREPARING',
    );
    check(
      'OPEN, KOT PREPARING -> PREPARING',
      deriveTableStatus({
        orderId: 'o',
        status: 'OPEN',
        hasActiveInvoice: false,
        kotStatuses: ['PREPARING'],
      }) === 'PREPARING',
    );
    check(
      'KOT READY beats KOT PREPARING -> READY',
      deriveTableStatus({
        orderId: 'o',
        status: 'OPEN',
        hasActiveInvoice: false,
        kotStatuses: ['PREPARING', 'READY'],
      }) === 'READY',
    );
    check(
      'all KOTs SERVED -> OCCUPIED',
      deriveTableStatus({
        orderId: 'o',
        status: 'OPEN',
        hasActiveInvoice: false,
        kotStatuses: ['SERVED', 'SERVED'],
      }) === 'OCCUPIED',
    );
    check(
      'BILLED -> AWAITING_PAYMENT',
      deriveTableStatus({
        orderId: 'o',
        status: 'BILLED',
        hasActiveInvoice: true,
        kotStatuses: ['SERVED'],
      }) === 'AWAITING_PAYMENT',
    );
    check(
      'AWAITING_PAYMENT outranks READY (the arguable case, locked)',
      deriveTableStatus({
        orderId: 'o',
        status: 'BILLED',
        hasActiveInvoice: true,
        kotStatuses: ['READY'],
      }) === 'AWAITING_PAYMENT',
    );
    check(
      'active invoice alone is enough, even if status disagrees',
      deriveTableStatus({
        orderId: 'o',
        status: 'OPEN',
        hasActiveInvoice: true,
        kotStatuses: [],
      }) === 'AWAITING_PAYMENT',
    );

    // ------------------------------------------------------------ bootstrap
    console.log('\n[setup] bootstrap + accounts');
    await call('POST', '/tenants/register', {
      body: {
        restaurant: { slug: 'verify-restaurant', name: 'Himali Bhansa Ghar' },
        owner: { name: 'Rajan Shrestha', username: 'rajan.s', password: 'correct-horse-battery' },
      },
    });
    const restaurant = await prisma.restaurant.findFirstOrThrow();

    for (const [username, role] of [
      ['bikash.t', 'CASHIER'],
      ['maya.g', 'KITCHEN'],
    ] as const) {
      await prisma.staff.create({
        data: {
          restaurantId: restaurant.id,
          name: username,
          username,
          passwordHash: await hashPassword('staff1234'),
          role,
        },
      });
    }

    const tokenFor = async (username: string, password: string): Promise<string> => {
      const r = await call('POST', '/auth/login', { body: { workspace: 'verify-restaurant', username, password } });
      return (r.body as { token: string }).token;
    };
    const owner = await tokenFor('rajan.s', 'correct-horse-battery');
    const cashier = await tokenFor('bikash.t', 'staff1234');
    const kitchen = await tokenFor('maya.g', 'staff1234');
    check(
      'owner, cashier and kitchen signed in',
      [owner, cashier, kitchen].every((t) => t.length > 0),
    );

    // ----------------------------------------------------------- empty floor
    console.log('\n[floor] empty');
    let r = await call('GET', '/floor', { token: owner });
    check('GET /floor -> 200', r.status === 200, r.status);
    check('areas is an empty list', (r.body as FloorResponse).areas.length === 0);
    check('unauthenticated -> 401', (await call('GET', '/floor')).status === 401);

    // --------------------------------------------------------------- areas
    console.log('\n[areas]');
    r = await call('POST', '/floor/areas', { token: owner, body: { name: '  Ground Floor  ' } });
    check('create area -> 201', r.status === 201, r.status);
    check(
      'name trimmed to "Ground Floor"',
      (r.body as FloorResponse).areas[0]?.name === 'Ground Floor',
    );

    r = await call('POST', '/floor/areas', { token: owner, body: { name: 'Ground Floor' } });
    check('duplicate area -> 409', r.status === 409, r.status);
    check('code AREA_NAME_TAKEN', errorCode(r.body) === 'AREA_NAME_TAKEN');
    check('message is human, not SQL', !/UNIQUE|constraint|prisma/i.test(JSON.stringify(r.body)));

    r = await call('POST', '/floor/areas', { token: owner, body: { name: 'Rooftop' } });
    check('second area created', r.status === 201);
    const areas = (r.body as FloorResponse).areas;
    const ground = areas.find((a) => a.name === 'Ground Floor');
    const rooftop = areas.find((a) => a.name === 'Rooftop');
    check(
      'areas ordered by sortOrder',
      areas[0]?.name === 'Ground Floor' && areas[1]?.name === 'Rooftop',
    );

    r = await call('POST', '/floor/areas', { token: owner, body: { name: '' } });
    check('empty area name -> 400', r.status === 400, r.status);

    r = await call('PATCH', `/floor/areas/${ground?.id ?? ''}`, {
      token: owner,
      body: { name: 'Ground floor' },
    });
    check('rename area -> 200', r.status === 200);
    r = await call('PATCH', '/floor/areas/does-not-exist', { token: owner, body: { name: 'X' } });
    check(
      'unknown area -> 404 AREA_NOT_FOUND',
      r.status === 404 && errorCode(r.body) === 'AREA_NOT_FOUND',
    );

    // --------------------------------------------------------------- tables
    console.log('\n[tables]');
    r = await call('POST', '/floor/tables', {
      token: owner,
      body: { areaId: ground?.id, name: 'Table 1', capacity: 4 },
    });
    check('create table -> 201', r.status === 201, r.status);

    r = await call('POST', '/floor/tables', {
      token: owner,
      body: { areaId: rooftop?.id, name: 'Table 1' },
    });
    check('duplicate table name across areas -> 409', r.status === 409, r.status);
    check('code TABLE_NAME_TAKEN', errorCode(r.body) === 'TABLE_NAME_TAKEN');

    r = await call('POST', '/floor/tables', {
      token: owner,
      body: { areaId: ground?.id, name: 'Table 2' },
    });
    check(
      'capacity defaults to 4',
      (r.body as FloorResponse).areas.flatMap((a) => a.tables).find((t) => t.name === 'Table 2')
        ?.capacity === 4,
    );

    r = await call('POST', '/floor/tables', {
      token: owner,
      body: { areaId: rooftop?.id, name: 'Rooftop 1', capacity: 6 },
    });
    check('table created in the second area', r.status === 201);

    r = await call('POST', '/floor/tables', {
      token: owner,
      body: { areaId: 'nope', name: 'Ghost Table' },
    });
    check('unknown areaId -> 404', r.status === 404, r.status);

    r = await call('POST', '/floor/tables', {
      token: owner,
      body: { areaId: ground?.id, name: 'Bad', capacity: 0 },
    });
    check('capacity 0 -> 400', r.status === 400, r.status);

    // ------------------------------------------------------------ isolation
    console.log('\n[restaurant isolation]');
    const other = await prisma.restaurant.create({
      data: { name: 'Other Restaurant', address: '', phone: '', panNumber: '' },
    });
    const otherArea = await prisma.restaurantArea.create({
      data: { restaurantId: other.id, name: 'Other Area' },
    });
    const otherTable = await prisma.restaurantTable.create({
      data: { restaurantId: other.id, areaId: otherArea.id, name: 'Other Table' },
    });

    r = await call('GET', '/floor', { token: owner });
    const visible = JSON.stringify(r.body);
    check(
      'other restaurant absent from GET /floor',
      !visible.includes('Other Area') && !visible.includes('Other Table'),
    );

    r = await call('PATCH', `/floor/areas/${otherArea.id}`, {
      token: owner,
      body: { name: 'Hijacked' },
    });
    check("cannot edit another restaurant's area -> 404", r.status === 404, r.status);
    r = await call('PATCH', `/floor/tables/${otherTable.id}`, {
      token: owner,
      body: { name: 'Hijacked' },
    });
    check("cannot edit another restaurant's table -> 404", r.status === 404, r.status);
    r = await call('POST', '/floor/tables', {
      token: owner,
      body: { areaId: otherArea.id, name: 'Sneaky' },
    });
    check("cannot attach a table to another restaurant's area -> 404", r.status === 404, r.status);
    check(
      "other restaurant's data untouched",
      (await prisma.restaurantArea.findFirstOrThrow({ where: { id: otherArea.id } })).name ===
        'Other Area',
    );

    // -------------------------------------------------------- authorization
    console.log('\n[authorization]');
    check(
      'CASHIER may read the floor',
      (await call('GET', '/floor', { token: cashier })).status === 200,
    );
    check(
      'KITCHEN may NOT read the floor -> 403',
      (await call('GET', '/floor', { token: kitchen })).status === 403,
    );
    r = await call('POST', '/floor/areas', { token: cashier, body: { name: 'Cashier Area' } });
    check('CASHIER cannot create an area -> 403', r.status === 403, r.status);
    check('code FORBIDDEN', errorCode(r.body) === 'FORBIDDEN');
    r = await call('POST', '/floor/tables', {
      token: cashier,
      body: { areaId: ground?.id, name: 'X' },
    });
    check('CASHIER cannot create a table -> 403', r.status === 403, r.status);

    const manager = await prisma.staff.create({
      data: {
        restaurantId: restaurant.id,
        name: 'Sunita Karki',
        username: 'sunita.k',
        passwordHash: await hashPassword('staff1234'),
        role: 'MANAGER',
      },
    });
    void manager;
    const managerToken = await tokenFor('sunita.k', 'staff1234');
    r = await call('POST', '/floor/areas', { token: managerToken, body: { name: 'Garden' } });
    check('MANAGER may create an area -> 201', r.status === 201, r.status);

    // --------------------------------------------- deactivation and statuses
    console.log('\n[deactivation]');
    const floorNow = (await call('GET', '/floor', { token: owner })).body as FloorResponse;
    const table1 = floorNow.areas.flatMap((a) => a.tables).find((t) => t.name === 'Table 1');
    const table2 = floorNow.areas.flatMap((a) => a.tables).find((t) => t.name === 'Table 2');
    check(
      'all tables start AVAILABLE',
      floorNow.areas.every((a) => a.tables.every((t) => t.status === 'AVAILABLE')),
    );

    // Seat someone at Table 1 by inserting an order directly - the Order
    // service does not exist until Phase 4C.
    const staffRow = await prisma.staff.findFirstOrThrow({ where: { username: 'rajan.s' } });
    const order = await prisma.order.create({
      data: {
        restaurantId: restaurant.id,
        orderNumber: 1,
        type: 'DINE_IN',
        status: 'OPEN',
        tableId: table1?.id ?? '',
        openedByStaffId: staffRow.id,
        businessDate: '2026-08-31',
      },
    });

    const statusOf = async (name: string): Promise<string | undefined> => {
      const f = (await call('GET', '/floor', { token: owner })).body as FloorResponse;
      return f.areas.flatMap((a) => a.tables).find((t) => t.name === name)?.status;
    };
    check(
      'OPEN order, no KOT -> OCCUPIED',
      (await statusOf('Table 1')) === 'OCCUPIED',
      await statusOf('Table 1'),
    );
    check('other tables unaffected', (await statusOf('Table 2')) === 'AVAILABLE');

    r = await call('PATCH', `/floor/tables/${table1?.id ?? ''}`, {
      token: owner,
      body: { isActive: false },
    });
    check('cannot deactivate an occupied table -> 409', r.status === 409, r.status);
    check('code TABLE_IN_USE', errorCode(r.body) === 'TABLE_IN_USE');

    const kot = await prisma.kot.create({
      data: {
        restaurantId: restaurant.id,
        orderId: order.id,
        kotNumber: 1,
        status: 'NEW',
        createdByStaffId: staffRow.id,
      },
    });
    check(
      'KOT NEW -> PREPARING',
      (await statusOf('Table 1')) === 'PREPARING',
      await statusOf('Table 1'),
    );

    await prisma.kot.update({ where: { id: kot.id }, data: { status: 'READY' } });
    check('KOT READY -> READY', (await statusOf('Table 1')) === 'READY', await statusOf('Table 1'));

    await prisma.kot.update({ where: { id: kot.id }, data: { status: 'VOID' } });
    check('VOID KOT ignored -> back to OCCUPIED', (await statusOf('Table 1')) === 'OCCUPIED');
    await prisma.kot.update({ where: { id: kot.id }, data: { status: 'READY' } });

    await prisma.invoice.create({
      data: {
        restaurantId: restaurant.id,
        orderId: order.id,
        invoiceNumber: 1,
        fiscalYearStartBsYear: 2082,
        status: 'ACTIVE',
        issuedByStaffId: staffRow.id,
        businessDate: '2026-08-31',
        subtotalPaisa: 10000,
        grandTotalPaisa: 10000,
      },
    });
    await prisma.order.update({ where: { id: order.id }, data: { status: 'BILLED' } });
    check(
      'ACTIVE invoice outranks READY -> AWAITING_PAYMENT',
      (await statusOf('Table 1')) === 'AWAITING_PAYMENT',
      await statusOf('Table 1'),
    );

    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'PAID', closedAt: new Date() },
    });
    check('closed order -> AVAILABLE again', (await statusOf('Table 1')) === 'AVAILABLE');

    r = await call('PATCH', `/floor/tables/${table1?.id ?? ''}`, {
      token: owner,
      body: { isActive: false },
    });
    check('table can be deactivated once free -> 200', r.status === 200, r.status);
    r = await call('GET', '/floor', { token: cashier });
    check(
      'deactivated table hidden from the cashier view',
      !(r.body as FloorResponse).areas.flatMap((a) => a.tables).some((t) => t.name === 'Table 1'),
    );
    r = await call('GET', '/floor?includeInactive=true', { token: owner });
    check(
      'owner can still see it with includeInactive',
      (r.body as FloorResponse).areas.flatMap((a) => a.tables).some((t) => t.name === 'Table 1'),
    );
    r = await call('GET', '/floor?includeInactive=true', { token: cashier });
    check(
      'cashier cannot force includeInactive',
      !(r.body as FloorResponse).areas.flatMap((a) => a.tables).some((t) => t.name === 'Table 1'),
    );

    console.log('\n[area deactivation]');
    r = await call('PATCH', `/floor/areas/${ground?.id ?? ''}`, {
      token: owner,
      body: { isActive: false },
    });
    check('area with active tables cannot be deactivated -> 409', r.status === 409, r.status);
    check('code AREA_HAS_ACTIVE_TABLES', errorCode(r.body) === 'AREA_HAS_ACTIVE_TABLES');
    check(
      'message names the count',
      /1 active table/.test(JSON.stringify(r.body)),
      JSON.stringify(r.body).slice(0, 120),
    );

    await call('PATCH', `/floor/tables/${table2?.id ?? ''}`, {
      token: owner,
      body: { isActive: false },
    });
    r = await call('PATCH', `/floor/areas/${ground?.id ?? ''}`, {
      token: owner,
      body: { isActive: false },
    });
    check('area deactivates once emptied -> 200', r.status === 200, r.status);

    console.log('\n[query efficiency]');
    // A floor of 30 tables must not turn into 30 status queries. We cannot
    // count SQL from here, so this asserts the observable consequence: the
    // response stays fast and correct as the floor grows.
    const bulkArea = await prisma.restaurantArea.create({
      data: { restaurantId: restaurant.id, name: 'Hall' },
    });
    await prisma.restaurantTable.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({
        restaurantId: restaurant.id,
        areaId: bulkArea.id,
        name: `Hall ${String(i + 1)}`,
        sortOrder: i,
      })),
    });
    const started = Date.now();
    r = await call('GET', '/floor', { token: owner });
    const elapsed = Date.now() - started;
    const total = (r.body as FloorResponse).areas.reduce((n, a) => n + a.tables.length, 0);
    // 30 Hall + Rooftop 1. Table 1, Table 2 and the whole Ground floor area
    // were deactivated above, so an active-only read must not return them.
    check(`31 active tables in one request (${String(elapsed)}ms)`, total === 31, total);
    check('response under 250ms', elapsed < 250, `${String(elapsed)}ms`);
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
