import { useState, type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { LoyaltyStatement, OrderLoyaltyResponse } from '@nayaro/shared';
import { apiClient } from '@/services/apiClient';
import { formatPaisa } from '@/lib/money';
import { Button } from '@/components/ui/Button';
import { useCustomers, useCreditActions } from '@/features/credit/useCredit';
import { CustomerEditor } from '@/features/credit/CustomerEditor';
import { useManagementActions } from '@/features/management/hooks/useManagement';

export function LoyaltyBillPanel({
  orderId,
  busy,
  canReturnRewards,
}: {
  canReturnRewards: boolean;
  orderId: string;
  busy: boolean;
}): JSX.Element | null {
  const loyalty = useQuery({
    queryKey: ['loyalty', 'order', orderId],
    queryFn: () => apiClient.get<OrderLoyaltyResponse>(`/orders/${orderId}/loyalty`),
    refetchInterval: 10_000,
  });
  if (loyalty.isError)
    return (
      <p role="alert" className="text-danger-fg mb-3 text-sm">
        Could not refresh loyalty. Refresh before choosing rewards.
      </p>
    );
  if (!loyalty.data || (!loyalty.data.program.enabled && !loyalty.data.customerId)) return null;
  return (
    <Selection
      key={loyalty.data.orderVersion}
      orderId={orderId}
      data={loyalty.data}
      busy={busy}
      canReturnRewards={canReturnRewards}
    />
  );
}
function Selection({
  orderId,
  data,
  busy,
  canReturnRewards,
}: {
  orderId: string;
  data: OrderLoyaltyResponse;
  canReturnRewards: boolean;
  busy: boolean;
}): JSX.Element {
  const [customerId, setCustomerId] = useState(data.customerId ?? '');
  const [points, setPoints] = useState(String(data.pointsToRedeem));
  const [adding, setAdding] = useState(false);
  const [returnReason, setReturnReason] = useState('');
  const customers = useCustomers('', data.editable && data.program.enabled);
  const account = useQuery({
    queryKey: ['loyalty', 'customer', customerId],
    queryFn: () => apiClient.get<LoyaltyStatement>(`/customers/${customerId}/loyalty`),
    enabled: customerId.length > 0,
    refetchInterval: 10_000,
  });
  const credit = useCreditActions();
  const actions = useManagementActions([
    ['loyalty'],
    ['billing', orderId],
    ['order'],
    ['customers'],
  ]);
  const waiting = busy || actions.isSaving || credit.busy;
  const statement = account.data ?? (customerId === data.customerId ? data.statement : null);
  const amount = Number(points);
  const valid =
    Number.isInteger(amount) &&
    amount >= 0 &&
    amount <= 1_000_000 &&
    (amount === 0 || (statement !== null && !account.isError && amount <= statement.balancePoints));
  const save = (id: string | null, count: number) =>
    actions.run(() =>
      apiClient.post(`/orders/${orderId}/loyalty`, {
        expectedOrderVersion: data.orderVersion,
        customerId: id,
        points: count,
      }),
    );
  return (
    <section
      aria-label="Customer loyalty"
      className="border-border-2 bg-surface mb-4 rounded-card border p-4"
    >
      <h2 className="text-[1rem] font-extrabold">Customer loyalty</h2>
      {data.editable ? (
        <>
          <p className="text-muted mt-1 mb-3 text-xs">
            One customer earns points for this bill. Rewards can combine with offer prices, but
            replace a manual bill discount. Points are checked and spent when the invoice is issued.
          </p>
          {!data.program.enabled && (
            <p className="text-muted mb-3 text-sm">
              The program is disabled. Clear the customer or reward to continue without loyalty.
            </p>
          )}
          {data.program.enabled && (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (valid && customerId) void save(customerId, amount);
              }}
            >
              <fieldset
                disabled={waiting}
                className="flex flex-wrap items-end gap-3 disabled:opacity-60"
              >
                <label className="min-w-48 flex-1 text-sm">
                  Customer
                  <select
                    aria-label="Loyalty customer"
                    value={customerId}
                    onChange={(event) => {
                      setCustomerId(event.target.value);
                      setPoints('0');
                    }}
                    className="bg-field border-border-3 mt-1 block w-full rounded-lg border px-3 py-2"
                  >
                    <option value="">Choose a customer…</option>
                    {customers.data?.customers
                      .filter((row) => row.isActive || row.id === data.customerId)
                      .map((row) => (
                        <option key={row.id} value={row.id}>
                          {row.name}
                          {row.phone ? ` · ${row.phone}` : ''}
                          {!row.isActive ? ' (inactive)' : ''}
                        </option>
                      ))}
                  </select>
                </label>
                <label className="text-sm">
                  Points to redeem
                  <input
                    aria-label="Loyalty points to redeem"
                    type="number"
                    min="0"
                    max={Math.max(0, statement?.balancePoints ?? 0)}
                    step="1"
                    required
                    value={points}
                    onChange={(event) => setPoints(event.target.value)}
                    className="bg-field border-border-3 mt-1 block w-28 rounded-lg border px-3 py-2"
                  />
                </label>
                <Button
                  type="submit"
                  variant="secondary"
                  disabled={
                    waiting || !valid || !customerId || customers.isError || account.isFetching
                  }
                >
                  Apply loyalty
                </Button>
                <Button type="button" variant="ghost" onClick={() => setAdding(true)}>
                  Add customer
                </Button>
              </fieldset>
            </form>
          )}
          {customerId && (
            <p className="text-muted mt-3 text-sm">
              {account.isError
                ? 'Could not refresh this customer’s points.'
                : statement
                  ? `${Math.max(0, statement.balancePoints)} points available`
                  : 'Loading points…'}
              {valid && amount > 0
                ? ` · Reward ${formatPaisa(customerId === data.customerId && amount === data.pointsToRedeem ? data.redemptionPaisa : amount * data.program.pointValuePaisa)}`
                : ''}
            </p>
          )}
          {data.program.enabled && (
            <p className="text-muted mt-2 text-xs">
              Earn one point per {formatPaisa(data.program.earnEveryPaisa)} paid by cash, QR or card
              once the bill settles.
            </p>
          )}
          {data.customerId && (
            <Button
              className="mt-3"
              variant="secondary"
              disabled={waiting}
              onClick={() => {
                void save(null, 0);
              }}
            >
              Clear loyalty
            </Button>
          )}
        </>
      ) : (
        <p className="text-muted mt-2 text-sm">
          {data.statement === null || data.statement === undefined
            ? 'No customer was added to this bill. '
            : `${data.statement.customerName} · ${String(data.statement.balancePoints)} points available. `}
          Loyalty choices are fixed after issuing the bill.
        </p>
      )}
      {canReturnRewards && data.rewardOnlyInvoiceId && (
        <form
          className="mt-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (returnReason.trim().length >= 3)
              void actions.run(() =>
                apiClient.postWithReceipt(`/invoices/${data.rewardOnlyInvoiceId}/loyalty-return`, {
                  expectedOrderVersion: data.orderVersion,
                  reason: returnReason.trim(),
                }),
              );
          }}
        >
          <p className="text-muted mb-2 text-xs">
            This reward-only bill has no money to refund. An owner or manager can return its points
            with a reason.
          </p>
          <label className="block text-sm">
            Reason for returning reward points
            <input
              aria-label="Reward return reason"
              minLength={3}
              maxLength={300}
              required
              value={returnReason}
              onChange={(event) => setReturnReason(event.target.value)}
              className="bg-field border-border-3 mt-1 block w-full rounded-lg border px-3 py-2"
            />
          </label>
          <Button
            type="submit"
            variant="secondary"
            className="mt-2"
            disabled={waiting || returnReason.trim().length < 3}
          >
            Return reward points
          </Button>
        </form>
      )}
      {statement && statement.balancePoints < 0 && (
        <p className="text-muted mt-2 text-xs">
          Refund adjustments have left a negative points balance. Future earnings reduce it before
          more points can be redeemed.
        </p>
      )}
      {statement && (
        <details className="text-muted mt-3 text-xs">
          <summary className="cursor-pointer font-semibold">Recent points activity</summary>
          {statement.entries.length === 0 ? (
            <p className="mt-2">No points activity yet.</p>
          ) : (
            <ul className="mt-2 space-y-1">
              {statement.entries.slice(0, 10).map((entry) => (
                <li key={entry.id}>
                  {new Date(entry.at).toLocaleDateString()} · Bill #{entry.invoiceNumber} ·{' '}
                  {entry.deltaPoints > 0 ? '+' : ''}
                  {entry.deltaPoints} points · {entry.kind.replaceAll('_', ' ').toLowerCase()}
                  {entry.reason ? ` · ${entry.reason}` : ''}
                </li>
              ))}
            </ul>
          )}
        </details>
      )}
      {actions.error && (
        <p role="alert" className="text-danger-fg mt-3 text-sm">
          {actions.error}
        </p>
      )}
      {customers.isError && data.editable && (
        <p role="alert" className="text-danger-fg mt-3 text-sm">
          Could not refresh customer accounts.
        </p>
      )}
      {adding && (
        <CustomerEditor
          busy={credit.busy}
          error={credit.error}
          onClose={() => setAdding(false)}
          onSave={async (input) => {
            const customer = await credit.create(input);
            if (customer) {
              setCustomerId(customer.id);
              setPoints('0');
              return true;
            }
            return false;
          }}
        />
      )}
    </section>
  );
}
