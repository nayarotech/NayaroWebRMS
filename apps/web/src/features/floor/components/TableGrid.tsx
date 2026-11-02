import type { JSX } from 'react';
import type { FloorArea, FloorTable } from '@nayaro/shared';
import { TableCard } from './TableCard';

export interface TableGridProps {
  readonly areas: readonly FloorArea[];
  /** True when several areas are shown at once, so cards name their area. */
  readonly showAreaNames: boolean;
  /** Opens a table's order. Omitted for roles that cannot take orders. */
  readonly onOpenTable?: (table: FloorTable) => void;
  /** Opens the bill for a table. Omitted for roles that cannot bill. */
  readonly onBillTable?: (table: FloorTable) => void;
}

/**
 * The board itself: one section per area, tables inside.
 *
 * Sections stay in the server's sortOrder, and tables within them likewise, so
 * the board's layout matches how the manager arranged it and stays put between
 * refetches. Nothing here re-sorts by status - a card that jumps position when
 * food goes ready would make the floor unreadable at exactly the moment it
 * needs to be read.
 */
export function TableGrid({
  areas,
  showAreaNames,
  onOpenTable,
  onBillTable,
}: TableGridProps): JSX.Element {
  return (
    <div className="flex flex-col gap-7">
      {areas.map((area) => (
        <section key={area.id} aria-label={area.name}>
          {showAreaNames && (
            <div className="mb-3 flex items-baseline gap-2.5">
              <h2 className="text-[13px] font-extrabold tracking-tight">{area.name}</h2>
              <span className="text-muted-2 font-mono text-[11px] font-semibold">
                {area.tables.length} {area.tables.length === 1 ? 'table' : 'tables'}
              </span>
              {!area.isActive && (
                <span className="text-muted-2 border-border-2 rounded-md border px-1.5 py-0.5 text-[10.5px] font-bold">
                  Hidden
                </span>
              )}
            </div>
          )}

          {area.tables.length === 0 ? (
            <p className="border-border-2 text-muted-2 rounded-card border border-dashed px-4 py-6 text-[13px]">
              No tables in {area.name} yet.
            </p>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(184px,1fr))] gap-3.5">
              {area.tables.map((table) => (
                <TableCard
                  key={table.id}
                  table={table}
                  {...(showAreaNames ? {} : { areaName: area.name })}
                  {...(onOpenTable === undefined ? {} : { onOpen: onOpenTable })}
                  {...(onBillTable === undefined ? {} : { onBill: onBillTable })}
                />
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
