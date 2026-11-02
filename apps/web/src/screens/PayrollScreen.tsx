import { useState, type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BadgeCheck, Banknote, CalendarRange, Download, Hourglass, UsersRound } from 'lucide-react';
import type { PayrollOverview, PayrollRecordDto, PayrollStaffDto } from '@nayaro/shared';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { apiClient } from '@/services/apiClient';
import { useOperation } from '@/features/operations/useOperation';
import { exportCsv } from '@/features/operations/files';
import { formatPaisa, formatRupees, parseRupees } from '@/lib/money';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Field, Input } from '@/components/ui/Field';
import { StatCard } from '@/components/ui/StatCard';
import { EmptyState, ErrorState, InlineAlert, LoadingState } from '@/components/ui/States';
import { PayrollDetail } from '@/features/payroll/PayrollDetail';
import { Page, PageBody, PageHeader } from '@/components/layout/Page';

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

function RecordBadge({ record }: { record: PayrollRecordDto | undefined }): JSX.Element {
  if (!record) return <Badge>No draft</Badge>;
  if (record.settled) return <Badge tone="success">Settled</Badge>;
  if (record.status === 'DRAFT') return <Badge tone="warning">Draft</Badge>;
  return <Badge tone="accent">Approved</Badge>;
}

export function PayrollScreen(): JSX.Element {
  const { staff } = useAuth();
  const allowed = staff?.role === 'OWNER';
  const [month, setMonth] = useState('');
  const [staffId, setStaffId] = useState('');
  const action = useOperation();
  const payroll = useQuery({
    queryKey: ['payroll', month],
    queryFn: () => apiClient.get<PayrollOverview>(month ? `/payroll?month=${encodeURIComponent(month)}` : '/payroll'),
    enabled: allowed,
    refetchInterval: 15_000,
  });

  if (payroll.isPending) {
    return (
      <Page>
        <LoadingState label="Loading payroll…" />
      </Page>
    );
  }
  const data = payroll.data;
  if (!data) {
    return (
      <Page>
        <PageHeader title="Payroll" />
        <Card>
          <ErrorState error={payroll.error} onRetry={() => void payroll.refetch()} />
        </Card>
      </Page>
    );
  }

  const person = data.staff.find((row) => row.id === staffId) ?? data.staff[0];
  const recordFor = (id: string): PayrollRecordDto | undefined => data.records.find((row) => row.staffId === id);
  const selected = person ? recordFor(person.id) : undefined;
  const withSalary = data.staff.filter((row) => row.monthlySalaryPaisa !== null).length;

  return (
    <Page>
      <PageHeader
        title="Payroll"
        description="Monthly salaries, advances and payments. Amounts, allowances and deductions are entered by the owner."
        actions={
          <>
            <label className="border-border-2 bg-surface flex h-10 items-center gap-2 rounded-control border pl-3">
              <CalendarRange size={16} className="text-muted" aria-hidden />
              <span className="sr-only">Payroll month</span>
              <input
                aria-label="Payroll month"
                type="month"
                value={month || data.month}
                min="2000-01"
                max="2199-12"
                onChange={(event) => setMonth(event.target.value)}
                className="h-full bg-transparent pr-3 text-body font-semibold outline-none"
              />
            </label>
            <Button
              variant="secondary"
              icon={Download}
              disabled={data.records.length === 0}
              onClick={() =>
                exportCsv(`payroll-${data.month}.csv`, [
                  ['Staff', 'Month', 'Status', 'Base salary (Rs)', 'Allowances (Rs)', 'Deductions (Rs)', 'Net salary (Rs)', 'Advances paid (Rs)', 'Total paid (Rs)', 'Remaining (Rs)', 'Note'],
                  ...data.records.map((row) => [
                    row.staffName,
                    row.month,
                    row.settled ? 'SETTLED' : row.status,
                    (row.baseSalaryPaisa / 100).toFixed(2),
                    (row.allowancesPaisa / 100).toFixed(2),
                    (row.deductionsPaisa / 100).toFixed(2),
                    (row.netSalaryPaisa / 100).toFixed(2),
                    (row.advancePaisa / 100).toFixed(2),
                    (row.paidPaisa / 100).toFixed(2),
                    (row.remainingPaisa / 100).toFixed(2),
                    row.note,
                  ]),
                ])
              }
            >
              Export CSV
            </Button>
          </>
        }
      />
      <PageBody>
        {payroll.isError && <InlineAlert tone="warning">Could not refresh payroll. Refresh before recording changes or payments.</InlineAlert>}
        {action.error && <InlineAlert>{action.error}</InlineAlert>}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label="Staff with a salary"
            icon={UsersRound}
            value={
              <>
                {withSalary}
                <span className="text-muted-3 text-heading"> / {data.staff.length}</span>
              </>
            }
          />
          <StatCard label="Approved net salary" icon={BadgeCheck} tone="accent" value={formatRupees(data.totals.approvedNetPaisa)} />
          <StatCard label="Paid, incl. advances" icon={Banknote} value={formatRupees(data.totals.paidPaisa)} />
          <StatCard
            label="Still to pay"
            icon={Hourglass}
            tone={data.totals.approvedRemainingPaisa > 0 ? 'warning' : 'default'}
            value={formatRupees(data.totals.approvedRemainingPaisa)}
          />
        </div>

        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[340px_1fr] lg:items-start">
          <Card className="overflow-hidden">
            <CardHeader title="Team" description={`Payroll for ${data.month}`} />
            {data.staff.length === 0 ? (
              <EmptyState icon={UsersRound} title="No staff yet" className="py-8" />
            ) : (
              <ul className="divide-border border-border divide-y border-t">
                {data.staff.map((row) => {
                  const record = recordFor(row.id);
                  return (
                    <li key={row.id}>
                      <button
                        type="button"
                        onClick={() => setStaffId(row.id)}
                        className={cn(
                          'flex w-full items-center gap-3 px-5 py-3 text-left transition-colors',
                          row.id === person?.id ? 'bg-accent-soft' : 'hover:bg-surface-2',
                        )}
                      >
                        <span
                          className={cn(
                            'grid size-10 shrink-0 place-items-center rounded-full text-caption font-extrabold',
                            row.isActive ? 'bg-accent text-white' : 'bg-neutral-tint text-muted',
                          )}
                        >
                          {initials(row.name)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-bold">
                            {row.name}
                            {!row.isActive && <span className="text-muted font-semibold"> · inactive</span>}
                          </span>
                          <span className="text-muted font-mono text-caption">
                            {row.monthlySalaryPaisa === null ? 'No salary set' : `${formatPaisa(row.monthlySalaryPaisa)} / month`}
                          </span>
                        </span>
                        <RecordBadge record={record} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          <div className="flex min-w-0 flex-col gap-5">
            {person && (
              <Card>
                <CardHeader
                  title={person.name}
                  description="Salary settings apply to new monthly drafts. Existing payroll keeps its saved amounts."
                  actions={<RecordBadge record={selected} />}
                />
                <CardBody className="space-y-4">
                  <SalaryForm
                    key={`${person.id}:${person.profileVersion}`}
                    person={person}
                    busy={action.busy}
                    save={(value) => {
                      void action.run(`/payroll/profiles/${person.id}`, {
                        monthlySalaryPaisa: value,
                        expectedVersion: person.profileVersion,
                      });
                    }}
                  />
                  {!selected && (
                    <div className="bg-surface-3 border-border flex flex-wrap items-center gap-3 rounded-card border p-4">
                      <p className="text-muted min-w-0 flex-1 text-body">
                        {person.profileVersion === null
                          ? 'Save a monthly salary first, then create this month’s draft.'
                          : `No payroll yet for ${data.month}. Create a draft to add allowances, deductions and advances.`}
                      </p>
                      <Button
                        disabled={action.busy || person.profileVersion === null}
                        onClick={() =>
                          void action.run<PayrollRecordDto>('/payroll/records', {
                            staffId: person.id,
                            month: data.month,
                            expectedProfileVersion: person.profileVersion,
                          })
                        }
                      >
                        Create monthly draft
                      </Button>
                    </div>
                  )}
                </CardBody>
              </Card>
            )}
            {selected && (
              <PayrollDetail
                key={`${selected.id}:${selected.version}`}
                record={selected}
                today={data.currentBusinessDate}
                busy={action.busy}
                run={action.run}
              />
            )}
          </div>
        </div>
      </PageBody>
    </Page>
  );
}

function SalaryForm({
  person,
  busy,
  save,
}: {
  person: PayrollStaffDto;
  busy: boolean;
  save: (paisa: number) => void;
}): JSX.Element {
  const [amount, setAmount] = useState(person.monthlySalaryPaisa === null ? '' : (person.monthlySalaryPaisa / 100).toFixed(2));
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const value = parseRupees(amount);
        if (value !== null && value <= 1_000_000_000) save(value);
      }}
    >
      <Field label="Monthly base salary (Rs)" className="w-56">
        {({ id }) => (
          <Input
            id={id}
            type="number"
            min="0"
            max="10000000"
            step="0.01"
            value={amount}
            disabled={busy}
            onChange={(event) => setAmount(event.target.value)}
            className="font-mono"
          />
        )}
      </Field>
      <Button type="submit" variant="secondary" disabled={busy || !amount.trim()}>
        Save salary
      </Button>
    </form>
  );
}
