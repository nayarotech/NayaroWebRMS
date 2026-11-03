/** Payroll: owner permissions, frozen monthly amounts, advances, expenses and drawer atomicity. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  CurrentShiftResponse,
  ExpenseSummaryDto,
  LoginResponse,
  PayrollOverview,
  PayrollRecordDto,
  ShiftDto,
} from '@nayaro/shared';
import { startNayaroServer, stopNayaroServer } from '../src/server';
import { registerTenant } from '../src/modules/tenant/tenant.service';
import { hashPassword } from '../src/modules/auth/password';
const root = mkdtempSync(join(tmpdir(), 'nayaro-payroll-'));
let handle: Awaited<ReturnType<typeof startNayaroServer>> | undefined;
let checks = 0;
async function call<T>(
  method: string,
  path: string,
  status: number,
  token?: string,
  body?: unknown,
  key?: string,
): Promise<T> {
  const response = await fetch(`${handle!.baseUrl}${path}`, {
    method,
    headers: {
      Connection: 'close',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  assert.equal(response.status, status, `${method} ${path}: ${text}`);
  checks++;
  return (text ? JSON.parse(text) : null) as T;
}
try {
  const start = () =>
    startNayaroServer({
      allowDirectRegistration: true,
      host: '127.0.0.1',
      port: 4358,
      databaseFilePath: join(root, 'data.db'),
      silent: true,
    });
  handle = await start();
  const { prisma } = handle;
  const { restaurantId, ownerStaffId } = await registerTenant(prisma, {
    restaurant: { slug: 'verify-restaurant', name: 'Payroll restaurant' },
    owner: { name: 'Owner', username: 'owner', password: 'payroll-test-password' },
  });
  const login = async (username: string) =>
    (
      await call<LoginResponse>('POST', '/auth/login', 200, undefined, {
        workspace: 'verify-restaurant', username,
        password: 'payroll-test-password',
      })
    ).token;
  const owner = await login('owner');
  const tokens: Record<string, string> = {},
    ids: Record<string, string> = {};
  for (const role of ['MANAGER', 'CASHIER', 'WAITER', 'KITCHEN'] as const) {
    ids[role] = (
      await prisma.staff.create({
        data: {
          restaurantId,
          name: role,
          username: role.toLowerCase(),
          role,
          passwordHash: await hashPassword('payroll-test-password'),
        },
      })
    ).id;
    tokens[role] = await login(role.toLowerCase());
  }
  const employeeId = ids['WAITER']!;
  const initial = await call<PayrollOverview>('GET', '/payroll', 200, owner);
  const { month, currentBusinessDate: today } = initial;
  assert.equal(initial.records.length, 0);
  assert(initial.staff.every((row) => row.monthlySalaryPaisa === null));
  const profile = { monthlySalaryPaisa: 3000000, expectedVersion: null };
  await call('GET', '/payroll', 401);
  for (const role of ['MANAGER', 'CASHIER', 'WAITER', 'KITCHEN']) {
    await call('GET', '/payroll', 403, tokens[role]);
    await call(
      'POST',
      `/payroll/profiles/${employeeId}`,
      403,
      tokens[role],
      profile,
      `payroll-denied-profile-${role}`,
    );
  }
  await call('GET', '/payroll?month=2026-13', 400, owner);
  await call('POST', `/payroll/profiles/${employeeId}`, 400, owner, profile);
  await call(
    'POST',
    `/payroll/profiles/${employeeId}`,
    400,
    owner,
    { ...profile, monthlySalaryPaisa: -1 },
    'payroll-negative-profile',
  );
  await call(
    'POST',
    `/payroll/profiles/${employeeId}`,
    200,
    owner,
    profile,
    'payroll-profile-create-001',
  );
  await call(
    'POST',
    `/payroll/profiles/${employeeId}`,
    200,
    owner,
    profile,
    'payroll-profile-create-001',
  );
  await call(
    'POST',
    `/payroll/profiles/${employeeId}`,
    409,
    owner,
    profile,
    'payroll-profile-duplicate',
  );
  const create = { staffId: employeeId, month, expectedProfileVersion: 0 };
  await call(
    'POST',
    '/payroll/records',
    409,
    owner,
    { ...create, expectedProfileVersion: 9 },
    'payroll-profile-stale-001',
  );
  let record = await call<PayrollRecordDto>(
    'POST',
    '/payroll/records',
    201,
    owner,
    create,
    'payroll-draft-create-0001',
  );
  assert.equal(record.status, 'DRAFT');
  assert.equal(record.netSalaryPaisa, 3000000);
  assert.equal(record.audits[0]!.kind, 'CREATE');
  assert.equal(
    (
      await call<PayrollRecordDto>(
        'POST',
        '/payroll/records',
        201,
        owner,
        create,
        'payroll-draft-create-0001',
      )
    ).id,
    record.id,
  );
  await call('POST', '/payroll/records', 409, owner, create, 'payroll-draft-duplicate');
  for (const role of ['MANAGER', 'CASHIER', 'WAITER', 'KITCHEN'])
    await call('GET', `/payroll/records/${record.id}`, 403, tokens[role]);
  const path = `/payroll/records/${record.id}`;
  const advance = {
    expectedVersion: record.version,
    kind: 'ADVANCE',
    amountPaisa: 500000,
    method: 'CASH',
    drawer: 'NEW',
    businessDate: today,
    note: 'Mid-month salary advance',
  };
  await call('POST', `${path}/payments`, 409, owner, advance, 'payroll-no-drawer-0001');
  assert.equal(await prisma.expense.count(), 0);
  assert.equal(await prisma.payrollPayment.count(), 0);
  assert.equal((await call<PayrollRecordDto>('GET', path, 200, owner)).version, record.version);
  await call(
    'POST',
    `${path}/payments`,
    400,
    owner,
    { ...advance, method: 'QR' },
    'payroll-qr-drawer-0001',
  );
  await call(
    'POST',
    `${path}/payments`,
    409,
    owner,
    { ...advance, amountPaisa: 3000001 },
    'payroll-over-advance-001',
  );
  await call(
    'POST',
    `${path}/payments`,
    409,
    owner,
    { ...advance, kind: 'SALARY' },
    'payroll-unapproved-0001',
  );
  await call(
    'POST',
    `${path}/payments`,
    409,
    owner,
    { ...advance, businessDate: '2000-01-01' },
    'payroll-old-drawer-0001',
  );
  const opened = (
    await call<{ shift: ShiftDto }>('POST', '/shifts', 201, owner, { openingFloatPaisa: 1000000 })
  ).shift;
  record = await call<PayrollRecordDto>(
    'POST',
    `${path}/payments`,
    201,
    owner,
    advance,
    'payroll-advance-0000001',
  );
  await call('POST', `${path}/payments`, 201, owner, advance, 'payroll-advance-0000001');
  assert.equal(await prisma.payrollPayment.count(), 1);
  assert.equal(await prisma.expense.count(), 1);
  assert.equal(await prisma.cashMovement.count(), 1);
  assert.equal(record.advancePaisa, 500000);
  assert.equal(record.remainingPaisa, 2500000);
  assert.equal(
    (await call<CurrentShiftResponse>('GET', '/shifts/current', 200, owner)).shift!
      .expectedCashPaisa,
    500000,
  );
  await call(
    'POST',
    '/expenses',
    409,
    owner,
    {
      amountPaisa: 500000,
      method: 'CASH',
      category: 'Payroll',
      note: 'Attempt to duplicate payroll expense',
      businessDate: today,
      drawer: 'LINK',
      cashMovementId: record.payments[0]!.cashMovementId,
    },
    'payroll-duplicate-expense-1',
  );
  const edit = {
    expectedVersion: record.version,
    baseSalaryPaisa: 3000000,
    allowancesPaisa: 200000,
    deductionsPaisa: 100000,
    note: 'Overtime and an agreed deduction',
  };
  await call(
    'POST',
    `${path}/edit`,
    409,
    owner,
    { ...edit, baseSalaryPaisa: 100000, allowancesPaisa: 0, deductionsPaisa: 0 },
    'payroll-below-paid-0001',
  );
  await call(
    'POST',
    `${path}/edit`,
    400,
    owner,
    { ...edit, deductionsPaisa: 4000000 },
    'payroll-bad-deduction-1',
  );
  await call(
    'POST',
    `${path}/edit`,
    409,
    owner,
    { ...edit, expectedVersion: 999 },
    'payroll-stale-edit-0001',
  );
  record = await call<PayrollRecordDto>(
    'POST',
    `${path}/edit`,
    200,
    owner,
    edit,
    'payroll-edit-000000001',
  );
  assert.equal(record.netSalaryPaisa, 3100000);
  assert.equal(record.remainingPaisa, 2600000);
  assert.equal(await prisma.expense.count(), 1);
  record = await call<PayrollRecordDto>(
    'POST',
    `${path}/approve`,
    200,
    owner,
    { expectedVersion: record.version, note: 'Monthly amounts reviewed' },
    'payroll-approve-0000001',
  );
  assert.equal(record.status, 'APPROVED');
  assert.equal(record.approvedBy, 'Owner');
  await call(
    'POST',
    `${path}/edit`,
    409,
    owner,
    { ...edit, expectedVersion: record.version },
    'payroll-edit-approved-1',
  );
  await call(
    'POST',
    `${path}/payments`,
    409,
    owner,
    { ...advance, expectedVersion: record.version, drawer: 'EXTERNAL' },
    'payroll-late-advance-01',
  );
  record = await call<PayrollRecordDto>(
    'POST',
    `${path}/reopen`,
    200,
    owner,
    { expectedVersion: record.version, note: 'Review salary before final payment' },
    'payroll-reopen-0000001',
  );
  assert.equal(record.status, 'DRAFT');
  assert.equal(record.paidPaisa, 500000);
  assert(record.audits.some((row) => row.kind === 'REOPEN'));
  record = await call<PayrollRecordDto>(
    'POST',
    `${path}/approve`,
    200,
    owner,
    { expectedVersion: record.version, note: 'Review complete, amounts unchanged' },
    'payroll-approve-0000002',
  );
  record = await call<PayrollRecordDto>(
    'POST',
    `${path}/payments`,
    201,
    owner,
    {
      ...advance,
      expectedVersion: record.version,
      kind: 'SALARY',
      amountPaisa: 1000000,
      method: 'QR',
      drawer: 'EXTERNAL',
      reference: 'SALARY-QR',
      note: 'First salary installment',
      paidByStaffId: ids['MANAGER'],
    },
    'payroll-salary-qr-00001',
  );
  assert.equal(record.payments[1]!.paidBy, 'Owner');
  assert.equal(record.remainingPaisa, 1600000);
  await call(
    'POST',
    `${path}/reopen`,
    409,
    owner,
    { expectedVersion: record.version, note: 'Not allowed after salary payment' },
    'payroll-reopen-paid-001',
  );
  await call(
    'POST',
    `${path}/payments`,
    409,
    owner,
    {
      ...advance,
      expectedVersion: record.version,
      kind: 'SALARY',
      amountPaisa: 1600001,
      drawer: 'EXTERNAL',
    },
    'payroll-over-salary-001',
  );
  const final = {
    ...advance,
    expectedVersion: record.version,
    kind: 'SALARY',
    amountPaisa: 1600000,
    method: 'CARD',
    drawer: 'EXTERNAL',
    note: 'Final salary installment',
  };
  const raced = await Promise.all(
    ['payroll-final-race-0001', 'payroll-final-race-0002'].map(async (key) => {
      const response = await fetch(`${handle!.baseUrl}${path}/payments`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${owner}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          Connection: 'close',
        },
        body: JSON.stringify(final),
      });
      return response.status;
    }),
  );
  assert.deepEqual(raced.sort(), [201, 409]);
  record = await call<PayrollRecordDto>('GET', path, 200, owner);
  assert.equal(record.settled, true);
  assert.equal(record.remainingPaisa, 0);
  assert.equal(record.paidPaisa, 3100000);
  assert.equal(record.payments.length, 3);
  assert.equal(await prisma.expense.count(), 3);
  assert.equal(await prisma.cashMovement.count(), 1);
  const expenses = await call<ExpenseSummaryDto>(
    'GET',
    `/expenses?from=${today}&to=${today}`,
    200,
    owner,
  );
  assert.equal(expenses.totalPaisa, 3100000);
  assert(expenses.expenses.every((row) => row.category === 'Payroll'));
  const closed = (
    await call<{ shift: ShiftDto }>('POST', `/shifts/${opened.id}/close`, 200, owner, {
      countedCashPaisa: 500000,
    })
  ).shift;
  assert.equal(closed.expectedCashPaisa, 500000);
  assert.equal(closed.close!.variancePaisa, 0);
  const current = await call<PayrollOverview>('GET', `/payroll?month=${month}`, 200, owner);
  assert.deepEqual(current.totals, {
    approvedNetPaisa: 3100000,
    paidPaisa: 3100000,
    advancesPaisa: 500000,
    approvedRemainingPaisa: 0,
  });
  await call(
    'POST',
    `/payroll/profiles/${employeeId}`,
    200,
    owner,
    { monthlySalaryPaisa: 5000000, expectedVersion: 0 },
    'payroll-new-base-00001',
  );
  await prisma.staff.update({
    where: { id: employeeId },
    data: { name: 'Renamed former waiter', isActive: false },
  });
  assert.equal((await call<PayrollRecordDto>('GET', path, 200, owner)).staffName, 'WAITER');
  assert.equal((await call<PayrollRecordDto>('GET', path, 200, owner)).baseSalaryPaisa, 3000000);
  const [year, mo] = month.split('-').map(Number);
  const nextMonth = new Date(Date.UTC(year!, mo!, 1)).toISOString().slice(0, 7);
  let next = await call<PayrollRecordDto>(
    'POST',
    '/payroll/records',
    201,
    owner,
    { staffId: employeeId, month: nextMonth, expectedProfileVersion: 1 },
    'payroll-next-month-0001',
  );
  assert.equal(next.baseSalaryPaisa, 5000000);
  assert.equal(next.staffName, 'Renamed former waiter');
  const nextPay = { ...advance, expectedVersion: next.version, drawer: 'NEW' };
  await call(
    'POST',
    `/payroll/records/${next.id}/payments`,
    409,
    owner,
    nextPay,
    'payroll-closed-drawer-1',
  );
  next = await call<PayrollRecordDto>(
    'POST',
    `/payroll/records/${next.id}/payments`,
    201,
    owner,
    { ...nextPay, drawer: 'EXTERNAL' },
    'payroll-external-cash-1',
  );
  assert.equal(next.paidPaisa, 500000);
  assert.equal(await prisma.cashMovement.count(), 1);
  assert.equal(
    (await prisma.shift.findUniqueOrThrow({ where: { id: opened.id } })).expectedCashPaisa,
    500000,
  );
  await call(
    'POST',
    `/payroll/profiles/${ids['KITCHEN']}`,
    200,
    owner,
    { monthlySalaryPaisa: 0, expectedVersion: null },
    'payroll-zero-profile-1',
  );
  let zero = await call<PayrollRecordDto>(
    'POST',
    '/payroll/records',
    201,
    owner,
    { staffId: ids['KITCHEN'], month, expectedProfileVersion: 0 },
    'payroll-zero-draft-001',
  );
  zero = await call<PayrollRecordDto>(
    'POST',
    `/payroll/records/${zero.id}/approve`,
    200,
    owner,
    { expectedVersion: zero.version, note: 'No salary due for this period' },
    'payroll-zero-approve-1',
  );
  assert.equal(zero.settled, true);
  assert.equal(zero.payments.length, 0);
  await call(
    'POST',
    `/payroll/records/${zero.id}/payments`,
    409,
    owner,
    {
      ...advance,
      expectedVersion: zero.version,
      kind: 'SALARY',
      amountPaisa: 1,
      drawer: 'EXTERNAL',
    },
    'payroll-zero-payment-1',
  );
  const other = await prisma.restaurant.create({
    data: { name: 'Other', address: '', phone: '', panNumber: '' },
  });
  const foreign = await prisma.staff.create({
    data: {
      restaurantId: other.id,
      name: 'Other staff',
      username: 'other',
      role: 'OWNER',
      passwordHash: 'unused',
    },
  });
  const otherRecord = await prisma.payrollRecord.create({
    data: {
      restaurantId: other.id,
      staffId: foreign.id,
      staffNameSnapshot: 'Other staff',
      month,
      baseSalaryPaisa: 999999,
      createdByStaffId: foreign.id,
      updatedByStaffId: foreign.id,
    },
  });
  await call('GET', `/payroll/records/${otherRecord.id}`, 404, owner);
  await call(
    'POST',
    `/payroll/profiles/${foreign.id}`,
    404,
    owner,
    profile,
    'payroll-foreign-profile',
  );
  await call(
    'POST',
    `/payroll/records/${otherRecord.id}/payments`,
    404,
    owner,
    { ...advance, expectedVersion: 0 },
    'payroll-foreign-payment',
  );
  const safeStaff = await call<{ staff: readonly unknown[] }>(
    'GET',
    '/management/staff',
    200,
    tokens['MANAGER'],
  );
  assert(!JSON.stringify(safeStaff).includes('monthlySalaryPaisa'));
  await call(
    'PATCH',
    `/payroll/records/${record.id}/payments/${record.payments[0]!.id}`,
    404,
    owner,
    {},
  );
  await call('DELETE', `/payroll/records/${record.id}`, 404, owner);
  const preserved = await call<PayrollRecordDto>('GET', path, 200, owner);
  await stopNayaroServer(handle);
  handle = await start();
  assert.deepEqual(await call<PayrollRecordDto>('GET', path, 200, owner), preserved);
  assert.equal(await handle.prisma.expense.count({ where: { restaurantId } }), 4);
  assert.equal(await handle.prisma.cashMovement.count({ where: { restaurantId } }), 1);
  assert.equal(
    (await handle.prisma.staff.findUniqueOrThrow({ where: { id: ownerStaffId } })).role,
    'OWNER',
  );
  if (process.argv.includes('--ui')) {
    const require = createRequire(import.meta.url);
    const executable = require('electron') as string;
    const script = fileURLToPath(
      new URL('../../../apps/desktop/scripts/verifyPayroll.cjs', import.meta.url),
    );
    const env = { ...process.env };
    delete env['ELECTRON_RUN_AS_NODE'];
    await new Promise<void>((resolve, reject) => {
      const browser = spawn(executable, [script, handle!.baseUrl, root, ids['CASHIER']!, month], {
        env,
        stdio: 'inherit',
      });
      const timer = setTimeout(() => {
        browser.kill();
        reject(new Error('Payroll browser check timed out.'));
      }, 55_000);
      browser.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      browser.on('exit', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Payroll browser exited with ${code}`));
      });
    });
    const nativeRecord = (
      await call<PayrollOverview>('GET', `/payroll?month=${month}`, 200, owner)
    ).records.find((row) => row.staffId === ids['CASHIER'])!;
    assert.equal(nativeRecord.settled, true);
    assert.equal(nativeRecord.netSalaryPaisa, 205000);
    assert.equal(nativeRecord.advancePaisa, 50000);
    assert.equal(nativeRecord.paidPaisa, 205000);
    assert.equal(nativeRecord.payments.length, 2);
    assert.equal(await handle.prisma.cashMovement.count({ where: { restaurantId } }), 1);
    assert.equal(
      (
        await handle.prisma.expense.aggregate({
          where: { restaurantId },
          _sum: { amountPaisa: true },
        })
      )._sum.amountPaisa,
      3805000,
    );
  }
  console.log(
    `PASS: payroll (${checks} HTTP checks), owner/tenant isolation, salary snapshots, draft edits, advances, approval/reopen, payment races/retries, linked expenses, drawer safety, zero balances and restart recovery.`,
  );
} finally {
  if (handle) await stopNayaroServer(handle);
  rmSync(root, { recursive: true, force: true });
}
