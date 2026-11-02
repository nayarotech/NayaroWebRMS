import { useState, type JSX } from 'react';
import type { FloorArea, FloorTable } from '@nayaro/shared';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select } from '@/components/ui/Field';
import { InlineAlert } from '@/components/ui/States';
import { ApiRequestError } from '@/services/apiClient';
import { useFloorMutations } from '../hooks/useFloor';

export type TableEditorTarget =
  | { readonly mode: 'add'; readonly areaId: string }
  | { readonly mode: 'edit'; readonly table: FloorTable; readonly areaId: string };

/**
 * Add or change one table, straight from the floor plan.
 *
 * The bulk "Areas and tables" dialog still exists for arranging a whole floor;
 * this is for the everyday case - a new table on the terrace, a four-top pushed
 * to six - without leaving the board the manager is looking at.
 */
export function TableEditorDialog({
  target,
  areas,
  onClose,
}: {
  readonly target: TableEditorTarget | null;
  readonly areas: readonly FloorArea[];
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <Modal
      open={target !== null}
      onClose={onClose}
      title={target?.mode === 'edit' ? `Edit ${target.table.name}` : 'Add a table'}
      description="Tables are what orders are opened on. Seats are shown on the floor plan."
      className="w-[min(480px,94vw)]"
    >
      {/* Keyed so each open starts from the table's current values. */}
      {target !== null && (
        <TableForm
          key={target.mode === 'edit' ? target.table.id : `add:${target.areaId}`}
          target={target}
          areas={areas}
          onDone={onClose}
        />
      )}
    </Modal>
  );
}

function TableForm({
  target,
  areas,
  onDone,
}: {
  readonly target: TableEditorTarget;
  readonly areas: readonly FloorArea[];
  readonly onDone: () => void;
}): JSX.Element {
  const mutations = useFloorMutations();
  const editing = target.mode === 'edit' ? target.table : null;
  const area = areas.find((candidate) => candidate.id === target.areaId);

  const [name, setName] = useState(editing?.name ?? suggestName(area));
  const [seats, setSeats] = useState(String(editing?.capacity ?? 4));
  const [areaId, setAreaId] = useState(target.areaId);
  const [error, setError] = useState<string | null>(null);

  const capacity = Number(seats);
  const valid = name.trim().length > 0 && Number.isInteger(capacity) && capacity >= 1 && capacity <= 99;

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setError(null);
    try {
      await action();
      onDone();
    } catch (cause: unknown) {
      setError(
        cause instanceof ApiRequestError && cause.kind === 'http'
          ? cause.message
          : 'Could not save that change. Check your connection and try again.',
      );
    }
  };

  const save = (): void => {
    if (!valid) return;
    void run(() =>
      editing === null
        ? mutations.createTable({ areaId, name: name.trim(), capacity })
        : mutations.updateTable(editing.id, {
            name: name.trim(),
            capacity,
            ...(areaId === target.areaId ? {} : { areaId }),
          }),
    );
  };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
    >
      {error !== null && <InlineAlert>{error}</InlineAlert>}

      <div className="grid grid-cols-[1fr_7rem] gap-3">
        <Field label="Table name">
          {({ id }) => (
            <Input
              id={id}
              value={name}
              maxLength={40}
              autoFocus
              onChange={(event) => {
                setName(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Seats">
          {({ id }) => (
            <Input
              id={id}
              type="number"
              inputMode="numeric"
              min={1}
              max={99}
              value={seats}
              onChange={(event) => {
                setSeats(event.target.value);
              }}
            />
          )}
        </Field>
      </div>

      <Field label="Area">
        {({ id }) => (
          <Select
            id={id}
            value={areaId}
            onChange={(event) => {
              setAreaId(event.target.value);
            }}
          >
            {areas.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </Select>
        )}
      </Field>

      {editing?.isActive === true && (
        <p className="text-muted-2 text-caption">
          A table taken out of service leaves the floor plan but keeps its history. Bring it back from
          “Areas and tables”.
        </p>
      )}

      <div className="border-border flex flex-wrap items-center gap-2.5 border-t pt-4">
        {editing !== null && (
          <Button
            variant={editing.isActive ? 'danger' : 'secondary'}
            disabled={mutations.isSaving}
            onClick={() => {
              void run(() => mutations.updateTable(editing.id, { isActive: !editing.isActive }));
            }}
          >
            {editing.isActive ? 'Take out of service' : 'Put back in service'}
          </Button>
        )}
        <Button variant="secondary" className="ml-auto" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!valid} loading={mutations.isSaving}>
          {editing === null ? 'Add table' : 'Save'}
        </Button>
      </div>
    </form>
  );
}

/** "T9" after T1-T8: continue the area's own naming instead of starting over. */
function suggestName(area: FloorArea | undefined): string {
  if (area === undefined || area.tables.length === 0) return 'Table 1';
  const last = area.tables[area.tables.length - 1]!.name;
  const match = /^(.*?)(\d+)$/.exec(last);
  return match === null ? `${last} 2` : `${match[1]!}${String(Number(match[2]) + 1)}`;
}
