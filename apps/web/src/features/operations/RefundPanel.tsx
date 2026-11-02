import { useState } from 'react';
import type { InvoiceDto, RefundDto } from '@nayaro/shared';
import { formatPaisa, parseRupees } from '@/lib/money';
import { Button } from '@/components/ui/Button';
import { useOperation } from './useOperation';
import { RecordPrint } from './RecordPrint';

export function RefundPanel({ invoice, mayRefund }: { invoice: InvoiceDto; mayRefund: boolean }) {
  const action = useOperation();
  const [paymentId, setPaymentId] = useState('');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [printing, setPrinting] = useState<RefundDto | null>(null);
  const payment = invoice.settlement.payments.find((row) => row.id === paymentId);
  const refunded = payment?.refunds.reduce((sum, row) => sum + row.amountPaisa, 0) ?? 0;
  const available = payment ? payment.amountPaisa - refunded : 0;
  const paisa = parseRupees(amount);
  const refunds = invoice.settlement.payments.flatMap((row) => row.refunds);
  if (invoice.status !== 'ACTIVE' || invoice.settlement.remainingPaisa !== 0) return null;
  return (
    <div className="border-border-2 mt-4 rounded-xl border p-4">
      <h3 className="font-bold">Refunds</h3>
      {refunds.length === 0 && <p className="text-muted text-sm">No refunds recorded.</p>}
      {refunds.map((row) => (
        <div key={row.id} className="my-2 text-sm">
          {formatPaisa(row.amountPaisa)} · {row.method} · {row.staff.name} ·{' '}
          {new Date(row.createdAt).toLocaleString()}
          <p>{row.reason}</p>
          <button className="text-accent-hover underline" onClick={() => setPrinting(row)}>
            Print refund receipt
          </button>
        </div>
      ))}
      {mayRefund && (
        <form
          className="mt-3 flex flex-col gap-2"
          onSubmit={async (event) => {
            event.preventDefault();
            if (
              !payment ||
              paisa === null ||
              paisa <= 0 ||
              paisa > available ||
              reason.trim().length < 3
            )
              return;
            const result = await action.run<{ refund: RefundDto }>(
              `/payments/${payment.id}/refunds`,
              { amountPaisa: paisa, expectedRefundedPaisa: refunded, reason },
            );
            if (result) {
              setAmount('');
              setReason('');
              setPrinting(result.refund);
            }
          }}
        >
          <label className="text-sm">
            Original payment
            <select
              className="bg-field border-border-3 ml-2 rounded border p-2"
              required
              value={paymentId}
              onChange={(event) => {
                setPaymentId(event.target.value);
                setAmount('');
              }}
            >
              <option value="">Choose payment</option>
              {invoice.settlement.payments
                .filter((row) => row.void === null)
                .map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.method} ·{' '}
                    {formatPaisa(
                      row.amountPaisa -
                        row.refunds.reduce((sum, refund) => sum + refund.amountPaisa, 0),
                    )}{' '}
                    refundable · {row.id.slice(-6)}
                  </option>
                ))}
            </select>
          </label>
          <label>
            Refund amount (Rs)
            <input
              className="bg-field border-border-3 ml-2 rounded border p-2"
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              required
            />
          </label>
          <button
            type="button"
            className="text-accent-hover text-left text-sm underline"
            disabled={!payment}
            onClick={() => setAmount((available / 100).toFixed(2))}
          >
            Refund remaining {formatPaisa(available)}
          </button>
          <label>
            Reason
            <input
              className="bg-field border-border-3 ml-2 rounded border p-2"
              minLength={3}
              maxLength={300}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              required
            />
          </label>
          <p className="text-muted text-xs">
            Refunds use the original payment method. Confirm QR/card returns externally. Cash
            requires an open drawer; credit reduces the customer’s outstanding debt.
          </p>
          {action.error && (
            <p role="alert" className="text-danger text-sm">
              {action.error}
            </p>
          )}
          <Button
            type="submit"
            disabled={
              action.busy ||
              !payment ||
              paisa === null ||
              paisa <= 0 ||
              paisa > available ||
              reason.trim().length < 3
            }
          >
            Record refund
          </Button>
        </form>
      )}
      {printing && (
        <RecordPrint onDone={() => setPrinting(null)}>
          <h2>{invoice.seller.name}</h2>
          <h3>REFUND RECEIPT</h3>
          <p>Reference: {printing.id}</p>
          <p>
            Invoice #{invoice.invoiceNumber} · {invoice.fiscalYearLabel}
          </p>
          <p>{new Date(printing.createdAt).toLocaleString()}</p>
          <p>
            {printing.method} · {formatPaisa(printing.amountPaisa)}
          </p>
          <p>{printing.reason}</p>
          <p>Approved by {printing.staff.name}</p>
          <p>Original invoice remains on record. Reprints use this same refund reference.</p>
        </RecordPrint>
      )}
    </div>
  );
}
