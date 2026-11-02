/** Tenant reset isolation, backup and rollback checks on a disposable database. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { applyPendingMigrations, createPrismaClient } from '@nayaro/database';
import { registerTenant } from '../src/modules/tenant/tenant.service';
import { resetTenantData } from './reset-tenant-data';

const root = mkdtempSync(join(tmpdir(), 'nayaro-tenant-reset-'));
const databaseFilePath = join(root, 'test.db');
await applyPendingMigrations({ databaseFilePath });
const prisma = createPrismaClient({ databaseFilePath });
const backupPath = join(root, 'backup.db');
const businessDate = '2026-11-02';

async function fixture(slug: string) {
  const { restaurantId, ownerStaffId: staffId } = await registerTenant(prisma, {
    restaurant: { slug, name: slug },
    owner: { name: 'Owner', username: 'owner', password: 'Reset-test-password' },
  });
  const area = await prisma.restaurantArea.create({ data: { restaurantId, name: 'Main' } });
  const table = await prisma.restaurantTable.create({
    data: { restaurantId, areaId: area.id, name: 'T1' },
  });
  const category = await prisma.menuCategory.create({ data: { restaurantId, name: 'Food' } });
  const item = await prisma.menuItem.create({
    data: { restaurantId, categoryId: category.id, name: 'Momo', pricePaisa: 10000 },
  });
  const ingredient = await prisma.ingredient.create({
    data: { restaurantId, name: 'Flour', unit: 'g', onHandMilli: 1000 },
  });
  await prisma.recipeIngredient.create({
    data: { menuItemId: item.id, ingredientId: ingredient.id, quantityMilli: 100 },
  });
  const customer = await prisma.customer.create({ data: { restaurantId, name: 'Customer' } });
  const order = await prisma.order.create({
    data: {
      restaurantId,
      orderNumber: 1,
      type: 'DINE_IN',
      tableId: table.id,
      openedByStaffId: staffId,
      businessDate,
      loyaltyCustomerId: customer.id,
    },
  });
  const line = await prisma.orderItem.create({
    data: {
      orderId: order.id,
      menuItemId: item.id,
      nameSnapshot: item.name,
      unitPricePaisa: 10000,
      quantity: 1,
    },
  });
  await prisma.orderItemCancellation.create({
    data: { orderItemId: line.id, quantity: 1, reason: 'Test', cancelledByStaffId: staffId },
  });
  const kot = await prisma.kot.create({
    data: { restaurantId, orderId: order.id, kotNumber: 1, createdByStaffId: staffId },
  });
  await prisma.kotItem.create({ data: { kotId: kot.id, orderItemId: line.id, quantity: 1 } });
  const invoice = await prisma.invoice.create({
    data: {
      restaurantId,
      orderId: order.id,
      invoiceNumber: 1,
      fiscalYearStartBsYear: 2083,
      issuedByStaffId: staffId,
      businessDate,
      subtotalPaisa: 10000,
      grandTotalPaisa: 10000,
    },
  });
  const invoiceLine = await prisma.invoiceLine.create({
    data: {
      invoiceId: invoice.id,
      orderItemId: line.id,
      lineNumber: 1,
      description: item.name,
      quantity: 1,
      unitPricePaisa: 10000,
      lineTotalPaisa: 10000,
    },
  });
  await prisma.invoicePrint.create({
    data: { invoiceId: invoice.id, copySequence: 1, printedByStaffId: staffId },
  });
  const payment = await prisma.payment.create({
    data: {
      restaurantId,
      orderId: order.id,
      invoiceId: invoice.id,
      method: 'CREDIT',
      amountPaisa: 10000,
      customerId: customer.id,
      receivedByStaffId: staffId,
    },
  });
  await prisma.paymentItemAllocation.create({
    data: { paymentId: payment.id, invoiceLineId: invoiceLine.id, quantity: 1, amountPaisa: 10000 },
  });
  const shift = await prisma.shift.create({
    data: { restaurantId, businessDate, openedByStaffId: staffId, openingFloatPaisa: 0 },
  });
  const cash = await prisma.cashMovement.create({
    data: {
      restaurantId,
      shiftId: shift.id,
      type: 'PAY_OUT',
      amountPaisa: 100,
      reason: 'Test',
      staffId,
    },
  });
  await prisma.paymentRefund.create({
    data: {
      restaurantId,
      paymentId: payment.id,
      customerId: customer.id,
      amountPaisa: 100,
      method: 'CASH',
      reason: 'Test',
      businessDate,
      staffId,
      cashMovementId: cash.id,
    },
  });
  await prisma.creditRepayment.create({
    data: {
      restaurantId,
      customerId: customer.id,
      amountPaisa: 100,
      method: 'CASH',
      businessDate,
      receivedByStaffId: staffId,
    },
  });
  await prisma.loyaltyEntry.create({
    data: {
      restaurantId,
      customerId: customer.id,
      invoiceId: invoice.id,
      staffId,
      key: slug,
      kind: 'EARN',
      deltaPoints: 1,
    },
  });
  const expense = await prisma.expense.create({
    data: {
      restaurantId,
      staffId,
      amountPaisa: 100,
      method: 'CASH',
      category: 'PAYROLL',
      note: 'Test',
      businessDate,
    },
  });
  await prisma.stockMovement.create({
    data: {
      restaurantId,
      ingredientId: ingredient.id,
      staffId,
      kind: 'PURCHASE',
      deltaMilli: 1000,
      balanceAfterMilli: 1000,
      reason: 'Test',
      businessDate,
      expenseId: expense.id,
      kotId: kot.id,
    },
  });
  await prisma.payrollProfile.create({
    data: { restaurantId, staffId, monthlySalaryPaisa: 100, updatedByStaffId: staffId },
  });
  const payroll = await prisma.payrollRecord.create({
    data: {
      restaurantId,
      staffId,
      staffNameSnapshot: 'Owner',
      month: '2026-11',
      baseSalaryPaisa: 100,
      createdByStaffId: staffId,
      updatedByStaffId: staffId,
    },
  });
  await prisma.payrollPayment.create({
    data: {
      restaurantId,
      payrollRecordId: payroll.id,
      paidByStaffId: staffId,
      kind: 'SALARY',
      amountPaisa: 100,
      method: 'CASH',
      note: 'Test',
      businessDate,
      expenseId: expense.id,
    },
  });
  await prisma.payrollAudit.create({
    data: {
      restaurantId,
      payrollRecordId: payroll.id,
      staffId,
      kind: 'CREATE',
      afterJson: '{}',
      note: 'Test',
    },
  });
  await prisma.requestReceipt.create({
    data: { restaurantId, staffId, key: 'test', requestHash: 'test', responseJson: '{}' },
  });
  await prisma.session.create({
    data: { restaurantId, staffId, tokenHash: slug, expiresAt: new Date('2027-01-01') },
  });
  await prisma.auditLog.create({
    data: { restaurantId, staffId, action: 'TEST', summary: 'Preserve this log' },
  });
  await prisma.restaurantCounter.updateMany({ where: { restaurantId }, data: { nextValue: 2 } });
  return restaurantId;
}

// Snapshot every application table to catch accidental changes outside the target.
async function snapshot(client = prisma) {
  const tables = await client.$queryRaw<
    { name: string }[]
  >`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_prisma_%' ORDER BY name`;
  const result: Record<string, Record<string, unknown>[]> = {};
  for (const { name } of tables) {
    result[name] = await client.$queryRawUnsafe(`SELECT * FROM "${name}" ORDER BY rowid`);
  }
  return result;
}

try {
  const target = await fixture('reset-me');
  await fixture('keep-me');
  const before = await snapshot();
  const targetIds = new Set(
    Object.values(before)
      .flat()
      .filter((row) => row['restaurantId'] === target)
      .map((row) => row['id'])
      .filter((id): id is string => typeof id === 'string'),
  );
  // Order children do not have restaurantId; identify them from their parents.
  for (const row of before['OrderItem']!) {
    if (targetIds.has(String(row['orderId']))) targetIds.add(String(row['id']));
  }

  // The real npm entrypoint must forward flags and default to a read-only preview.
  const cli = fileURLToPath(new URL('../../../package.json', import.meta.url));
  const preview = spawnSync('npm', ['run', 'tenant', '--', 'reset-data', 'reset-me'], {
    cwd: join(cli, '..'),
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: databaseFilePath },
  });
  assert.equal(preview.status, 0, preview.stdout + preview.stderr);
  assert.match(preview.stdout, /Preview only/);
  assert.deepEqual(await snapshot(), before);

  await assert.rejects(resetTenantData(prisma, 'missing', join(root, 'missing.db')));
  await assert.rejects(resetTenantData(prisma, 'reset-me', join(root, 'missing-dir', 'backup.db')));
  assert.deepEqual(await snapshot(), before, 'backup failure must leave all data untouched');

  // Force a late failure to prove every earlier deletion rolls back.
  await prisma.$executeRawUnsafe(
    `CREATE TRIGGER fail_reset BEFORE INSERT ON AuditLog WHEN NEW.action = 'TENANT_DATA_RESET' BEGIN SELECT RAISE(ABORT, 'test rollback'); END`,
  );
  await assert.rejects(resetTenantData(prisma, 'reset-me', join(root, 'rollback.db')));
  assert.deepEqual(await snapshot(), before, 'late reset failure must roll back all data');
  await prisma.$executeRawUnsafe('DROP TRIGGER fail_reset');

  const executed = spawnSync(
    'npm',
    ['run', 'tenant', '--', 'reset-data', 'reset-me', '--execute'],
    {
      cwd: join(cli, '..'),
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: databaseFilePath },
    },
  );
  assert.equal(executed.status, 0, executed.stdout + executed.stderr);
  assert.match(executed.stdout, /Reset complete/);
  const createdBackup = executed.stdout.match(/Backup: (.+)/)?.[1];
  assert.ok(createdBackup);
  const backup = createPrismaClient({ databaseFilePath: createdBackup });
  try {
    assert.deepEqual(await snapshot(backup), before, 'backup includes the full original data');
  } finally {
    await backup.$disconnect();
    rmSync(createdBackup);
  }

  const after = await snapshot();
  const kept = new Set([
    'Restaurant',
    'Staff',
    'RestaurantSettings',
    'RestaurantArea',
    'RestaurantTable',
    'MenuCategory',
    'MenuItem',
    'RecipeIngredient',
    'PayrollProfile',
    'Offer',
    'MenuAvailabilityChange',
    'RecipeChange',
  ]);
  for (const [name, rows] of Object.entries(after)) {
    if (kept.has(name)) {
      assert.deepEqual(rows, before[name], `${name} configuration preserved`);
    } else if (!['Ingredient', 'RestaurantCounter', 'AuditLog'].includes(name)) {
      assert.deepEqual(
        rows,
        before[name]!.filter(
          (row) =>
            row['restaurantId'] !== target &&
            !Object.entries(row).some(
              ([key, value]) => key.endsWith('Id') && targetIds.has(String(value)),
            ),
        ),
        `${name}: only the other tenant's history remains`,
      );
    } else {
      assert.deepEqual(
        rows.filter((row) => row['restaurantId'] !== target),
        before[name]!.filter((row) => row['restaurantId'] !== target),
        `${name}: other tenant unchanged`,
      );
    }
  }
  assert.equal(
    await prisma.ingredient.count({ where: { restaurantId: target, onHandMilli: 0 } }),
    1,
  );
  assert.equal(
    await prisma.restaurantCounter.count({ where: { restaurantId: target, nextValue: 1 } }),
    2,
  );
  assert.equal(await prisma.auditLog.count({ where: { restaurantId: target } }), 2);
  assert.deepEqual(await prisma.$queryRaw`PRAGMA foreign_key_check`, []);
  await resetTenantData(prisma, 'reset-me', backupPath);
  assert.equal(
    await prisma.order.count({ where: { restaurantId: target } }),
    0,
    'repeat reset succeeds',
  );
  console.log(
    'PASS tenant reset: preview, backup, rollback, preserved configuration and isolation.',
  );
} finally {
  await prisma.$disconnect();
  rmSync(root, { recursive: true, force: true });
}
