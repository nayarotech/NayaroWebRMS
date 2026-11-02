import { useState, type JSX } from 'react';
import type { PayrollRecordDto } from '@nayaro/shared';
import { Button } from '@/components/ui/Button';
import { formatPaisa, parseRupees } from '@/lib/money';
import { exportCsv, fieldClass } from '@/features/operations/files';

type Run = <T>(path: string, body: unknown) => Promise<T | null>;
export function PayrollDetail({
  record,
  today,
  busy,
  run,
}: {
  record: PayrollRecordDto;
  today: string;
  busy: boolean;
  run: Run;
}): JSX.Element {
  const [base, setBase] = useState((record.baseSalaryPaisa / 100).toFixed(2));
  const [allowances, setAllowances] = useState((record.allowancesPaisa / 100).toFixed(2));
  const [deductions, setDeductions] = useState((record.deductionsPaisa / 100).toFixed(2));
  const [note, setNote] = useState(record.note);
  const [reason, setReason] = useState('');
  const basePaisa = parseRupees(base),
    allowancesPaisa = parseRupees(allowances),
    deductionsPaisa = parseRupees(deductions);
  const valid =
    basePaisa !== null &&
    allowancesPaisa !== null &&
    deductionsPaisa !== null &&
    basePaisa + allowancesPaisa <= 1_000_000_000 &&
    deductionsPaisa <= basePaisa + allowancesPaisa &&
    basePaisa + allowancesPaisa - deductionsPaisa >= record.paidPaisa;
  const dirty =
    record.status === 'DRAFT' &&
    (basePaisa !== record.baseSalaryPaisa ||
      allowancesPaisa !== record.allowancesPaisa ||
      deductionsPaisa !== record.deductionsPaisa ||
      note.trim() !== record.note);
  return (
    <section
      aria-label="Payroll record"
      className="border-border bg-surface shadow-card space-y-5 rounded-card border p-5"
    >
      <header>
        <h2 className="text-title font-extrabold">
          {record.staffName} · {record.month}
        </h2>
        <p className="text-muted mt-1 text-body">
          {record.settled
            ? 'Settled'
            : record.status === 'DRAFT'
              ? 'Draft — review before approval'
              : `Approved by ${record.approvedBy ?? 'owner'}`}
        </p>
        <div className="mt-4 grid grid-cols-3 gap-3">
          {(
            [
              ['Net salary', record.netSalaryPaisa, 'text-text'],
              ['Advances paid', record.advancePaisa, 'text-text'],
              ['Remaining', record.remainingPaisa, record.remainingPaisa > 0 ? 'text-warn-fg' : 'text-ok-fg'],
            ] as const
          ).map(([label, value, tone]) => (
            <div key={label} className="bg-accent-soft rounded-card px-4 py-3">
              <p className="text-muted text-caption font-semibold">{label}</p>
              <p className={`mt-0.5 font-mono text-heading font-semibold ${tone}`}>{formatPaisa(value)}</p>
            </div>
          ))}
        </div>
      </header>
      {record.status === 'DRAFT' ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (valid && note.trim().length >= 3)
              void run(`/payroll/records/${record.id}/edit`, {
                expectedVersion: record.version,
                baseSalaryPaisa: basePaisa,
                allowancesPaisa,
                deductionsPaisa,
                note: note.trim(),
              });
          }}
        >
          <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-3">
            <Money
              label="Base salary (₨)"
              aria="Payroll base salary"
              value={base}
              change={setBase}
            />
            <Money
              label="Allowances / overtime (₨)"
              aria="Payroll allowances"
              value={allowances}
              change={setAllowances}
            />
            <Money
              label="Deductions (₨)"
              aria="Payroll deductions"
              value={deductions}
              change={setDeductions}
            />
            <label className="text-body sm:col-span-3">
              Explanation of pay and deductions
              <input
                aria-label="Payroll edit note"
                className={`${fieldClass} mt-1 block w-full`}
                minLength={3}
                maxLength={300}
                required
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
            <p className="text-muted text-caption sm:col-span-3">
              Enter any attendance adjustments or deductions manually. Advances are already included
              in paid amounts; do not enter them again as deductions.
            </p>
            {!valid && (
              <p role="alert" className="text-danger-fg text-body sm:col-span-3">
                Deductions must fit gross pay, and net pay cannot fall below advances already paid.
              </p>
            )}
            <Button
              type="submit"
              variant="secondary"
              disabled={busy || !valid || !dirty || note.trim().length < 3}
            >
              Save payroll changes
            </Button>
          </fieldset>
        </form>
      ) : (
        <dl className="grid gap-3 text-body sm:grid-cols-3 [&>div]:border-border [&>div]:bg-surface-3 [&>div]:rounded-card [&>div]:border [&>div]:p-3 [&_dd]:mt-0.5 [&_dd]:font-mono [&_dd]:font-semibold [&_dt]:text-caption">
          <div>
            <dt className="text-muted">Base salary</dt>
            <dd>{formatPaisa(record.baseSalaryPaisa)}</dd>
          </div>
          <div>
            <dt className="text-muted">Allowances / overtime</dt>
            <dd>{formatPaisa(record.allowancesPaisa)}</dd>
          </div>
          <div>
            <dt className="text-muted">Deductions</dt>
            <dd>{formatPaisa(record.deductionsPaisa)}</dd>
          </div>
          {record.note && (
            <div className="sm:col-span-3">
              <dt className="text-muted">Explanation</dt>
              <dd>{record.note}</dd>
            </div>
          )}
        </dl>
      )}
      {(record.status === 'DRAFT' || record.canReopen) && (
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (reason.trim().length >= 3 && !dirty)
              void run(
                `/payroll/records/${record.id}/${record.status === 'DRAFT' ? 'approve' : 'reopen'}`,
                { expectedVersion: record.version, note: reason.trim() },
              );
          }}
        >
          <label className="min-w-56 flex-1 text-body">
            {record.status === 'DRAFT' ? 'Approval note' : 'Reason for reopening'}
            <input
              aria-label="Payroll approval or reopening note"
              className={`${fieldClass} mt-1 block w-full`}
              minLength={3}
              maxLength={300}
              required
              value={reason}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <Button
            type="submit"
            variant="secondary"
            disabled={busy || dirty || reason.trim().length < 3}
          >
            {record.status === 'DRAFT' ? 'Approve payroll' : 'Reopen draft'}
          </Button>
        </form>
      )}
      {dirty && (
        <p className="text-muted text-caption">
          Save the amount changes before approving payroll or recording an advance.
        </p>
      )}
      {!record.canReopen && record.status === 'APPROVED' && (
        <p className="text-muted text-caption">
          Salary payments have been recorded. Approved amounts are now fixed.
        </p>
      )}
      {record.remainingPaisa > 0 && (
        <PaymentForm record={record} today={today} busy={busy || dirty} run={run} />
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          onClick={() =>
            exportCsv(`payroll-statement-${record.month}-${record.staffName}.csv`, [
              ['Payroll statement', record.staffName],
              ['Month (Gregorian)', record.month],
              ['Status', record.settled ? 'SETTLED' : record.status],
              ['Base salary (Rs)', (record.baseSalaryPaisa / 100).toFixed(2)],
              ['Allowances (Rs)', (record.allowancesPaisa / 100).toFixed(2)],
              ['Deductions (Rs)', (record.deductionsPaisa / 100).toFixed(2)],
              ['Net salary (Rs)', (record.netSalaryPaisa / 100).toFixed(2)],
              ['Total paid (Rs)', (record.paidPaisa / 100).toFixed(2)],
              ['Remaining (Rs)', (record.remainingPaisa / 100).toFixed(2)],
              ['Explanation', record.note],
              [],
              [
                'Payment date',
                'Kind',
                'Amount (Rs)',
                'Method',
                'Funds',
                'Reference',
                'Recorded by',
                'Note',
              ],
              ...record.payments.map((payment) => [
                payment.businessDate,
                payment.kind,
                (payment.amountPaisa / 100).toFixed(2),
                payment.method,
                payment.cashMovementId ? 'Drawer' : 'External',
                payment.reference,
                payment.paidBy,
                payment.note,
              ]),
            ])
          }
        >
          Export salary statement
        </Button>
      </div>
      <section>
        <h3 className="mb-2 font-bold">Payment history</h3>
        {record.payments.length === 0 ? (
          <p className="text-muted text-body">No payments recorded.</p>
        ) : (
          <ul className="space-y-2">
            {record.payments.map((payment) => (
              <li key={payment.id} className="border-border rounded-card border p-3 text-body">
                <p className="font-semibold">
                  {payment.kind === 'ADVANCE' ? 'Advance' : 'Salary'} ·{' '}
                  {formatPaisa(payment.amountPaisa)} · {payment.method} · {payment.businessDate}
                </p>
                <p className="text-muted mt-1 text-caption">
                  {payment.paidBy} · {payment.cashMovementId ? 'Cash drawer' : 'External funds'}
                  {payment.reference ? ` · ${payment.reference}` : ''} · {payment.note}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>
      <details className="text-body">
        <summary className="cursor-pointer font-bold">Payroll change history</summary>
        <ul className="mt-3 space-y-3">
          {record.audits.map((audit) => {
            const after = JSON.parse(audit.afterJson) as {
              baseSalaryPaisa: number;
              allowancesPaisa: number;
              deductionsPaisa: number;
            };
            return (
              <li key={audit.id} className="border-border rounded-card border p-3">
                <p className="font-semibold">
                  {audit.kind.toLowerCase()} · {new Date(audit.at).toLocaleString()} · {audit.actor}
                </p>
                <p className="mt-1">{audit.note}</p>
                <p className="text-muted mt-1 text-caption">
                  Base {formatPaisa(after.baseSalaryPaisa)} · Allowances{' '}
                  {formatPaisa(after.allowancesPaisa)} · Deductions{' '}
                  {formatPaisa(after.deductionsPaisa)}
                </p>
              </li>
            );
          })}
        </ul>
      </details>
    </section>
  );
}
function Money({
  label,
  aria,
  value,
  change,
}: {
  label: string;
  aria: string;
  value: string;
  change: (value: string) => void;
}): JSX.Element {
  return (
    <label className="text-body">
      {label}
      <input
        aria-label={aria}
        className={`${fieldClass} mt-1 block w-full`}
        type="number"
        min="0"
        max="10000000"
        step="0.01"
        required
        value={value}
        onChange={(event) => change(event.target.value)}
      />
    </label>
  );
}
function PaymentForm({
  record,
  today,
  busy,
  run,
}: {
  record: PayrollRecordDto;
  today: string;
  busy: boolean;
  run: Run;
}): JSX.Element {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('CASH');
  const [drawer, setDrawer] = useState('EXTERNAL');
  const [date, setDate] = useState(today);
  const [note, setNote] = useState('');
  const [reference, setReference] = useState('');
  const paisa = parseRupees(amount);
  return (
    <form
      className="border-border rounded-card border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (
          paisa !== null &&
          paisa > 0 &&
          paisa <= record.remainingPaisa &&
          note.trim().length >= 3
        )
          void run(`/payroll/records/${record.id}/payments`, {
            expectedVersion: record.version,
            kind: record.status === 'DRAFT' ? 'ADVANCE' : 'SALARY',
            amountPaisa: paisa,
            method,
            drawer: method === 'CASH' ? drawer : 'EXTERNAL',
            businessDate: date,
            note: note.trim(),
            ...(reference.trim() ? { reference: reference.trim() } : {}),
          });
      }}
    >
      <h3 className="mb-2 font-bold">
        {record.status === 'DRAFT' ? 'Record an advance' : 'Record a salary payment'}
      </h3>
      <p className="text-muted mb-3 text-caption">
        Each payment creates one Payroll expense automatically. Do not enter it again in Expenses.
        Payment records are permanent; check the amount, method and date before recording.
      </p>
      <fieldset disabled={busy} className="grid gap-3 sm:grid-cols-2">
        <label className="text-body">
          Amount (₨)
          <input
            aria-label="Payroll payment amount"
            className={`${fieldClass} mt-1 block w-full`}
            type="number"
            min="0.01"
            max={record.remainingPaisa / 100}
            step="0.01"
            required
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
          />
        </label>
        <label className="text-body">
          Method
          <select
            aria-label="Payroll payment method"
            className={`${fieldClass} mt-1 block w-full`}
            value={method}
            onChange={(event) => setMethod(event.target.value)}
          >
            <option value="CASH">Cash</option>
            <option value="QR">QR</option>
            <option value="CARD">Card</option>
          </select>
        </label>
        {method === 'CASH' && (
          <label className="text-body">
            Cash source
            <select
              aria-label="Payroll cash source"
              className={`${fieldClass} mt-1 block w-full`}
              value={drawer}
              onChange={(event) => setDrawer(event.target.value)}
            >
              <option value="EXTERNAL">External funds</option>
              <option value="NEW">Pay from the open cash drawer</option>
            </select>
          </label>
        )}
        <label className="text-body">
          Payment date
          <input
            aria-label="Payroll payment date"
            className={`${fieldClass} mt-1 block w-full`}
            type="date"
            required
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </label>
        <label className="text-body">
          Reference (optional)
          <input
            aria-label="Payroll payment reference"
            className={`${fieldClass} mt-1 block w-full`}
            maxLength={80}
            value={reference}
            onChange={(event) => setReference(event.target.value)}
          />
        </label>
        <label className="text-body">
          Payment note
          <input
            aria-label="Payroll payment note"
            className={`${fieldClass} mt-1 block w-full`}
            minLength={3}
            maxLength={300}
            required
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
        </label>
        {method === 'CASH' && drawer === 'NEW' && (
          <p className="text-muted text-caption sm:col-span-2">
            Drawer payments must use the current business date and require enough cash in the open
            drawer.
          </p>
        )}
        <Button
          type="submit"
          disabled={
            busy ||
            paisa === null ||
            paisa <= 0 ||
            paisa > record.remainingPaisa ||
            note.trim().length < 3
          }
        >
          {record.status === 'DRAFT' ? 'Record advance' : 'Record salary payment'}
        </Button>
      </fieldset>
    </form>
  );
}
