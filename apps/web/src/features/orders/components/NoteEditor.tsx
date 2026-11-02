import { useState, type JSX } from 'react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';

export interface NoteEditorProps {
  readonly value: string | null;
  readonly onSave: (note: string | null) => void;
  readonly onCancel: () => void;
  readonly busy: boolean;
}

/**
 * Quick notes, from the prototype.
 *
 * These are UI CONVENIENCES ONLY - there is no preset table in the database
 * and there should not be one. What gets stored is OrderItem.note, a plain
 * string, whether the cashier tapped a chip or typed it. A preset table would
 * buy a settings screen, a migration and a foreign key in exchange for saving
 * six words of typing, and it would still not stop anyone writing "no onion"
 * by hand.
 *
 * Tapping a chip appends rather than replaces, so "less spicy" and "no onion"
 * compose the way a cashier expects when the customer asks for both.
 */
const QUICK_NOTES = [
  'Less spicy',
  'Extra spicy',
  'No onion',
  'No chutney',
  'Pack separately',
  'Serve first',
] as const;

export function NoteEditor({ value, onSave, onCancel, busy }: NoteEditorProps): JSX.Element {
  const [draft, setDraft] = useState(value ?? '');

  const append = (chip: string): void => {
    setDraft((current) => {
      const trimmed = current.trim();
      if (trimmed.length === 0) return chip;
      // Already there? Tapping twice should not stutter.
      if (trimmed.toLowerCase().includes(chip.toLowerCase())) return trimmed;
      return `${trimmed}, ${chip.toLowerCase()}`;
    });
  };

  return (
    <div className="border-border-2 bg-surface-3 mt-2 rounded-xl border p-3">
      <div className="mb-2.5 flex flex-wrap gap-1.5">
        {QUICK_NOTES.map((chip) => (
          <button
            key={chip}
            type="button"
            onClick={() => {
              append(chip);
            }}
            className={cn(
              'border-border-2 bg-surface text-text-2 rounded-lg border px-2 py-1 text-[11.5px] font-semibold',
              'hover:border-accent-hover hover:text-accent-hover transition-colors',
            )}
          >
            {chip}
          </button>
        ))}
      </div>

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = draft.trim();
          onSave(trimmed.length === 0 ? null : trimmed);
        }}
      >
        {/* Focused on mount: the cashier pressed Note to type one. */}
        <input
          autoFocus
          aria-label="Item note"
          value={draft}
          maxLength={120}
          placeholder="e.g. less spicy"
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onCancel();
          }}
          className="bg-field border-border-3 focus:border-accent-hover min-w-0 flex-1 rounded-lg border px-2.5 py-1.5 text-[13px] outline-none"
        />
        <Button type="submit" variant="secondary" disabled={busy} className="h-9 px-3 text-[13px]">
          Save
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} className="h-9 px-2.5 text-[13px]">
          Cancel
        </Button>
      </form>
    </div>
  );
}
