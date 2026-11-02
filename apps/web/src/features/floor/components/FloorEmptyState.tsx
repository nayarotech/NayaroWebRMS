import type { JSX } from 'react';
import { Button } from '@/components/ui/Button';

export interface FloorEmptyStateProps {
  /** OWNER and MANAGER can fix this themselves; everyone else cannot. */
  readonly canConfigure: boolean;
  readonly onConfigure: () => void;
}

/**
 * Shown when the restaurant has no areas at all - which is the state of every
 * install on its first day, so it is a first-run experience rather than an
 * error.
 *
 * It says something different to each audience, because the useful thing to say
 * differs: a manager gets the button that fixes it; a cashier gets told who can
 * fix it, instead of a button that would 403.
 */
export function FloorEmptyState({ canConfigure, onConfigure }: FloorEmptyStateProps): JSX.Element {
  return (
    <div className="border-border-3 bg-surface rounded-card border border-dashed px-8 py-12 text-center">
      <div className="bg-accent/10 text-accent-hover mx-auto grid size-12 place-items-center rounded-card text-xl font-extrabold">
        ▦
      </div>
      <h2 className="mt-4 text-[19px] font-extrabold tracking-tight">Your floor plan is empty</h2>
      <p className="text-muted mx-auto mt-2 max-w-sm text-[14px] leading-relaxed">
        {canConfigure
          ? 'Add an area — Ground Floor, Rooftop, Garden — then add the tables that sit in it. Orders are attached to tables, so this comes first.'
          : 'No areas or tables have been set up yet. An owner or manager needs to add them before orders can be taken.'}
      </p>
      {canConfigure && (
        <Button className="mt-6" size="lg" onClick={onConfigure}>
          Set up areas and tables
        </Button>
      )}
    </div>
  );
}
