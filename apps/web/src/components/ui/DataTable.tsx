import { useMemo, useState, type JSX, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './Button';
import { Input } from './Field';
import { EmptyState, SkeletonRows, type EmptyStateProps } from './States';

export interface Column<Row> {
  readonly key: string;
  readonly header: string;
  readonly cell: (row: Row) => ReactNode;
  /** Enables sorting on this column. */
  readonly sortValue?: (row: Row) => string | number;
  readonly align?: 'left' | 'right' | 'center';
  readonly className?: string;
  /** Hidden below this breakpoint so narrow screens keep the essentials. */
  readonly hideBelow?: 'sm' | 'md' | 'lg';
}

export interface DataTableProps<Row> {
  readonly rows: readonly Row[];
  readonly columns: readonly Column<Row>[];
  readonly getRowId: (row: Row) => string;
  readonly loading?: boolean;
  /** Text each row is searched by. Omit to hide the search box. */
  readonly searchText?: (row: Row) => string;
  readonly searchPlaceholder?: string;
  /** Filters and actions shown beside the search box. */
  readonly toolbar?: ReactNode;
  readonly pageSize?: number;
  readonly initialSort?: { readonly key: string; readonly direction: 'asc' | 'desc' };
  readonly onRowClick?: (row: Row) => void;
  readonly empty: EmptyStateProps;
  readonly className?: string;
}

const HIDE_BELOW = { sm: 'hidden sm:table-cell', md: 'hidden md:table-cell', lg: 'hidden lg:table-cell' };
const ALIGN = { left: 'text-left', right: 'text-right', center: 'text-center' };

/**
 * The one table. Search, sort and pagination run on the rows already loaded,
 * which suits the bounded lists in a restaurant (today's bills, staff, stock).
 */
export function DataTable<Row>({
  rows,
  columns,
  getRowId,
  loading = false,
  searchText,
  searchPlaceholder = 'Search…',
  toolbar,
  pageSize = 15,
  initialSort,
  onRowClick,
  empty,
  className,
}: DataTableProps<Row>): JSX.Element {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState(initialSort ?? null);
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0 || searchText === undefined) return rows;
    return rows.filter((row) => searchText(row).toLowerCase().includes(needle));
  }, [rows, query, searchText]);

  const sorted = useMemo(() => {
    const column = sort === null ? undefined : columns.find((candidate) => candidate.key === sort.key);
    if (sort === null || column?.sortValue === undefined) return filtered;
    const valueOf = column.sortValue;
    const direction = sort.direction === 'asc' ? 1 : -1;
    return [...filtered].sort((left, right) => {
      const a = valueOf(left);
      const b = valueOf(right);
      return (a < b ? -1 : a > b ? 1 : 0) * direction;
    });
  }, [filtered, sort, columns]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const visible = sorted.slice(currentPage * pageSize, currentPage * pageSize + pageSize);

  const toggleSort = (key: string): void => {
    setSort((current) =>
      current?.key === key
        ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'asc' },
    );
  };

  return (
    <div className={cn('border-border bg-surface shadow-card overflow-hidden rounded-card border', className)}>
      {(searchText !== undefined || toolbar !== undefined) && (
        <div className="border-border flex flex-wrap items-center gap-3 border-b px-4 py-3">
          {searchText !== undefined && (
            <div className="relative w-full sm:max-w-xs">
              <Search
                aria-hidden
                size={16}
                className="text-muted-3 pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
              />
              <Input
                type="search"
                value={query}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
                className="pl-9"
              />
            </div>
          )}
          {toolbar !== undefined && <div className="flex flex-wrap items-center gap-2 sm:ml-auto">{toolbar}</div>}
        </div>
      )}

      {loading ? (
        <SkeletonRows />
      ) : sorted.length === 0 ? (
        <EmptyState
          {...empty}
          {...(query.length > 0
            ? { title: 'No matches', description: `Nothing matches “${query}”.`, action: undefined }
            : {})}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-body">
            <thead>
              <tr className="bg-surface-2 border-border border-b">
                {columns.map((column) => (
                  <th
                    key={column.key}
                    scope="col"
                    className={cn(
                      'text-muted px-4 py-2.5 text-overline font-bold tracking-wider uppercase whitespace-nowrap',
                      ALIGN[column.align ?? 'left'],
                      column.hideBelow !== undefined && HIDE_BELOW[column.hideBelow],
                    )}
                  >
                    {column.sortValue === undefined ? (
                      column.header
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          toggleSort(column.key);
                        }}
                        className="hover:text-text-2 inline-flex items-center gap-1 uppercase"
                      >
                        {column.header}
                        {sort?.key === column.key &&
                          (sort.direction === 'asc' ? (
                            <ArrowUp size={12} aria-label="ascending" />
                          ) : (
                            <ArrowDown size={12} aria-label="descending" />
                          ))}
                      </button>
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr
                  key={getRowId(row)}
                  onClick={onRowClick === undefined ? undefined : () => onRowClick(row)}
                  className={cn(
                    'border-border border-b last:border-b-0',
                    onRowClick !== undefined && 'hover:bg-surface-2 cursor-pointer',
                  )}
                >
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      className={cn(
                        'px-4 py-3 align-middle',
                        ALIGN[column.align ?? 'left'],
                        column.hideBelow !== undefined && HIDE_BELOW[column.hideBelow],
                        column.className,
                      )}
                    >
                      {column.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!loading && sorted.length > pageSize && (
        <div className="border-border text-muted flex items-center gap-3 border-t px-4 py-2.5 text-caption">
          <span>
            {currentPage * pageSize + 1}–{Math.min(sorted.length, (currentPage + 1) * pageSize)} of{' '}
            {sorted.length}
          </span>
          <div className="ml-auto flex gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              iconOnly
              icon={ChevronLeft}
              aria-label="Previous page"
              disabled={currentPage === 0}
              onClick={() => {
                setPage(currentPage - 1);
              }}
            />
            <Button
              variant="secondary"
              size="sm"
              iconOnly
              icon={ChevronRight}
              aria-label="Next page"
              disabled={currentPage >= pageCount - 1}
              onClick={() => {
                setPage(currentPage + 1);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
