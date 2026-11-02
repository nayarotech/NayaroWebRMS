import { useState, type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Banknote,
  Download,
  FileText,
  Paperclip,
  Plus,
  ReceiptText,
  RotateCcw,
  Scale,
  WalletCards,
} from 'lucide-react';
import type { ExpenseSummaryDto, ReceiptAttachment, CurrentShiftResponse } from '@nayaro/shared';
import { apiClient } from '@/services/apiClient';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { useOperation } from '@/features/operations/useOperation';
import { download, exportCsv } from '@/features/operations/files';
import { formatPaisa, formatRupees, parseRupees } from '@/lib/money';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { Drawer } from '@/components/ui/Drawer';
import { Field, Input, Select } from '@/components/ui/Field';
import { StatCard } from '@/components/ui/StatCard';
import { EmptyState, ErrorState, InlineAlert } from '@/components/ui/States';
import { RankedBars } from '@/components/charts/BarChart';
import { Page, PageBody, PageHeader } from '@/components/layout/Page';
import { cn } from '@/lib/utils';

const CATEGORIES = ['Ingredients', 'Rent', 'Utilities', 'Wages', 'Maintenance', 'Other'];

function monthRange(offset: number): { from: string; to: string } {
  const now = new Date();
  const start = new Date(Date.UTC(now.getFullYear(), now.getMonth() + offset, 1));
  const end = new Date(Date.UTC(now.getFullYear(), now.getMonth() + offset + 1, 0));
  return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
}

export function ExpensesScreen(): JSX.Element {
  const { staff } = useAuth();
  const allowed = staff?.role === 'OWNER' || staff?.role === 'MANAGER';
  const action = useOperation();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [recording, setRecording] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const query = new URLSearchParams();
  if (from) query.set('from', from);
  if (to) query.set('to', to);
  const summary = useQuery({
    queryKey: ['expenses', from, to],
    queryFn: () => apiClient.get<ExpenseSummaryDto>(`/expenses?${query}`),
    enabled: allowed,
    refetchInterval: 15000,
  });
  const data = summary.data;

  const setPeriod = (range: { from: string; to: string }): void => {
    setFrom(range.from);
    setTo(range.to);
  };
  const thisMonth = monthRange(0);
  const lastMonth = monthRange(-1);
  const activePreset =
    from === thisMonth.from && to === thisMonth.to
      ? 'this'
      : from === lastMonth.from && to === lastMonth.to
        ? 'last'
        : null;

  const exportRows = (): void => {
    if (!data) return;
    exportCsv(`expenses-${data.from}-${data.to}.csv`, [
      ['Date', 'Category', 'Supplier', 'Amount (Rs)', 'Method', 'Note', 'Staff', 'Drawer payout', 'Receipt'],
      ...data.expenses.map((row) => [
        row.businessDate,
        row.category,
        row.supplier,
        (row.amountPaisa / 100).toFixed(2),
        row.method,
        row.note,
        row.staff.name,
        row.cashMovementId,
        row.receiptName,
      ]),
    ]);
  };

  return (
    <Page>
      <PageHeader
        title="Expenses"
        description="Spending by category and supplier, compared with sales for the same period."
        actions={
          <>
            <Button variant="secondary" icon={Download} disabled={!data} onClick={exportRows}>
              Export CSV
            </Button>
            <Button icon={Plus} onClick={() => setRecording(true)}>
              Record expense
            </Button>
          </>
        }
      />
      <PageBody>
        <Card className="flex flex-wrap items-end gap-3 p-4">
          <div className="flex flex-wrap gap-2">
            {(
              [
                ['this', 'This month', thisMonth],
                ['last', 'Last month', lastMonth],
              ] as const
            ).map(([key, label, range]) => (
              <button
                key={key}
                type="button"
                aria-pressed={activePreset === key}
                onClick={() => setPeriod(range)}
                className={cn(
                  'h-10 rounded-full border px-4 text-caption font-bold transition-colors',
                  activePreset === key
                    ? 'border-accent bg-accent text-white'
                    : 'border-border-2 bg-surface text-text-2 hover:border-border-4',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <Field label="From" className="w-44">
            {({ id }) => (
              <Input id={id} type="date" value={from || data?.from || ''} onChange={(event) => setFrom(event.target.value)} />
            )}
          </Field>
          <Field label="To" className="w-44">
            {({ id }) => (
              <Input id={id} type="date" value={to || data?.to || ''} onChange={(event) => setTo(event.target.value)} />
            )}
          </Field>
          {data && (
            <p className="text-muted ml-auto text-caption">
              Showing {data.from} to {data.to}
            </p>
          )}
        </Card>

        {summary.isError && !data ? (
          <Card>
            <ErrorState error={summary.error} onRetry={() => void summary.refetch()} />
          </Card>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="Sales" icon={Banknote} tone="accent" value={formatRupees(data?.salesPaisa ?? 0)} />
              <StatCard label="Refunds" icon={RotateCcw} value={formatRupees(data?.refundsPaisa ?? 0)} />
              <StatCard
                label="Recorded expenses"
                icon={WalletCards}
                tone="warning"
                value={formatRupees(data?.totalPaisa ?? 0)}
                detail={`${String(data?.expenses.length ?? 0)} entries`}
              />
              <StatCard
                label="Sales less refunds & expenses"
                icon={Scale}
                tone={(data?.salesLessRefundsAndExpensesPaisa ?? 0) < 0 ? 'danger' : 'default'}
                value={formatRupees(data?.salesLessRefundsAndExpensesPaisa ?? 0)}
                detail="Recorded amounts only, not a full profit figure"
              />
            </div>

            {fileError && <InlineAlert onDismiss={() => setFileError(null)}>{fileError}</InlineAlert>}

            <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
              <Card>
                <CardHeader title="By category" description="Where the money went in this period." />
                <CardBody>
                  {(data?.byCategory.length ?? 0) === 0 ? (
                    <EmptyState icon={WalletCards} title="No expenses yet" className="py-8" />
                  ) : (
                    <RankedBars
                      formatValue={formatRupees}
                      rows={[...(data?.byCategory ?? [])]
                        .sort((left, right) => right.amountPaisa - left.amountPaisa)
                        .map((row) => ({
                          key: row.category,
                          label: row.category,
                          value: row.amountPaisa,
                          note:
                            data && data.totalPaisa > 0
                              ? `${String(Math.round((row.amountPaisa / data.totalPaisa) * 100))}%`
                              : undefined,
                        }))}
                    />
                  )}
                </CardBody>
              </Card>

              <div className="xl:col-span-2">
                <DataTable
                  rows={data?.expenses ?? []}
                  loading={summary.isPending}
                  getRowId={(row) => row.id}
                  searchText={(row) => `${row.category} ${row.supplier ?? ''} ${row.note} ${row.staff.name}`}
                  searchPlaceholder="Search expenses"
                  pageSize={10}
                  initialSort={{ key: 'date', direction: 'desc' }}
                  empty={{
                    icon: ReceiptText,
                    title: 'No expenses in this period',
                    description: 'Record rent, utilities, supplies and wages to compare them with sales.',
                    action: (
                      <Button icon={Plus} onClick={() => setRecording(true)}>
                        Record expense
                      </Button>
                    ),
                  }}
                  columns={[
                    {
                      key: 'date',
                      header: 'Date',
                      sortValue: (row) => `${row.businessDate} ${row.createdAt}`,
                      cell: (row) => <span className="whitespace-nowrap">{row.businessDate}</span>,
                    },
                    {
                      key: 'category',
                      header: 'Expense',
                      sortValue: (row) => row.category,
                      cell: (row) => (
                        <div className="min-w-0">
                          <p className="font-bold">{row.note}</p>
                          <p className="text-muted text-caption">
                            {row.category}
                            {row.supplier ? ` · ${row.supplier}` : ''}
                          </p>
                        </div>
                      ),
                    },
                    {
                      key: 'method',
                      header: 'Paid by',
                      hideBelow: 'md',
                      cell: (row) => (
                        <div className="flex flex-col items-start gap-1">
                          <Badge tone={row.method === 'CASH' ? 'warning' : 'accent'}>{row.method}</Badge>
                          {row.cashMovementId && <span className="text-muted text-caption">From drawer</span>}
                        </div>
                      ),
                    },
                    {
                      key: 'staff',
                      header: 'Recorded by',
                      hideBelow: 'lg',
                      cell: (row) => (
                        <div>
                          <p>{row.staff.name}</p>
                          <p className="text-muted text-caption">{new Date(row.createdAt).toLocaleString()}</p>
                        </div>
                      ),
                    },
                    {
                      key: 'amount',
                      header: 'Amount',
                      align: 'right',
                      className: 'font-mono font-semibold tabular-nums whitespace-nowrap',
                      sortValue: (row) => row.amountPaisa,
                      cell: (row) => formatPaisa(row.amountPaisa),
                    },
                    {
                      key: 'receipt',
                      header: '',
                      align: 'right',
                      cell: (row) =>
                        row.receiptName ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={FileText}
                            title={row.receiptName}
                            onClick={async () => {
                              try {
                                const receipt = await apiClient.get<ReceiptAttachment>(`/expenses/${row.id}/receipt`);
                                const bytes = Uint8Array.from(atob(receipt.base64), (character) =>
                                  character.charCodeAt(0),
                                );
                                download(receipt.name, new Blob([bytes], { type: receipt.mime }));
                              } catch {
                                setFileError('Could not download the receipt. Refresh and try again.');
                              }
                            }}
                          >
                            Receipt
                          </Button>
                        ) : null,
                    },
                  ]}
                />
              </div>
            </div>
          </>
        )}
      </PageBody>

      <RecordExpenseDrawer
        open={recording}
        defaultDate={data?.currentBusinessDate ?? ''}
        action={action}
        onClose={() => setRecording(false)}
      />
    </Page>
  );
}

function RecordExpenseDrawer({
  open,
  defaultDate,
  action,
  onClose,
}: {
  open: boolean;
  defaultDate: string;
  action: ReturnType<typeof useOperation>;
  onClose: () => void;
}): JSX.Element {
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('Ingredients');
  const [supplier, setSupplier] = useState('');
  const [note, setNote] = useState('');
  const [date, setDate] = useState('');
  const [method, setMethod] = useState('CASH');
  const [drawer, setDrawer] = useState('EXTERNAL');
  const [movement, setMovement] = useState('');
  const [receipt, setReceipt] = useState<ReceiptAttachment | undefined>();
  const [fileBusy, setFileBusy] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const shift = useQuery({
    queryKey: ['shift'],
    queryFn: () => apiClient.get<CurrentShiftResponse>('/shifts/current'),
    enabled: open,
  });
  const paisa = parseRupees(amount);
  const recordDate = date || defaultDate;
  const canSubmit =
    !action.busy && !fileBusy && paisa !== null && paisa > 0 && !fileError && note.trim().length >= 3 && recordDate !== '';

  const submit = async (): Promise<void> => {
    if (!canSubmit || paisa === null) return;
    const result = await action.run('/expenses', {
      amountPaisa: paisa,
      category,
      supplier,
      note,
      businessDate: recordDate,
      method,
      drawer,
      ...(drawer === 'LINK' ? { cashMovementId: movement } : {}),
      ...(receipt ? { receipt } : {}),
    });
    if (result) {
      setAmount('');
      setNote('');
      setSupplier('');
      setReceipt(undefined);
      onClose();
    }
  };

  return (
    <Drawer
      open={open}
      title="Record expense"
      description="Expenses are permanent records. Check the amount and method before saving."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={action.busy} disabled={!canSubmit} onClick={() => void submit()}>
            Save expense
          </Button>
        </>
      }
    >
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Amount (Rs)">
            {({ id }) => (
              <Input
                id={id}
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                className="font-mono"
              />
            )}
          </Field>
          <Field label="Business date">
            {({ id }) => <Input id={id} type="date" value={recordDate} onChange={(event) => setDate(event.target.value)} />}
          </Field>
        </div>

        <div>
          <p className="text-text-3 mb-1.5 text-caption font-bold">Category</p>
          <div className="flex flex-wrap gap-2">
            {CATEGORIES.map((name) => (
              <button
                key={name}
                type="button"
                aria-pressed={category === name}
                onClick={() => setCategory(name)}
                className={cn(
                  'rounded-full border px-3.5 py-1.5 text-caption font-bold transition-colors',
                  category === name
                    ? 'border-accent bg-accent text-white'
                    : 'border-border-2 bg-surface text-text-2 hover:border-border-4',
                )}
              >
                {name}
              </button>
            ))}
          </div>
        </div>

        <Field label="Description" hint="At least 3 characters, e.g. “Weekly vegetables”.">
          {({ id, describedBy }) => (
            <Input id={id} aria-describedby={describedBy} maxLength={300} value={note} onChange={(event) => setNote(event.target.value)} />
          )}
        </Field>
        <Field label="Supplier (optional)">
          {({ id }) => <Input id={id} maxLength={160} value={supplier} onChange={(event) => setSupplier(event.target.value)} />}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Payment method">
            {({ id }) => (
              <Select
                id={id}
                value={method}
                onChange={(event) => {
                  setMethod(event.target.value);
                  setDrawer('EXTERNAL');
                }}
              >
                <option value="CASH">Cash</option>
                <option value="QR">QR / wallet</option>
                <option value="CARD">Card</option>
              </Select>
            )}
          </Field>
          <Field label="Paid from">
            {({ id }) => (
              <Select id={id} value={drawer} onChange={(event) => setDrawer(event.target.value)}>
                <option value="EXTERNAL">Outside the till</option>
                {method === 'CASH' && (
                  <>
                    <option value="NEW">Cash drawer (new payout)</option>
                    <option value="LINK">Link an existing payout</option>
                  </>
                )}
              </Select>
            )}
          </Field>
        </div>

        {drawer === 'LINK' && (
          <Field label="Drawer payout">
            {({ id }) => (
              <Select id={id} value={movement} onChange={(event) => setMovement(event.target.value)}>
                <option value="">Choose a payout…</option>
                {shift.data?.shift?.movements
                  .filter((row) => row.type === 'PAY_OUT')
                  .map((row) => (
                    <option key={row.id} value={row.id}>
                      {formatPaisa(row.amountPaisa)} · {row.reason}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
        )}

        <div>
          <p className="text-text-3 mb-1.5 text-caption font-bold">Receipt (optional)</p>
          <label
            className={cn(
              'border-border-3 hover:border-accent hover:bg-accent-soft flex cursor-pointer items-center gap-3 rounded-card border border-dashed px-4 py-3.5 transition-colors',
              (fileBusy || action.busy) && 'pointer-events-none opacity-60',
            )}
          >
            <Paperclip size={18} className="text-muted" aria-hidden />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-bold">{receipt ? receipt.name : 'Attach a photo or PDF'}</span>
              <span className="text-muted text-caption">PNG, JPEG or PDF, up to 2 MB</span>
            </span>
            <input
              type="file"
              className="sr-only"
              accept="image/png,image/jpeg,application/pdf"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                setReceipt(undefined);
                setFileError(null);
                if (!file) return;
                if (file.size > 2097152 || !['image/png', 'image/jpeg', 'application/pdf'].includes(file.type)) {
                  setFileError('Choose a PNG, JPEG or PDF up to 2 MB.');
                  return;
                }
                setFileBusy(true);
                try {
                  const base64 = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(String(reader.result).split(',')[1]!);
                    reader.onerror = () => reject(new Error('Could not read receipt.'));
                    reader.readAsDataURL(file);
                  });
                  setReceipt({ name: file.name, mime: file.type as ReceiptAttachment['mime'], base64 });
                } catch {
                  setFileError('Could not read the receipt. Select it again.');
                } finally {
                  setFileBusy(false);
                }
              }}
            />
          </label>
        </div>

        {(fileError || action.error) && <InlineAlert>{fileError || action.error}</InlineAlert>}
      </form>
    </Drawer>
  );
}
