import { useRef, useState, type JSX } from 'react';
import type { FloorResponse, OrderDto } from '@nayaro/shared';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';

export function TransferTableDialog({
  order,
  floor,
  loading,
  busy,
  error,
  onRefresh,
  onClose,
  onTransfer,
}: {
  order: OrderDto;
  floor: FloorResponse | undefined;
  loading: boolean;
  busy: boolean;
  error: string | null;
  onRefresh: () => void;
  onClose: () => void;
  onTransfer: (tableId: string) => Promise<boolean>;
}): JSX.Element {
  const [destination, setDestination] = useState('');
  const locked = useRef(false);
  const tables = (floor?.areas ?? [])
    .filter((area) => area.isActive)
    .flatMap((area) =>
      area.tables
        .filter(
          (table) => table.isActive && table.status === 'AVAILABLE' && table.id !== order.table?.id,
        )
        .map((table) => ({ ...table, areaName: area.name })),
    );
  const chosen = tables.find((table) => table.id === destination);
  const allowed = order.canTransferTable;
  return (
    <Modal
      open
      title={`Move ${order.table?.name ?? 'order'} to another table`}
      description={`Order #${order.orderNumber} and its existing kitchen tickets will move together.`}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (chosen && !busy && allowed && !locked.current) {
            locked.current = true;
            void onTransfer(chosen.id)
              .then((done) => {
                if (done) onClose();
              })
              .finally(() => {
                locked.current = false;
              });
          }
        }}
      >
        <label
          htmlFor="transfer-destination"
          className="text-muted mb-2 block text-sm font-semibold"
        >
          Available table
        </label>
        <select
          id="transfer-destination"
          value={destination}
          onChange={(event) => setDestination(event.target.value)}
          disabled={busy || loading || !allowed}
          required
          className="bg-field border-border-3 mb-3 w-full rounded-xl border p-3 text-sm"
        >
          <option value="">{loading ? 'Refreshing tables…' : 'Choose a table'}</option>
          {tables.map((table) => (
            <option value={table.id} key={table.id}>
              {table.areaName} · {table.name} · {table.capacity} seats
            </option>
          ))}
        </select>
        {!loading && tables.length === 0 && (
          <p className="text-muted mb-3 text-sm">No other tables are available.</p>
        )}
        {!allowed && (
          <p role="alert" className="text-danger mb-3 text-sm">
            This order can no longer move tables.
          </p>
        )}
        {error && (
          <p role="alert" className="text-danger mb-3 text-sm">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" disabled={busy} onClick={onRefresh}>
            Refresh tables
          </Button>
          <Button type="button" variant="secondary" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} disabled={busy || loading || !chosen || !allowed}>
            Move order
          </Button>
        </div>
      </form>
    </Modal>
  );
}
