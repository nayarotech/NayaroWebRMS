import type { JSX } from 'react';
import { ArrowDownLeft, ArrowUpRight } from 'lucide-react';
import type { ShiftDto } from '@nayaro/shared';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/utils';
import { formatPaisa } from '@/lib/money';
import { formatTime } from '@/lib/dates';
import { MoneyRow } from './ReportParts';

/**
 * One drawer session. Expected against counted is the headline - that gap is
 * the number an owner checks every night - with the arithmetic underneath.
 */
export function ShiftSummary({ shift }: { readonly shift: ShiftDto }): JSX.Element {
  const { close } = shift;
  const variance = close?.variancePaisa ?? 0;

  return (
    <article className="border-border-2 rounded-card border p-4">
      <header className="flex flex-wrap items-center gap-2">
        <p className="text-body font-bold">
          {formatTime(shift.openedAt)} – {close === null ? 'now' : formatTime(close.closedAt)}
        </p>
        <span className="text-muted-2 min-w-0 flex-1 truncate text-caption font-semibold">
          {shift.openedBy.name}
          {close !== null && close.closedBy.id !== shift.openedBy.id ? ` → ${close.closedBy.name}` : ''}
        </span>
        {close === null ? (
          <Badge tone="warning" dot>
            Not counted
          </Badge>
        ) : variance === 0 ? (
          <Badge tone="success" dot>
            Balanced
          </Badge>
        ) : (
          <Badge tone={variance < 0 ? 'danger' : 'warning'} dot>
            {variance < 0 ? 'Short' : 'Over'} {formatPaisa(Math.abs(variance))}
          </Badge>
        )}
      </header>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <Figure label="Expected" value={formatPaisa(shift.expectedCashPaisa)} />
        <Figure
          label="Counted"
          value={close === null ? '—' : formatPaisa(close.countedCashPaisa)}
          className={cn(
            close !== null && variance === 0 && 'text-ok-fg',
            close !== null && variance < 0 && 'text-danger-fg',
            close !== null && variance > 0 && 'text-warn-fg',
          )}
        />
      </div>

      <div className="mt-3">
        <MoneyRow label="Opening float" value={shift.openingFloatPaisa} />
        <MoneyRow label="Cash sales" value={shift.cashSalesPaisa} />
        <MoneyRow
          label="Credit repaid in cash"
          value={shift.cashCreditCollectionsPaisa}
          muted={shift.cashCreditCollectionsPaisa === 0}
        />
        <MoneyRow label="Paid in" value={shift.payInsPaisa} muted={shift.payInsPaisa === 0} />
        <MoneyRow label="Paid out" value={-shift.payOutsPaisa} muted={shift.payOutsPaisa === 0} />
      </div>

      {shift.movements.length > 0 && (
        <ul className="border-border mt-2 space-y-1.5 border-t pt-3">
          {shift.movements.map((movement) => {
            const incoming = movement.type === 'PAY_IN';
            const Icon = incoming ? ArrowDownLeft : ArrowUpRight;
            return (
              <li key={movement.id} className="flex items-center gap-2.5 text-caption">
                <span
                  className={cn(
                    'grid size-6 shrink-0 place-items-center rounded-full',
                    incoming ? 'bg-ok/12 text-ok-fg' : 'bg-danger/10 text-danger-fg',
                  )}
                >
                  <Icon size={13} aria-hidden />
                </span>
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-semibold">{movement.reason}</span>
                  <span className="text-muted-2"> · {movement.staff.name}</span>
                </span>
                <span className="font-mono tabular-nums">
                  {formatPaisa(incoming ? movement.amountPaisa : -movement.amountPaisa)}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {close !== null && close.note !== null && (
        <p className="bg-surface-2 text-muted mt-3 rounded-control px-3 py-2 text-caption italic">“{close.note}”</p>
      )}
    </article>
  );
}

function Figure({
  label,
  value,
  className,
}: {
  readonly label: string;
  readonly value: string;
  readonly className?: string;
}): JSX.Element {
  return (
    <div className="bg-surface-2 rounded-control px-3 py-2.5">
      <p className="text-muted-2 text-overline font-bold tracking-wider uppercase">{label}</p>
      <p className={cn('mt-0.5 font-mono text-heading font-bold tabular-nums', className)}>{value}</p>
    </div>
  );
}
