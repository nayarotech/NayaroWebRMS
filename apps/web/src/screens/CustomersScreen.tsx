import { useState, type JSX } from 'react';
import { EmptyState, LoadingState } from '@/components/ui/States';
import { HandCoins } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import type { CollectionMethod, CustomerDto, CustomerStatementResponse } from '@nayaro/shared';
import { Button } from '@/components/ui/Button';
import { TextField } from '@/components/ui/TextField';
import { Modal } from '@/components/ui/Modal';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { CustomerEditor } from '@/features/credit/CustomerEditor';
import {
  useCreditActions,
  useCustomers,
  useStatement,
  useUnassignedCredit,
} from '@/features/credit/useCredit';
import { formatPaisa } from '@/lib/money';
import { ApiRequestError } from '@/services/apiClient';
import { Page, PageHeader } from '@/components/layout/Page';

const panel = 'border-border bg-surface shadow-card rounded-card border p-5';
const selectStyle = 'bg-field border-border-3 mb-4 w-full rounded-xl border px-3 py-3 text-sm';
const date = (at: string): string => new Date(at).toLocaleString();

export function CustomersScreen(): JSX.Element {
  const { customerId } = useParams();
  const navigate = useNavigate();
  const { staff } = useAuth();
  const manage = staff?.role === 'OWNER' || staff?.role === 'MANAGER';
  const [search, setSearch] = useState('');
  const customers = useCustomers(search);
  const details = useStatement(customerId);
  const unassigned = useUnassignedCredit();
  const actions = useCreditActions();
  const [editing, setEditing] = useState<'new' | CustomerDto | null>(null);
  const [repaying, setRepaying] = useState(false);
  const [reversing, setReversing] = useState<string | null>(null);
  const [linking, setLinking] = useState<string | null>(null);
  const [linkCustomer, setLinkCustomer] = useState('');
  const customer = details.data?.customer;
  const rows = customers.data?.customers ?? [];
  const forbidden = customers.error instanceof ApiRequestError && customers.error.status === 403;
  if (forbidden)
    return (
      <p role="alert" className="text-muted">
        Customer credit is available to cashiers, managers and owners.
      </p>
    );
  return (
    <Page>
      <PageHeader
        title="Customer credit"
        description={<>Track what customers owe and record repayments against their accounts.</>}
        actions={
          <>
            <Button
              onClick={() => {
                actions.clearError();
                setEditing('new');
              }}
            >
              Add customer
            </Button>
          </>
        }
      />
      {actions.error && (
        <p role="alert" className="text-danger mb-4 text-sm">
          {actions.error}{' '}
          <button className="underline" onClick={actions.clearError}>
            Dismiss
          </button>
        </p>
      )}
      <div className="grid items-start gap-5 lg:grid-cols-[320px_1fr]">
        <section className={panel} aria-label="Customers">
          <TextField
            label="Find by name or phone"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            maxLength={120}
          />
          {customers.isPending && <p className="text-muted text-sm">Loading customers…</p>}
          {customers.isError && (
            <p role="alert" className="text-danger text-sm">
              Could not refresh customers.{' '}
              <button className="underline" onClick={() => void customers.refetch()}>
                Refresh
              </button>
            </p>
          )}
          {customers.isSuccess && rows.length === 0 && (
            <p className="text-muted text-sm">
              {search
                ? 'No matching customers.'
                : 'Add your first customer to start tracking credit.'}
            </p>
          )}
          <ul className="max-h-[65vh] space-y-2 overflow-auto">
            {rows.map((row) => (
              <li key={row.id}>
                <Link
                  to={`/customers/${row.id}`}
                  aria-current={customerId === row.id ? 'page' : undefined}
                  className={`block rounded-xl border p-3 ${customerId === row.id ? 'border-accent bg-accent/8' : 'border-border-2'}`}
                >
                  <div className="flex justify-between gap-2 text-sm font-bold">
                    <span>{row.name}</span>
                    <span className="font-mono">{formatPaisa(row.balancePaisa)}</span>
                  </div>
                  <p className="text-muted mt-1 text-xs">
                    {row.phone || row.address || `Account …${row.id.slice(-6)}`}
                    {!row.isActive && ' · Inactive'}
                  </p>
                </Link>
              </li>
            ))}
          </ul>
        </section>
        <section className={panel} aria-label="Customer statement">
          {!customerId && (
            <EmptyState
              icon={HandCoins}
              title="Choose a customer"
              description="Select an account on the left to see its statement, outstanding bills and loyalty points, or to take a repayment."
            />
          )}
          {customerId && details.isPending && (
            <LoadingState label="Loading statement…" />
          )}
          {details.isError && (
            <p role="alert" className="text-danger text-sm">
              Could not refresh this statement.{' '}
              <button className="underline" onClick={() => void details.refetch()}>
                Refresh
              </button>
            </p>
          )}
          {customer && details.data && (
            <>
              <div className="mb-5 flex flex-wrap justify-between gap-3">
                <div>
                  <h2 className="text-xl font-extrabold">
                    {customer.name}
                    {!customer.isActive && ' · Inactive'}
                  </h2>
                  <p className="text-muted mt-1 text-sm">
                    {[customer.phone, customer.address].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={() => exportStatement(details.data!)}>
                    Export CSV
                  </Button>
                  {manage && (
                    <Button
                      variant="secondary"
                      onClick={() => {
                        actions.clearError();
                        setEditing(customer);
                      }}
                    >
                      Edit
                    </Button>
                  )}
                </div>
              </div>
              <dl className="mb-5 grid grid-cols-3 gap-3">
                {[
                  ['Credit sales', customer.creditPaisa],
                  ['Repaid', customer.repaidPaisa],
                  ['Outstanding', customer.balancePaisa],
                ].map(([label, value]) => (
                  <div key={label} className="bg-field rounded-xl p-3">
                    <dt className="text-muted text-xs">{label}</dt>
                    <dd className="mt-1 font-mono text-sm font-bold">
                      {formatPaisa(value as number)}
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="mb-5">
                <Button
                  disabled={actions.busy || customer.balancePaisa <= 0 || details.isError}
                  onClick={() => {
                    actions.clearError();
                    setRepaying(true);
                  }}
                >
                  Receive repayment
                </Button>
              </div>
              {details.data.entries.length === 0 ? (
                <p className="text-muted text-sm">No credit activity yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-muted border-border-2 border-b">
                      <tr>
                        {['Date / staff', 'Activity', 'Debt change', 'Balance', ''].map(
                          (label, i) => (
                            <th className="p-2" key={i}>
                              {label}
                            </th>
                          ),
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {details.data.entries.map((entry) => (
                        <tr key={entry.id} className="border-border/60 border-b align-top">
                          <td className="p-2 whitespace-nowrap">
                            {date(entry.at)}
                            <div className="text-muted mt-1">{entry.staff.name}</div>
                          </td>
                          <td className="p-2">
                            <span className="font-semibold">
                              {entry.kind.replaceAll('_', ' ')} · {entry.method}
                            </span>
                            <div className="text-muted mt-1">
                              {entry.orderId ? (
                                <Link className="underline" to={`/billing/${entry.orderId}`}>
                                  {entry.description}
                                </Link>
                              ) : (
                                entry.description
                              )}
                            </div>
                          </td>
                          <td className="p-2 font-mono whitespace-nowrap">
                            {entry.amountPaisa > 0 ? '+' : '−'}
                            {formatPaisa(Math.abs(entry.amountPaisa))}
                          </td>
                          <td className="p-2 font-mono whitespace-nowrap">
                            {formatPaisa(entry.balancePaisa)}
                          </td>
                          <td className="p-2">
                            {manage && entry.canReverse && entry.repaymentId && (
                              <button
                                disabled={actions.busy}
                                className="text-danger underline"
                                onClick={() => {
                                  actions.clearError();
                                  setReversing(entry.repaymentId);
                                }}
                              >
                                Reverse
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </section>
      </div>
      <section className={`${panel} mt-5`}>
        <h2 className="mb-2 text-[1rem] font-bold">Unassigned older credit</h2>
        <p className="text-muted mb-3 text-sm">
          These entries are outside customer balances until linked.{' '}
          {manage
            ? 'Check the original bill and choose the correct account.'
            : 'Ask an owner or manager to link them to the correct customer.'}
        </p>
        {unassigned.isPending && <p className="text-muted text-sm">Loading older entries…</p>}
        {unassigned.isError && (
          <p role="alert" className="text-danger text-sm">
            Could not load older credit.{' '}
            <button className="underline" onClick={() => void unassigned.refetch()}>
              Refresh
            </button>
          </p>
        )}
        {unassigned.data?.payments.length === 0 && (
          <p className="text-muted text-sm">No unassigned credit.</p>
        )}
        <ul className="space-y-2">
          {unassigned.data?.payments.map((payment) => (
            <li
              key={payment.id}
              className="border-border-2 flex flex-wrap items-center gap-3 border-t pt-2 text-sm"
            >
              <span className="font-semibold">{payment.name || 'Unnamed credit'}</span>
              <Link className="text-muted underline" to={`/billing/${payment.orderId}`}>
                Invoice #{payment.invoiceNumber} · {payment.fiscalYearLabel}
              </Link>
              <span>{date(payment.at)}</span>
              <span className="ml-auto font-mono">{formatPaisa(payment.amountPaisa)}</span>
              {manage && (
                <Button
                  variant="secondary"
                  disabled={actions.busy}
                  onClick={() => {
                    actions.clearError();
                    setLinkCustomer(customer?.id ?? '');
                    setLinking(payment.id);
                  }}
                >
                  Link account
                </Button>
              )}
            </li>
          ))}
        </ul>
      </section>
      {editing && (
        <CustomerEditor
          key={typeof editing === 'string' ? 'new' : editing.id}
          {...(editing === 'new' ? {} : { customer: editing })}
          busy={actions.busy}
          error={actions.error}
          onClose={() => setEditing(null)}
          onSave={async (request) => {
            const saved =
              editing === 'new'
                ? await actions.create(request)
                : await actions.edit(editing, request);
            if (saved) void navigate(`/customers/${saved.id}`);
            return saved !== null;
          }}
        />
      )}
      {repaying && customer && (
        <RepaymentForm
          key={customer.id}
          customer={customer}
          busy={actions.busy}
          error={actions.error}
          onClose={() => setRepaying(false)}
          onSave={async (amountPaisa, method, reference, note) => {
            if (
              await actions.repay(customer.id, {
                expectedVersion: customer.version,
                amountPaisa,
                method,
                reference,
                note,
              })
            )
              setRepaying(false);
          }}
        />
      )}
      {reversing && customer && (
        <ReversalForm
          busy={actions.busy}
          error={actions.error}
          onClose={() => setReversing(null)}
          onSave={async (reason) => {
            if (await actions.reverse(customer, reversing, reason)) setReversing(null);
          }}
        />
      )}
      {linking && (
        <Modal
          open
          title="Link older credit"
          description="This adds the credit to the selected account. The original invoice and recorded name remain unchanged."
          onClose={() => {
            if (!actions.busy) setLinking(null);
          }}
        >
          <LinkAccountForm
            selected={linkCustomer}
            onChange={setLinkCustomer}
            busy={actions.busy}
            error={actions.error}
            onSave={async (selected) => {
              if (await actions.assign(selected, linking)) {
                setLinking(null);
                void navigate(`/customers/${selected.id}`);
              }
            }}
          />
        </Modal>
      )}
    </Page>
  );
}

function LinkAccountForm({
  selected,
  onChange,
  busy,
  error,
  onSave,
}: {
  selected: string;
  onChange: (id: string) => void;
  busy: boolean;
  error: string | null;
  onSave: (customer: CustomerDto) => Promise<void>;
}): JSX.Element {
  const customers = useCustomers();
  const chosen = customers.data?.customers.find((row) => row.id === selected);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (chosen && !busy) void onSave(chosen);
      }}
    >
      <label className="text-muted text-sm" htmlFor="link-customer">
        Customer account
      </label>
      <select
        id="link-customer"
        className={selectStyle}
        value={selected}
        onChange={(e) => onChange(e.target.value)}
        disabled={busy || customers.isError}
        required
      >
        <option value="">Choose an account</option>
        {customers.data?.customers.map((row) => (
          <option value={row.id} key={row.id}>
            {row.name} · {row.phone || row.address || row.id.slice(-6)}
            {!row.isActive ? ' · Inactive' : ''}
          </option>
        ))}
      </select>
      {error && (
        <p role="alert" className="text-danger mb-3 text-sm">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy || !chosen || customers.isError} loading={busy}>
        Link credit
      </Button>
    </form>
  );
}

function RepaymentForm({
  customer,
  busy,
  error,
  onClose,
  onSave,
}: {
  customer: CustomerDto;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (
    amount: number,
    method: CollectionMethod,
    reference: string,
    note: string,
  ) => Promise<void>;
}): JSX.Element {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<CollectionMethod>('CASH');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  // Refuse fractional paisa, scientific notation and floating point rounding of money input.
  const valid = /^\d+(\.\d{1,2})?$/.test(amount.trim());
  const [whole = '', fraction = ''] = amount.trim().split('.');
  const paisa = valid ? Number(whole) * 100 + Number(fraction.padEnd(2, '0')) : 0;
  const allowed =
    valid &&
    Number.isSafeInteger(paisa) &&
    paisa > 0 &&
    paisa <= Math.min(customer.balancePaisa, 1_000_000_000);
  return (
    <Modal
      open
      title={`Receive repayment · ${customer.name}`}
      description={`Outstanding ${formatPaisa(customer.balancePaisa)}. This collection does not create another sale.`}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && allowed) void onSave(paisa, method, reference.trim(), note.trim());
        }}
      >
        <fieldset disabled={busy}>
          <TextField
            label="Amount received (Rs)"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            required
            autoFocus
          />
          <label htmlFor="repayment-method" className="text-muted text-sm">
            Payment method
          </label>
          <select
            id="repayment-method"
            className={selectStyle}
            value={method}
            onChange={(e) => setMethod(e.target.value as CollectionMethod)}
          >
            {(['CASH', 'QR', 'CARD'] as const).map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
          <TextField
            label="Reference (optional)"
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            maxLength={80}
          />
          <TextField
            label="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={300}
          />
          {amount && !allowed && (
            <p className="text-danger mb-3 text-sm">
              Enter a positive amount with up to two decimal places, within the outstanding balance.
            </p>
          )}
          {error && (
            <p role="alert" className="text-danger mb-3 text-sm">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!allowed || busy} loading={busy}>
              {method === 'CASH'
                ? 'Record cash received'
                : `Confirm ${method === 'QR' ? 'QR' : 'card'} repayment`}
            </Button>
          </div>
        </fieldset>
      </form>
    </Modal>
  );
}

function ReversalForm({
  busy,
  error,
  onClose,
  onSave,
}: {
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (reason: string) => Promise<void>;
}): JSX.Element {
  const [reason, setReason] = useState('');
  return (
    <Modal
      open
      title="Reverse repayment"
      description="Use this to correct a wrongly recorded repayment. It restores the customer's debt and reverses the collection using today's business date."
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && reason.trim().length >= 3) void onSave(reason.trim());
        }}
      >
        <TextField
          label="Reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          minLength={3}
          maxLength={300}
          required
          disabled={busy}
          autoFocus
        />
        {error && (
          <p role="alert" className="text-danger mb-3 text-sm">
            {error}
          </p>
        )}
        <Button type="submit" disabled={busy || reason.trim().length < 3} loading={busy}>
          Reverse repayment
        </Button>
      </form>
    </Modal>
  );
}

function exportStatement(statement: CustomerStatementResponse): void {
  const text = (value: string): string =>
    `"${(/^\s*[=+\-@]|^[\t\r\n]/.test(value) ? "'" + value : value).replaceAll('"', '""')}"`;
  const csv = [
    ['Customer', statement.customer.name, 'Phone', statement.customer.phone ?? '']
      .map(text)
      .join(','),
    ['Date', 'Activity', 'Description', 'Method', 'Debt change (paisa)', 'Balance (paisa)', 'Staff']
      .map(text)
      .join(','),
    ...statement.entries.map((row) =>
      [
        text(row.at),
        text(row.kind),
        text(row.description),
        text(row.method),
        row.amountPaisa,
        row.balancePaisa,
        text(row.staff.name),
      ].join(','),
    ),
  ].join('\r\n');
  const url = URL.createObjectURL(new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `customer-${statement.customer.id}-statement.csv`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
