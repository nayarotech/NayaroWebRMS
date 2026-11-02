import { useState, type JSX } from 'react';
import type { PreBillDiscount } from '@nayaro/shared';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { formatPaisa } from '@/lib/money';

export interface DiscountControlProps {
  readonly discount: PreBillDiscount;
  readonly subtotalPaisa: number;
  /** False for a cashier: the control renders read-only rather than failing. */
  readonly canEdit: boolean;
  readonly busy: boolean;
  readonly onApply: (type: 'NONE' | 'PERCENT' | 'FIXED', value: number) => void;
}

/**
 * The working discount.
 *
 * OWNER and MANAGER only. A cashier sees what was applied and cannot change it,
 * because this is the one control that gives money away - and the schema
 * records who approved it, which only means something if the person had the
 * authority. There is deliberately no "request approval" flow: a fake one,
 * where nobody actually approves, would be worse than none at all.
 *
 * Percentages are entered as percentages and sent as basis points. The user
 * types 10, the wire carries 1000, and nobody has to know that but this file.
 */
export function DiscountControl({
  discount,
  subtotalPaisa,
  canEdit,
  busy,
  onApply,
}: DiscountControlProps): JSX.Element {
  const [mode, setMode] = useState<'NONE' | 'PERCENT' | 'FIXED'>(discount.type);
  const [raw, setRaw] = useState(() => initialInput(discount));

  if (!canEdit) {
    return (
      <div className="border-border-2 bg-surface-3 rounded-xl border px-3.5 py-3">
        <p className="text-muted font-mono text-[11px] font-semibold tracking-widest uppercase">
          Discount
        </p>
        <p className="mt-1 text-[13.5px] font-bold">
          {discount.amountPaisa === 0 ? 'None' : formatPaisa(discount.amountPaisa)}
        </p>
        <p className="text-muted-2 mt-0.5 text-[11.5px]">
          Only an owner or manager can change a discount.
        </p>
      </div>
    );
  }

  const parsed = Number(raw);
  const valid = raw.trim().length > 0 && Number.isFinite(parsed) && parsed >= 0;
  // Percent is capped at 100; a fixed amount is capped at the subtotal, because
  // a bill cannot go negative and the server would clamp it anyway.
  const withinRange = mode === 'PERCENT' ? parsed <= 100 : parsed * 100 <= subtotalPaisa;

  return (
    <div className="border-border-2 bg-surface-3 rounded-xl border px-3.5 py-3">
      <p className="text-muted mb-2 font-mono text-[11px] font-semibold tracking-widest uppercase">
        Discount
      </p>

      <p className="text-muted-2 mb-2 text-xs">Applies after any promotional item prices.</p>
      <div role="group" aria-label="Discount type" className="mb-2.5 flex gap-1.5">
        {(
          [
            ['NONE', 'None'],
            ['PERCENT', 'Percentage'],
            ['FIXED', 'Fixed amount'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            disabled={busy}
            onClick={() => {
              setMode(value);
              if (value === 'NONE') onApply('NONE', 0);
            }}
            className={cn(
              'flex-1 rounded-lg border px-2 py-1.5 text-[12px] font-bold transition-colors',
              mode === value
                ? 'border-accent bg-accent text-white'
                : 'border-border-2 bg-surface text-text-2 hover:border-accent-hover',
              busy && 'opacity-60',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {mode !== 'NONE' && (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid || !withinRange) return;
            // Percent -> basis points; rupees -> paisa. Integers on the wire.
            onApply(mode, mode === 'PERCENT' ? Math.round(parsed * 100) : Math.round(parsed * 100));
          }}
        >
          <div className="relative flex-1">
            <input
              aria-label={mode === 'PERCENT' ? 'Discount percentage' : 'Discount amount in rupees'}
              inputMode="decimal"
              value={raw}
              onChange={(event) => {
                setRaw(event.target.value);
              }}
              placeholder={mode === 'PERCENT' ? '10' : '100'}
              className="bg-field border-border-3 focus:border-accent-hover w-full rounded-lg border py-1.5 pr-8 pl-2.5 text-[13.5px] outline-none"
            />
            <span className="text-muted-2 absolute top-1/2 right-2.5 -translate-y-1/2 text-[12px] font-semibold">
              {mode === 'PERCENT' ? '%' : '₨'}
            </span>
          </div>
          <Button
            type="submit"
            variant="secondary"
            disabled={busy || !valid || !withinRange}
            className="h-9 px-3 text-[13px]"
          >
            Apply
          </Button>
        </form>
      )}

      {mode !== 'NONE' && !withinRange && valid && (
        <p className="text-danger mt-1.5 text-[11.5px] font-semibold">
          {mode === 'PERCENT'
            ? 'A discount cannot be more than 100%.'
            : 'A discount cannot be more than the subtotal.'}
        </p>
      )}

      {discount.amountPaisa > 0 && (
        <p className="text-muted-2 mt-1.5 text-[11.5px]">
          Applied: {formatPaisa(discount.amountPaisa)}
        </p>
      )}
    </div>
  );
}

function initialInput(discount: PreBillDiscount): string {
  if (discount.type === 'PERCENT') return String(discount.value / 100);
  if (discount.type === 'FIXED') return String(discount.value / 100);
  return '';
}
