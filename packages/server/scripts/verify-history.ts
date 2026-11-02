/**
 * Invoice history verification - drives the real HTTP API.
 *
 *   npm run verify:history --workspace @nayaro/server
 *
 * The bills list is read-only, so what matters is that it tells the truth:
 * the right rows for the right business day, voided bills marked rather than
 * hidden, totals that exclude what was never owed, and the role boundary.
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import type { InvoiceDto, InvoiceListResponse, OrderDto } from '@nayaro/shared';
import { ensureDataLayout, resolveDataLayout } from '@nayaro/database';
import { createLogger } from '../src/utils/logger';
import { startNayaroServer, stopNayaroServer, type NayaroServerHandle } from '../src/server';
import { hashPassword } from '../src/modules/auth/password';

const ROOT = resolve(tmpdir(), 'nayaro-history-verify');
const PORT = 4336;

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
const orderOf = (body: unknown): OrderDto => (body as { order: OrderDto }).order;
const invoiceOf = (body: unknown): InvoiceDto => (body as { invoice: InvoiceDto }).invoice;
const listOf = (body: unknown): InvoiceListResponse => body as InvoiceListResponse;

async function main(): Promise<void> {
  rmSync(ROOT, { recursive: true, force: true });
  const layout = ensureDataLayout(resolveDataLayout(ROOT));
  const handle: NayaroServerHandle = await startNayaroServer({
    port: PORT,
    databaseFilePath: layout.databaseFilePath,
    logger: createLogger({ scope: 'verify-history', silent: true }),
  });
  const { prisma } = handle;

  try {
    console.log('[setup]');
    await call('POST', '/tenants/register', {
      body: {
        restaurant: { slug: 'verify-restaurant', name: 'Himali Bhansa Ghar' },
        owner: { name: 'Rajan Shrestha', username: 'rajan.s', password: 'correct-horse-battery' },
      },
    });
    const restaurant = await prisma.restaurant.findFirstOrThrow();
    for (const [name, username, role] of [
      ['Bikash Tamang', 'bikash.t', 'CASHIER'],
      ['Hari Thapa', 'hari.t', 'WAITER'],
      ['Maya Gurung', 'maya.g', 'KITCHEN'],
    ] as const) {
      await prisma.staff.create({
        data: {
          restaurantId: restaurant.id,
          name,
          username,
          passwordHash: await hashPassword('staff1234'),
          role,
        },
      });
    }
    const tokenFor = async (u: string, p: string): Promise<string> =>
      (
        (await call('POST', '/auth/login', { body: { workspace: 'verify-restaurant', username: u, password: p } })).body as {
          token: string;
        }
      ).token;
    const owner = await tokenFor('rajan.s', 'correct-horse-battery');
    const cashier = await tokenFor('bikash.t', 'staff1234');
    const waiter = await tokenFor('hari.t', 'staff1234');
    const kitchen = await tokenFor('maya.g', 'staff1234');

    const area = await prisma.restaurantArea.create({
      data: { restaurantId: restaurant.id, name: 'Ground Floor' },
    });
    const category = await prisma.menuCategory.create({
      data: { restaurantId: restaurant.id, name: 'Momo' },
    });
    const momo = await prisma.menuItem.create({
      data: {
        restaurantId: restaurant.id,
        categoryId: category.id,
        name: 'Chicken Momo',
        pricePaisa: 22000,
      },
    });

    let seq = 0;
    /** Table -> kitchen -> invoice. Returns the invoice and the order version to pay against. */
    const billed = async (
      quantity: number,
      buyer: { buyerName?: string; buyerPan?: string } = {},
    ): Promise<{ invoice: InvoiceDto; version: number; tableName: string }> => {
      seq += 1;
      const table = await prisma.restaurantTable.create({
        data: { restaurantId: restaurant.id, areaId: area.id, name: `Table ${String(seq)}` },
      });
      let order = orderOf(
        (
          await call('POST', '/orders/items', {
            token: cashier,
            body: { target: { kind: 'TABLE', tableId: table.id }, menuItemId: momo.id, quantity },
          })
        ).body,
      );
      order = orderOf(
        (
          await call('POST', `/orders/${order.id}/send-kot`, {
            token: cashier,
            body: { expectedVersion: order.version },
          })
        ).body,
      );
      const invoice = invoiceOf(
        (
          await call('POST', `/orders/${order.id}/invoice`, {
            token: cashier,
            body: { expectedVersion: order.version, ...buyer },
          })
        ).body,
      );
      const fresh = await prisma.order.findFirstOrThrow({ where: { id: order.id } });
      return { invoice, version: fresh.version, tableName: table.name };
    };

    // Four bills: one paid in cash, one part-paid by QR, one unpaid, one voided.
    const paid = await billed(1, { buyerName: 'Anjali Rai', buyerPan: '123456789' });
    await call('POST', `/invoices/${paid.invoice.id}/payments`, {
      token: cashier,
      body: { expectedOrderVersion: paid.version, method: 'CASH', amountPaisa: 22000 },
    });
    const partial = await billed(2);
    await call('POST', `/invoices/${partial.invoice.id}/payments`, {
      token: cashier,
      body: { expectedOrderVersion: partial.version, method: 'QR', amountPaisa: 10000 },
    });
    const unpaid = await billed(3);
    const voided = await billed(4);
    await call('POST', `/invoices/${voided.invoice.id}/void`, {
      token: owner,
      body: { reason: 'Billed to the wrong table' },
    });
    await call('POST', `/invoices/${paid.invoice.id}/prints`, { token: cashier });
    check('fixtures created', true);

    // --------------------------------------------------------------- roles
    console.log('\n[roles] who may read the bills list');
    check('cashier -> 200', (await call('GET', '/invoices', { token: cashier })).status === 200);
    check('owner -> 200', (await call('GET', '/invoices', { token: owner })).status === 200);
    let r = await call('GET', '/invoices', { token: waiter });
    check('waiter -> 403', r.status === 403, r.status);
    r = await call('GET', '/invoices', { token: kitchen });
    check('kitchen -> 403', r.status === 403, r.status);
    r = await call('GET', '/invoices');
    check('no session -> 401', r.status === 401, r.status);

    // ------------------------------------------------------------- default
    console.log('\n[today] the default is the current business day');
    r = await call('GET', '/invoices', { token: cashier });
    let list = listOf(r.body);
    const today = paid.invoice.businessDate;
    check(
      'range defaults to today',
      list.from === today && list.to === today,
      `${list.from}..${list.to}`,
    );
    check('all four bills listed', list.invoices.length === 4, list.invoices.length);
    check(
      'newest first',
      list.invoices[0]?.id === voided.invoice.id && list.invoices[3]?.id === paid.invoice.id,
    );
    check('not truncated', !list.truncated);

    const row = (id: string) => list.invoices.find((i) => i.id === id);
    check('paid bill reads PAID', row(paid.invoice.id)?.settlementStatus === 'PAID');
    check(
      'paid bill lists CASH',
      row(paid.invoice.id)?.paymentMethods.join() === 'CASH',
      row(paid.invoice.id)?.paymentMethods.join(),
    );
    check('paid bill shows its print', row(paid.invoice.id)?.printCount === 1);
    check('paid bill carries the buyer', row(paid.invoice.id)?.buyerName === 'Anjali Rai');
    check('part-paid bill reads PARTIAL', row(partial.invoice.id)?.settlementStatus === 'PARTIAL');
    check('part-paid bill paid 100.00', row(partial.invoice.id)?.totalPaidPaisa === 10000);
    check('unpaid bill reads UNPAID', row(unpaid.invoice.id)?.settlementStatus === 'UNPAID');
    check('voided bill is listed and marked VOID', row(voided.invoice.id)?.status === 'VOID');
    check('table name travels', row(unpaid.invoice.id)?.tableName === unpaid.tableName);
    check('issuer is named', row(unpaid.invoice.id)?.issuedBy.name === 'Bikash Tamang');

    console.log('\n[totals] voided bills were never owed');
    check('3 active, 1 void', list.totals.activeCount === 3 && list.totals.voidCount === 1);
    // 220 + 440 + 660 = 1320.00; the voided 880 is excluded.
    check('billed 1320.00', list.totals.billedPaisa === 132000, list.totals.billedPaisa);
    check('paid 320.00', list.totals.paidPaisa === 32000, list.totals.paidPaisa);
    check(
      'outstanding 1000.00',
      list.totals.outstandingPaisa === 100000,
      list.totals.outstandingPaisa,
    );

    // -------------------------------------------------------------- filters
    console.log('\n[filters]');
    list = listOf((await call('GET', '/invoices?status=VOID', { token: cashier })).body);
    check(
      'status=VOID -> only the voided bill',
      list.invoices.length === 1 && list.invoices[0]?.id === voided.invoice.id,
    );
    list = listOf((await call('GET', '/invoices?status=ACTIVE', { token: cashier })).body);
    check('status=ACTIVE -> three', list.invoices.length === 3);

    list = listOf(
      (await call('GET', `/invoices?q=${String(unpaid.invoice.invoiceNumber)}`, { token: cashier }))
        .body,
    );
    check(
      'search by invoice number finds it',
      list.invoices.some((i) => i.id === unpaid.invoice.id),
    );
    list = listOf(
      (
        await call(
          'GET',
          `/invoices?q=${encodeURIComponent(`#${String(unpaid.invoice.invoiceNumber)}`)}`,
          { token: cashier },
        )
      ).body,
    );
    check(
      '"#n" means the same as "n"',
      list.invoices.some((i) => i.id === unpaid.invoice.id),
    );
    list = listOf((await call('GET', '/invoices?q=anjali', { token: cashier })).body);
    check(
      'search by buyer name is case-insensitive',
      list.invoices.length === 1 && list.invoices[0]?.id === paid.invoice.id,
    );
    list = listOf((await call('GET', '/invoices?q=123456789', { token: cashier })).body);
    check(
      'search by buyer PAN',
      list.invoices.length === 1 && list.invoices[0]?.id === paid.invoice.id,
    );
    list = listOf(
      (
        await call('GET', `/invoices?q=${encodeURIComponent(partial.tableName)}`, {
          token: cashier,
        })
      ).body,
    );
    check(
      'search by table name',
      list.invoices.some((i) => i.id === partial.invoice.id),
    );
    list = listOf((await call('GET', '/invoices?q=nobody-here', { token: cashier })).body);
    check(
      'no match -> empty, totals zero',
      list.invoices.length === 0 && list.totals.billedPaisa === 0,
    );

    console.log('\n[dates]');
    list = listOf(
      (await call('GET', '/invoices?from=2000-01-01&to=2000-01-02', { token: cashier })).body,
    );
    check('a past range with no trade is empty', list.invoices.length === 0);
    r = await call('GET', '/invoices?from=2026-01-01&to=2026-12-31', { token: cashier });
    check(
      'a year-wide range -> 400 RANGE_TOO_WIDE',
      errorCode(r.body) === 'RANGE_TOO_WIDE',
      r.status,
    );
    r = await call('GET', '/invoices?from=2026-05-02&to=2026-05-01', { token: cashier });
    check('from after to -> 400', r.status === 400, r.status);
    r = await call('GET', '/invoices?from=yesterday', { token: cashier });
    check('malformed date -> 400', r.status === 400, r.status);
    r = await call('GET', '/invoices?status=PAID', { token: cashier });
    check('unknown status -> 400', r.status === 400, r.status);
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
