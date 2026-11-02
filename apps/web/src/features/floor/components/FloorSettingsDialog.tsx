import { useState, type JSX, type ReactNode } from 'react';
import type { FloorArea, FloorTable } from '@nayaro/shared';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { ApiRequestError } from '@/services/apiClient';
import { cn } from '@/lib/utils';
import { useFloor, useFloorMutations } from '../hooks/useFloor';

export interface FloorSettingsDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

/**
 * Floor configuration: areas on the left, the selected area's tables on the
 * right. Only ever opened for OWNER and MANAGER - the screen does not render
 * the button otherwise, and the server refuses regardless.
 *
 * This view asks for `includeInactive`, unlike the service board. A manager
 * needs to see what they switched off in order to switch it back on; a cashier
 * must not, or a table that is out of service would still look bookable.
 *
 * Deactivate, never delete. A table with three months of orders behind it
 * cannot be removed without breaking that history, so "remove from the floor"
 * means hidden from service and still referenced by everything that happened on
 * it. The server enforces the same thing from the other side, refusing to
 * deactivate a table that has an order open on it right now.
 */
export function FloorSettingsDialog({ open, onClose }: FloorSettingsDialogProps): JSX.Element {
  const floor = useFloor({ includeInactive: true });
  const mutations = useFloorMutations();

  const [selectedAreaId, setSelectedAreaId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const areas = floor.data?.areas ?? [];
  // Derived, not synchronised. If another terminal removes the area this
  // dialog had selected, `find` misses and the fallback lands on the first one
  // - no effect, no cascading render, and nothing to keep in step.
  const selectedArea = areas.find((area) => area.id === selectedAreaId) ?? areas[0];

  /**
   * Every mutation goes through here so failures are handled once.
   *
   * The server's message is shown verbatim because it was written to be shown:
   * "Ground Floor still has 3 active table(s)". Anything that is not one of our
   * error envelopes is replaced with a generic line - a raw exception could
   * carry internals, and the user cannot act on it either way.
   */
  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setError(null);
    try {
      await action();
      return true;
    } catch (cause: unknown) {
      setError(
        cause instanceof ApiRequestError && cause.kind === 'http'
          ? cause.message
          : 'Could not save that change. Check your connection and try again.',
      );
      return false;
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Areas and tables"
      description="Group your tables by area. Orders are attached to tables, so every table needs an area."
      footer={<Button onClick={onClose}>Done</Button>}
    >
      {error !== null && (
        <p
          role="alert"
          className="border-danger/40 bg-danger/8 text-danger-fg mb-4 rounded-xl border px-3.5 py-2.5 text-[13px] font-semibold"
        >
          {error}
        </p>
      )}

      <div className="grid grid-cols-[minmax(0,260px)_1fr] gap-6">
        <section aria-label="Areas">
          <SectionHeading>Areas</SectionHeading>
          <div className="mt-2.5 flex flex-col gap-1.5">
            {areas.map((area) => (
              <button
                key={area.id}
                type="button"
                onClick={() => {
                  setSelectedAreaId(area.id);
                }}
                className={cn(
                  'flex items-center gap-2 rounded-xl border px-3 py-2.5 text-left text-[13.5px] font-bold transition-colors',
                  selectedArea?.id === area.id
                    ? 'border-accent bg-accent/10 text-accent-hover'
                    : 'border-border-2 bg-surface hover:border-accent-hover',
                )}
              >
                <span className="min-w-0 flex-1 truncate">{area.name}</span>
                <span className="text-muted-2 font-mono text-[10.5px]">{area.tables.length}</span>
                {!area.isActive && <HiddenTag />}
              </button>
            ))}
          </div>

          <AddRow
            label="Area name"
            placeholder="Rooftop"
            busy={mutations.isSaving}
            // Selecting the new area is the point, not a nicety: the panel on
            // the right is where tables get added, and leaving it pointed at
            // the previous area sends the tables you add next into the wrong
            // one. Creating a thing focuses it.
            onSubmit={async (name) =>
              run(async () => {
                const floor = await mutations.createArea({ name });
                const created = floor.areas.find((area) => area.name === name);
                if (created !== undefined) setSelectedAreaId(created.id);
              })
            }
          />
        </section>

        <section aria-label="Tables">
          {selectedArea === undefined ? (
            <p className="text-muted-2 text-[13px]">Add an area first, then add tables to it.</p>
          ) : (
            <>
              <SectionHeading>
                Tables in {selectedArea.name}
                <AreaActions
                  area={selectedArea}
                  busy={mutations.isSaving}
                  onRename={async (name) =>
                    run(() => mutations.updateArea(selectedArea.id, { name }))
                  }
                  onToggleActive={async () =>
                    run(() =>
                      mutations.updateArea(selectedArea.id, { isActive: !selectedArea.isActive }),
                    )
                  }
                />
              </SectionHeading>

              <ul className="mt-2.5 flex flex-col gap-1.5">
                {selectedArea.tables.map((table) => (
                  <TableRow
                    key={table.id}
                    table={table}
                    busy={mutations.isSaving}
                    onRename={async (name) => run(() => mutations.updateTable(table.id, { name }))}
                    onToggleActive={async () =>
                      run(() => mutations.updateTable(table.id, { isActive: !table.isActive }))
                    }
                  />
                ))}
                {selectedArea.tables.length === 0 && (
                  <li className="text-muted-2 border-border-2 rounded-xl border border-dashed px-3.5 py-4 text-[13px]">
                    No tables here yet.
                  </li>
                )}
              </ul>

              <AddRow
                label="Table name"
                placeholder="Table 1"
                busy={mutations.isSaving}
                onSubmit={async (name) =>
                  run(() => mutations.createTable({ areaId: selectedArea.id, name }))
                }
              />
            </>
          )}
        </section>
      </div>
    </Modal>
  );
}

function SectionHeading({ children }: { children: ReactNode }): JSX.Element {
  return (
    <h3 className="text-muted flex items-center gap-2 font-mono text-[11px] font-semibold tracking-widest uppercase">
      {children}
    </h3>
  );
}

function HiddenTag(): JSX.Element {
  return (
    <span className="text-muted-2 border-border-2 shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] font-bold">
      Hidden
    </span>
  );
}

/** Shared inline add-a-thing form. Same shape for areas and tables. */
function AddRow({
  label,
  placeholder,
  busy,
  onSubmit,
}: {
  label: string;
  placeholder: string;
  busy: boolean;
  onSubmit: (name: string) => Promise<boolean>;
}): JSX.Element {
  const [value, setValue] = useState('');
  const trimmed = value.trim();

  return (
    <form
      className="mt-3 flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed.length === 0) return;
        void onSubmit(trimmed).then((ok) => {
          // Cleared only on success, so a rejected name stays in the field for
          // the user to correct rather than having to be retyped.
          if (ok) setValue('');
        });
      }}
    >
      <input
        aria-label={label}
        placeholder={placeholder}
        value={value}
        maxLength={60}
        onChange={(event) => {
          setValue(event.target.value);
        }}
        className="bg-field border-border-3 focus:ring-accent-hover/25 focus:border-accent-hover min-w-0 flex-1 rounded-xl border px-3 py-2.5 text-[13.5px] outline-none focus:ring-3"
      />
      <Button type="submit" variant="secondary" disabled={trimmed.length === 0 || busy}>
        Add
      </Button>
    </form>
  );
}

function AreaActions({
  area,
  busy,
  onRename,
  onToggleActive,
}: {
  area: FloorArea;
  busy: boolean;
  onRename: (name: string) => Promise<boolean>;
  onToggleActive: () => Promise<boolean>;
}): JSX.Element {
  return (
    <span className="ml-auto flex items-center gap-1">
      <RenameButton current={area.name} busy={busy} onRename={onRename} />
      <MiniButton busy={busy} onClick={() => void onToggleActive()}>
        {area.isActive ? 'Hide' : 'Show'}
      </MiniButton>
    </span>
  );
}

function TableRow({
  table,
  busy,
  onRename,
  onToggleActive,
}: {
  table: FloorTable;
  busy: boolean;
  onRename: (name: string) => Promise<boolean>;
  onToggleActive: () => Promise<boolean>;
}): JSX.Element {
  return (
    <li
      className={cn(
        'border-border-2 bg-surface flex items-center gap-2 rounded-xl border px-3.5 py-2.5',
        !table.isActive && 'opacity-60',
      )}
    >
      <span className="min-w-0 flex-1 truncate text-[13.5px] font-bold">{table.name}</span>
      <span className="text-muted-2 shrink-0 font-mono text-[10.5px]">{table.capacity} seats</span>
      {!table.isActive && <HiddenTag />}
      <RenameButton current={table.name} busy={busy} onRename={onRename} />
      <MiniButton busy={busy} onClick={() => void onToggleActive()}>
        {table.isActive ? 'Remove' : 'Restore'}
      </MiniButton>
    </li>
  );
}

/**
 * Rename in place. Swaps the label for an input rather than opening a second
 * dialog - a modal on top of a modal for a one-field edit is ceremony.
 */
function RenameButton({
  current,
  busy,
  onRename,
}: {
  current: string;
  busy: boolean;
  onRename: (name: string) => Promise<boolean>;
}): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(current);

  if (!editing) {
    return (
      <MiniButton
        busy={busy}
        onClick={() => {
          setValue(current);
          setEditing(true);
        }}
      >
        Rename
      </MiniButton>
    );
  }

  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        const trimmed = value.trim();
        if (trimmed.length === 0 || trimmed === current) {
          setEditing(false);
          return;
        }
        void onRename(trimmed).then((ok) => {
          if (ok) setEditing(false);
        });
      }}
    >
      {/* Focused on mount: the user pressed Rename, so this field is what they
          asked for. */}
      <input
        autoFocus
        aria-label="New name"
        value={value}
        maxLength={60}
        onChange={(event) => {
          setValue(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setEditing(false);
        }}
        className="bg-field border-accent-hover w-32 rounded-lg border px-2 py-1 text-[12.5px] outline-none"
      />
      <MiniButton busy={busy} type="submit">
        Save
      </MiniButton>
    </form>
  );
}

function MiniButton({
  children,
  busy,
  onClick,
  type = 'button',
}: {
  children: ReactNode;
  busy: boolean;
  onClick?: () => void;
  type?: 'button' | 'submit';
}): JSX.Element {
  return (
    <button
      type={type}
      disabled={busy}
      {...(onClick === undefined ? {} : { onClick })}
      className="border-border-2 text-muted hover:border-accent-hover hover:text-accent-hover shrink-0 rounded-lg border px-2 py-1 text-[11.5px] font-bold transition-colors disabled:opacity-50"
    >
      {children}
    </button>
  );
}
