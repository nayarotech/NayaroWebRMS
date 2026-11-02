import { useState, type JSX } from 'react';
import { useNavigate } from 'react-router';
import { ShieldCheck } from 'lucide-react';
import type { DailyReportResponse } from '@nayaro/shared';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/States';
import { cn } from '@/lib/utils';
import { formatPaisa } from '@/lib/money';
import { formatTime } from '@/lib/dates';
import { METHOD_LABEL } from './ReportParts';

type Kind = 'discount' | 'voidBill' | 'voidPayment' | 'cancelItem' | 'voidTicket';

const KINDS: readonly { readonly kind: Kind; readonly label: string; readonly tone: BadgeTone }[] = [
  { kind: 'discount', label: 'Discounts', tone: 'accent' },
  { kind: 'voidBill', label: 'Voided bills', tone: 'danger' },
  { kind: 'voidPayment', label: 'Reversed payments', tone: 'danger' },
  { kind: 'cancelItem', label: 'Cancelled items', tone: 'warning' },
  { kind: 'voidTicket', label: 'Voided tickets', tone: 'neutral' },
];

const SINGULAR: Record<Kind, string> = {
  discount: 'Discount',
  voidBill: 'Void',
  voidPayment: 'Reversal',
  cancelItem: 'Cancelled',
  voidTicket: 'KOT void',
};

interface Entry {
  readonly key: string;
  readonly kind: Kind;
  readonly what: string;
  readonly why: string | null;
  readonly who: string;
  readonly at: string | null;
  readonly amountPaisa: number | null;
  readonly orderId?: string;
}

/**
 * Everything that reduced what a customer paid or undid something already
 * done, in one list. This is where money leaks from a restaurant, so it gets a
 * headline total and a filter rather than five small paragraphs.
 */
export function AuditTrail({ report }: { readonly report: DailyReportResponse }): JSX.Element {
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Kind | 'all'>('all');
  const { discounts, corrections } = report;

  const entries: Entry[] = [
    ...discounts.rows.map((d) => ({
      key: `d:${d.fiscalYearLabel}-${String(d.invoiceNumber)}`,
      kind: 'discount' as const,
      what: `Bill #${String(d.invoiceNumber)}`,
      why: null,
      who: d.approvedBy === null ? 'No approval recorded' : `Approved by ${d.approvedBy.name}`,
      at: null,
      amountPaisa: d.amountPaisa,
      orderId: d.orderId,
    })),
    ...corrections.voidedInvoices.map((v) => ({
      key: `vb:${v.fiscalYearLabel}-${String(v.invoiceNumber)}`,
      kind: 'voidBill' as const,
      what: `Bill #${String(v.invoiceNumber)}`,
      why: v.reason,
      who: v.voidedBy.name,
      at: v.voidedAt,
      amountPaisa: v.grandTotalPaisa,
      orderId: v.orderId,
    })),
    ...corrections.voidedPayments.map((v, index) => ({
      key: `vp:${String(v.invoiceNumber)}-${String(index)}`,
      kind: 'voidPayment' as const,
      what: `${METHOD_LABEL[v.method]} on bill #${String(v.invoiceNumber)}`,
      why: v.reason,
      who: v.voidedBy.name,
      at: v.voidedAt,
      amountPaisa: v.amountPaisa,
    })),
    ...corrections.cancelledItems.map((c, index) => ({
      key: `ci:${String(c.orderNumber)}-${String(index)}`,
      kind: 'cancelItem' as const,
      what: `${String(c.quantity)} × ${c.name} · order #${String(c.orderNumber)}`,
      why: c.reason,
      who: c.cancelledBy.name,
      at: c.cancelledAt,
      amountPaisa: c.valuePaisa,
    })),
    ...corrections.voidedTickets.map((t) => ({
      key: `vt:${String(t.orderNumber)}-${String(t.kotNumber)}`,
      kind: 'voidTicket' as const,
      what: `KOT #${String(t.kotNumber)} · order #${String(t.orderNumber)}`,
      why: t.reason,
      who: t.voidedBy.name,
      at: t.voidedAt,
      amountPaisa: null,
    })),
  ];

  const count = (kind: Kind): number => entries.filter((entry) => entry.kind === kind).length;
  const sum = (kind: Kind): number =>
    entries.filter((entry) => entry.kind === kind).reduce((total, entry) => total + (entry.amountPaisa ?? 0), 0);
  // What the day could have taken but did not. A voided bill is often reissued,
  // so this is what to look into, not a loss. Reversed payments stay out: the
  // bill is still owed.
  const atRisk = sum('discount') + sum('voidBill') + sum('cancelItem');
  const shown = filter === 'all' ? entries : entries.filter((entry) => entry.kind === filter);

  return (
    <Card>
      <CardHeader
        title="Discounts & corrections"
        description="Everything that reduced what a customer paid, or undid something already done."
        actions={
          entries.length > 0 ? (
            <div className="text-right">
              <p className="text-muted-2 text-overline font-bold tracking-wider uppercase">Value at risk</p>
              <p className="text-danger-fg font-mono text-heading font-extrabold tabular-nums">
                {formatPaisa(atRisk)}
              </p>
            </div>
          ) : undefined
        }
      />
      {entries.length === 0 ? (
        <EmptyState
          icon={ShieldCheck}
          title="A clean day"
          description="No discounts, voids, reversals or cancellations."
          className="py-10"
        />
      ) : (
        <CardBody>
          <div role="radiogroup" aria-label="Filter corrections" className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
            <FilterTile
              label="All"
              count={entries.length}
              selected={filter === 'all'}
              onSelect={() => {
                setFilter('all');
              }}
            />
            {KINDS.map(({ kind, label }) => (
              <FilterTile
                key={kind}
                label={label}
                count={count(kind)}
                amount={kind === 'voidTicket' ? undefined : sum(kind)}
                selected={filter === kind}
                onSelect={() => {
                  setFilter(kind);
                }}
              />
            ))}
          </div>

          {shown.length === 0 ? (
            <p className="text-muted-3 py-6 text-center text-body">None of these on this day.</p>
          ) : (
            <ul className="divide-border border-border divide-y rounded-control border">
              {shown.map((entry) => {
                const meta = KINDS.find((k) => k.kind === entry.kind)!;
                return (
                  <li key={entry.key} className="flex items-start gap-3 px-4 py-3">
                    <Badge tone={meta.tone} className="mt-0.5 w-[5.5rem] justify-center">
                      {SINGULAR[entry.kind]}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <p className="text-body font-semibold">
                        {entry.orderId === undefined ? (
                          entry.what
                        ) : (
                          <button
                            type="button"
                            onClick={() => void navigate(`/billing/${entry.orderId!}`)}
                            className="text-accent-hover underline-offset-2 hover:underline"
                          >
                            {entry.what}
                          </button>
                        )}
                      </p>
                      <p className="text-muted text-caption">
                        {entry.why !== null && <span className="text-text-3">“{entry.why}” · </span>}
                        {entry.who}
                        {entry.at !== null && ` · ${formatTime(entry.at)}`}
                      </p>
                    </div>
                    {entry.amountPaisa !== null && (
                      <span className="font-mono text-body tabular-nums">{formatPaisa(entry.amountPaisa)}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      )}
    </Card>
  );
}

function FilterTile({
  label,
  count,
  amount,
  selected,
  onSelect,
}: {
  readonly label: string;
  readonly count: number;
  readonly amount?: number;
  readonly selected: boolean;
  readonly onSelect: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        'rounded-control border px-3 py-2 text-left transition-colors',
        selected ? 'border-accent bg-accent-soft' : 'border-border hover:border-border-4',
        count === 0 && !selected && 'opacity-55',
      )}
    >
      <p className="text-muted truncate text-caption font-semibold">{label}</p>
      <p className="flex items-baseline gap-1.5">
        <span className="text-heading font-extrabold tabular-nums">{count}</span>
        {amount !== undefined && amount > 0 && (
          <span className="text-muted-2 truncate font-mono text-caption tabular-nums">{formatPaisa(amount)}</span>
        )}
      </p>
    </button>
  );
}
