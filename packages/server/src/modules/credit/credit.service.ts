import { z } from 'zod';
import type { NayaroPrismaClient } from '@nayaro/database';
import type {
  CreditCollectionsDto,
  CreditEntryDto,
  CustomerDto,
  CustomerListResponse,
  CustomerStatementResponse,
  UnassignedCreditResponse,
} from '@nayaro/shared';
import { ApiError } from '../../utils/apiError';
import { resolveBusinessDate } from '../../utils/businessDate';
import { correctionReason } from '../../utils/correction';
import { formatNepaliFiscalYear } from '../../utils/nepaliCalendar';
import {
  withRequestReceipt,
  type IdempotencyAttempt,
  type Transaction,
} from '../../utils/idempotency';

type Client = Pick<
  NayaroPrismaClient,
  'customer' | 'payment' | 'creditRepayment' | 'restaurantSettings' | 'paymentRefund'
>;
const version = z.int().min(0);
const contact = {
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(40).optional(),
  address: z.string().trim().max(240).optional(),
};
const createSchema = z.object(contact);
const editSchema = z.object({ ...contact, isActive: z.boolean(), expectedVersion: version });
const repaySchema = z.object({
  expectedVersion: version,
  amountPaisa: z.int().min(1).max(1_000_000_000),
  method: z.enum(['CASH', 'QR', 'CARD']),
  reference: z.string().trim().max(80).optional(),
  note: z.string().trim().max(300).optional(),
});
const reverseSchema = z.object({ expectedVersion: version, reason: correctionReason });
const assignSchema = z.object({ customerId: z.string().min(1), expectedVersion: version });
const listSchema = z.object({ search: z.string().trim().max(120).optional() });
const staffSelect = { select: { id: true, name: true } } as const;

export async function customerOrThrow(client: Client, restaurantId: string, id: string) {
  const customer = await client.customer.findFirst({ where: { id, restaurantId } });
  if (!customer)
    throw new ApiError(404, 'CUSTOMER_NOT_FOUND', 'That customer account does not exist.');
  return customer;
}

/** Every balance-changing write claims this version, including sales and their corrections. */
export async function claimCustomer(
  tx: Transaction,
  restaurantId: string,
  id: string,
  expectedVersion?: number,
  activeOnly = false,
) {
  const customer = await customerOrThrow(tx, restaurantId, id);
  if (activeOnly && !customer.isActive)
    throw new ApiError(
      409,
      'CUSTOMER_INACTIVE',
      'This account is inactive. Choose an active account for a new credit sale.',
    );
  const changed = await tx.customer.updateMany({
    where: { id, restaurantId, version: expectedVersion ?? customer.version },
    data: { version: { increment: 1 } },
  });
  if (changed.count !== 1)
    throw new ApiError(
      409,
      'CUSTOMER_CHANGED',
      'This account changed on another terminal. Check the refreshed balance and try again.',
    );
  return customer;
}

export async function creditBalance(
  client: Client,
  restaurantId: string,
  customerId: string,
): Promise<number> {
  const [charges, repayments, refunds] = await Promise.all([
    client.payment.aggregate({
      where: { restaurantId, customerId, method: 'CREDIT', voidedAt: null },
      _sum: { amountPaisa: true },
    }),
    client.creditRepayment.aggregate({
      where: { restaurantId, customerId, reversedAt: null },
      _sum: { amountPaisa: true },
    }),
    client.paymentRefund.aggregate({
      where: { restaurantId, customerId, method: 'CREDIT' },
      _sum: { amountPaisa: true },
    }),
  ]);
  return (
    (charges._sum.amountPaisa ?? 0) -
    (repayments._sum.amountPaisa ?? 0) -
    (refunds._sum.amountPaisa ?? 0)
  );
}

export async function listCustomers(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  rawQuery: unknown,
): Promise<CustomerListResponse> {
  const { search } = listSchema.parse(rawQuery);
  return prisma.$transaction(async (tx) => {
    const customers = await tx.customer.findMany({
      where: {
        restaurantId,
        ...(search
          ? { OR: [{ name: { contains: search } }, { phone: { contains: search } }] }
          : {}),
      },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    const [credits, repayments, refunds] = await Promise.all([
      tx.payment.groupBy({
        by: ['customerId'],
        where: { restaurantId, method: 'CREDIT', voidedAt: null, customerId: { not: null } },
        _sum: { amountPaisa: true },
      }),
      tx.creditRepayment.groupBy({
        by: ['customerId'],
        where: { restaurantId, reversedAt: null },
        _sum: { amountPaisa: true },
      }),
      tx.paymentRefund.groupBy({
        by: ['customerId'],
        where: { restaurantId, method: 'CREDIT', customerId: { not: null } },
        _sum: { amountPaisa: true },
      }),
    ]);
    const charges = new Map(credits.map((row) => [row.customerId, row._sum.amountPaisa ?? 0]));
    for (const row of refunds)
      charges.set(row.customerId, (charges.get(row.customerId) ?? 0) - (row._sum.amountPaisa ?? 0));
    const paid = new Map(repayments.map((row) => [row.customerId, row._sum.amountPaisa ?? 0]));
    return {
      customers: customers.map((row): CustomerDto => ({
        id: row.id,
        name: row.name,
        phone: row.phone,
        address: row.address,
        isActive: row.isActive,
        version: row.version,
        creditPaisa: charges.get(row.id) ?? 0,
        repaidPaisa: paid.get(row.id) ?? 0,
        balancePaisa: (charges.get(row.id) ?? 0) - (paid.get(row.id) ?? 0),
      })),
    };
  });
}

export async function statement(
  client: Client,
  restaurantId: string,
  customerId: string,
): Promise<CustomerStatementResponse> {
  const customer = await customerOrThrow(client, restaurantId, customerId);
  const [credits, repayments] = await Promise.all([
    client.payment.findMany({
      where: { restaurantId, customerId, method: 'CREDIT' },
      include: {
        invoice: { select: { invoiceNumber: true, fiscalYearStartBsYear: true } },
        receivedByStaff: staffSelect,
        voidedByStaff: staffSelect,
        refunds: { include: { staff: staffSelect } },
      },
    }),
    client.creditRepayment.findMany({
      where: { restaurantId, customerId },
      include: { receivedByStaff: staffSelect, reversedByStaff: staffSelect },
    }),
  ]);
  const entries: Omit<CreditEntryDto, 'balancePaisa'>[] = [];
  for (const row of credits) {
    const description = `Invoice #${row.invoice.invoiceNumber} · ${formatNepaliFiscalYear(row.invoice.fiscalYearStartBsYear)}`;
    entries.push({
      id: `credit:${row.id}`,
      kind: 'CREDIT',
      at: row.createdAt.toISOString(),
      description,
      method: 'CREDIT',
      amountPaisa: row.amountPaisa,
      staff: row.receivedByStaff,
      orderId: row.orderId,
      repaymentId: null,
      canReverse: false,
    });
    for (const refund of row.refunds)
      entries.push({
        id: `credit-refund:${refund.id}`,
        kind: 'CREDIT_REFUND',
        at: refund.createdAt.toISOString(),
        description: `${description} refunded: ${refund.reason}`,
        method: 'CREDIT',
        amountPaisa: -refund.amountPaisa,
        staff: refund.staff,
        orderId: row.orderId,
        repaymentId: null,
        canReverse: false,
      });
    if (row.voidedAt && row.voidedByStaff)
      entries.push({
        id: `credit-void:${row.id}`,
        kind: 'CREDIT_VOID',
        at: row.voidedAt.toISOString(),
        description: `${description} reversed: ${row.voidReason ?? ''}`,
        method: 'CREDIT',
        amountPaisa: -row.amountPaisa,
        staff: row.voidedByStaff,
        orderId: row.orderId,
        repaymentId: null,
        canReverse: false,
      });
  }
  for (const row of repayments) {
    entries.push({
      id: `repayment:${row.id}`,
      kind: 'REPAYMENT',
      at: row.createdAt.toISOString(),
      description: [row.reference, row.note].filter(Boolean).join(' · ') || 'Credit repayment',
      method: row.method,
      amountPaisa: -row.amountPaisa,
      staff: row.receivedByStaff,
      orderId: null,
      repaymentId: row.id,
      canReverse: row.reversedAt === null,
    });
    if (row.reversedAt && row.reversedByStaff)
      entries.push({
        id: `reversal:${row.id}`,
        kind: 'REVERSAL',
        at: row.reversedAt.toISOString(),
        description: `Repayment reversed: ${row.reversalReason ?? ''}`,
        method: row.method,
        amountPaisa: row.amountPaisa,
        staff: row.reversedByStaff,
        orderId: null,
        repaymentId: row.id,
        canReverse: false,
      });
  }
  // At identical timestamps, the original precedes its reversal. Stable id breaks remaining ties.
  const rank = { CREDIT: 0, REPAYMENT: 1, CREDIT_VOID: 2, REVERSAL: 3, CREDIT_REFUND: 4 } as const;
  entries.sort(
    (a, b) => a.at.localeCompare(b.at) || rank[a.kind] - rank[b.kind] || a.id.localeCompare(b.id),
  );
  let balancePaisa = 0;
  const result = entries.map((entry) => ({
    ...entry,
    balancePaisa: (balancePaisa += entry.amountPaisa),
  }));
  const creditPaisa = credits
    .filter((row) => row.voidedAt === null)
    .reduce(
      (sum, row) =>
        sum +
        row.amountPaisa -
        row.refunds.reduce((total, refund) => total + refund.amountPaisa, 0),
      0,
    );
  const repaidPaisa = repayments
    .filter((row) => row.reversedAt === null)
    .reduce((sum, row) => sum + row.amountPaisa, 0);
  return {
    customer: {
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      address: customer.address,
      isActive: customer.isActive,
      version: customer.version,
      creditPaisa,
      repaidPaisa,
      balancePaisa,
    },
    entries: result,
  };
}

export function getStatement(prisma: NayaroPrismaClient, restaurantId: string, customerId: string) {
  return prisma.$transaction((tx) => statement(tx, restaurantId, customerId));
}

export async function createCustomer(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  staffId: string,
  rawInput: unknown,
  attempt: IdempotencyAttempt,
) {
  const input = createSchema.parse(rawInput);
  return withRequestReceipt(
    prisma,
    restaurantId,
    staffId,
    'create-customer',
    input,
    attempt,
    async (tx) => {
      const customer = await tx.customer.create({
        data: {
          restaurantId,
          name: input.name,
          phone: input.phone || null,
          address: input.address || null,
        },
      });
      return statement(tx, restaurantId, customer.id);
    },
  );
}

export async function editCustomer(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  customerId: string,
  rawInput: unknown,
) {
  const input = editSchema.parse(rawInput);
  return prisma.$transaction(async (tx) => {
    await claimCustomer(tx, restaurantId, customerId, input.expectedVersion);
    await tx.customer.update({
      where: { id: customerId },
      data: {
        name: input.name,
        phone: input.phone || null,
        address: input.address || null,
        isActive: input.isActive,
      },
    });
    return statement(tx, restaurantId, customerId);
  });
}

async function businessDate(tx: Client, restaurantId: string) {
  const settings = await tx.restaurantSettings.findUnique({
    where: { restaurantId },
    select: { businessDayStartsAtMinutes: true, timezone: true },
  });
  return resolveBusinessDate(new Date(), settings?.businessDayStartsAtMinutes ?? 240, settings?.timezone);
}

export async function repay(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  staffId: string,
  customerId: string,
  rawInput: unknown,
  attempt: IdempotencyAttempt,
) {
  const input = repaySchema.parse(rawInput);
  return withRequestReceipt(
    prisma,
    restaurantId,
    staffId,
    `credit-repayment:${customerId}`,
    input,
    attempt,
    async (tx) => {
      await claimCustomer(tx, restaurantId, customerId, input.expectedVersion);
      if (input.amountPaisa > (await creditBalance(tx, restaurantId, customerId)))
        throw new ApiError(
          409,
          'AMOUNT_EXCEEDS_CREDIT',
          'That is more than this customer owes. Check the refreshed balance.',
        );
      await tx.creditRepayment.create({
        data: {
          restaurantId,
          customerId,
          amountPaisa: input.amountPaisa,
          method: input.method,
          reference: input.reference || null,
          note: input.note || null,
          businessDate: await businessDate(tx, restaurantId),
          receivedByStaffId: staffId,
        },
      });
      return statement(tx, restaurantId, customerId);
    },
  );
}

export async function reverseRepayment(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  staffId: string,
  repaymentId: string,
  rawInput: unknown,
  attempt: IdempotencyAttempt,
) {
  const input = reverseSchema.parse(rawInput);
  return withRequestReceipt(
    prisma,
    restaurantId,
    staffId,
    `reverse-credit-repayment:${repaymentId}`,
    input,
    attempt,
    async (tx) => {
      const repayment = await tx.creditRepayment.findFirst({
        where: { id: repaymentId, restaurantId },
      });
      if (!repayment)
        throw new ApiError(404, 'REPAYMENT_NOT_FOUND', 'That repayment does not exist.');
      if (repayment.reversedAt)
        throw new ApiError(409, 'REPAYMENT_REVERSED', 'That repayment has already been reversed.');
      await claimCustomer(tx, restaurantId, repayment.customerId, input.expectedVersion);
      await tx.creditRepayment.update({
        where: { id: repaymentId },
        data: {
          reversedAt: new Date(),
          reversalBusinessDate: await businessDate(tx, restaurantId),
          reversalReason: input.reason,
          reversedByStaffId: staffId,
        },
      });
      return statement(tx, restaurantId, repayment.customerId);
    },
  );
}

export async function unassignedCredits(
  prisma: NayaroPrismaClient,
  restaurantId: string,
): Promise<UnassignedCreditResponse> {
  const rows = await prisma.payment.findMany({
    where: { restaurantId, method: 'CREDIT', voidedAt: null, customerId: null },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    include: { invoice: { select: { invoiceNumber: true, fiscalYearStartBsYear: true } } },
  });
  return {
    payments: rows.map((row) => ({
      id: row.id,
      name: row.creditAccountName,
      amountPaisa: row.amountPaisa,
      at: row.createdAt.toISOString(),
      invoiceNumber: row.invoice.invoiceNumber,
      fiscalYearLabel: formatNepaliFiscalYear(row.invoice.fiscalYearStartBsYear),
      orderId: row.orderId,
    })),
  };
}

export async function assignCredit(
  prisma: NayaroPrismaClient,
  restaurantId: string,
  staffId: string,
  paymentId: string,
  rawInput: unknown,
  attempt: IdempotencyAttempt,
) {
  const input = assignSchema.parse(rawInput);
  return withRequestReceipt(
    prisma,
    restaurantId,
    staffId,
    `assign-credit:${paymentId}`,
    input,
    attempt,
    async (tx) => {
      await claimCustomer(tx, restaurantId, input.customerId, input.expectedVersion);
      const updated = await tx.payment.updateMany({
        where: { id: paymentId, restaurantId, method: 'CREDIT', voidedAt: null, customerId: null },
        data: {
          customerId: input.customerId,
          creditAssignedAt: new Date(),
          creditAssignedByStaffId: staffId,
        },
      });
      if (updated.count !== 1)
        throw new ApiError(
          409,
          'CREDIT_NOT_UNASSIGNED',
          'That credit entry is no longer available to link. Refresh the list.',
        );
      return statement(tx, restaurantId, input.customerId);
    },
  );
}

/** Keep collections separate from sales, and date reversals when they happen. */
export async function creditCollections(
  client: Client,
  restaurantId: string,
  businessDate: string,
): Promise<CreditCollectionsDto> {
  const [received, reversed] = await Promise.all([
    client.creditRepayment.groupBy({
      by: ['method'],
      where: { restaurantId, businessDate },
      _sum: { amountPaisa: true },
    }),
    client.creditRepayment.groupBy({
      by: ['method'],
      where: { restaurantId, reversalBusinessDate: businessDate },
      _sum: { amountPaisa: true },
    }),
  ]);
  const byMethod = (['CASH', 'QR', 'CARD'] as const).map((method) => {
    const receivedPaisa = received.find((row) => row.method === method)?._sum.amountPaisa ?? 0;
    const reversedPaisa = reversed.find((row) => row.method === method)?._sum.amountPaisa ?? 0;
    return { method, receivedPaisa, reversedPaisa, netPaisa: receivedPaisa - reversedPaisa };
  });
  return {
    byMethod,
    receivedPaisa: byMethod.reduce((sum, row) => sum + row.receivedPaisa, 0),
    reversedPaisa: byMethod.reduce((sum, row) => sum + row.reversedPaisa, 0),
    netPaisa: byMethod.reduce((sum, row) => sum + row.netPaisa, 0),
  };
}
