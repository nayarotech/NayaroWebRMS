import type { InvoiceDto } from './api';

/**
 * Allocate the frozen invoice total by original line value, with largest
 * remainders breaking ties in line-number order. BigInt avoids precision loss
 * when multiplying prices. No tax or discount is recalculated here.
 */
export function itemPaymentShares(invoice: InvoiceDto): readonly {
  invoiceLineId: string;
  quantity: number;
  remainingQuantity: number;
  remainingPaisa: number;
}[] {
  const lines = [...invoice.lines].sort((a, b) => a.lineNumber - b.lineNumber);
  const subtotal = lines.reduce((sum, line) => sum + BigInt(line.lineTotalPaisa), 0n);
  const total = BigInt(invoice.grandTotalPaisa);
  const shares = lines.map((line) => {
    const product = BigInt(line.lineTotalPaisa) * total;
    return {
      line,
      amount: subtotal === 0n ? 0 : Number(product / subtotal),
      remainder: subtotal === 0n ? 0n : product % subtotal,
    };
  });
  const pennies = invoice.grandTotalPaisa - shares.reduce((sum, share) => sum + share.amount, 0);
  const ranked = [...shares].sort((a, b) =>
    a.remainder === b.remainder
      ? a.line.lineNumber - b.line.lineNumber
      : a.remainder > b.remainder
        ? -1
        : 1,
  );
  for (const share of ranked.slice(0, pennies)) share.amount += 1;
  const allocations = invoice.settlement.payments
    .filter((payment) => payment.void === null)
    .flatMap((payment) => payment.itemAllocations);
  return shares.map(({ line, amount }) => {
    const paid = allocations.filter((allocation) => allocation.invoiceLineId === line.id);
    return {
      invoiceLineId: line.id,
      quantity: line.quantity,
      remainingQuantity: line.quantity - paid.reduce((sum, row) => sum + row.quantity, 0),
      remainingPaisa: amount - paid.reduce((sum, row) => sum + row.amountPaisa, 0),
    };
  });
}

/** The last units receive any fractional paisa left by earlier guests. */
export function selectedItemAmount(
  share: { remainingPaisa: number; remainingQuantity: number },
  quantity: number,
): number {
  if (share.remainingQuantity <= 0) return 0;
  return Number(
    (BigInt(share.remainingPaisa) * BigInt(quantity)) / BigInt(share.remainingQuantity),
  );
}

export function canSplitByItem(invoice: InvoiceDto): boolean {
  return invoice.settlement.payments.every(
    (payment) => payment.void !== null || payment.itemAllocations.length > 0,
  );
}
