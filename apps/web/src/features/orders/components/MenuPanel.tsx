import { Plus, Search } from 'lucide-react';
import { useMemo, useState, type JSX } from 'react';
import type { MenuCategorySummary } from '@nayaro/shared';
import { cn } from '@/lib/utils';
import { formatPaisa } from '@/lib/money';

export interface MenuPanelProps {
  readonly categories: readonly MenuCategorySummary[];
  readonly onAdd: (menuItemId: string) => void;
  readonly busy: boolean;
}

/**
 * The left-hand half of the POS: categories, search, and a grid of dishes.
 *
 * Built for speed above all else. One tap adds one plate - no confirmation
 * dialog, no quantity prompt, no "added to order" toast to dismiss. A cashier
 * taking an order at the table is holding a device in one hand and looking at
 * the customer; every extra interaction is a mistake waiting to happen. The
 * order panel on the right is the confirmation, and it updates as they tap.
 */
export function MenuPanel({ categories, onAdd, busy }: MenuPanelProps): JSX.Element {
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const query = search.trim().toLowerCase();
  const visible = useMemo(() => {
    // Searching looks across the whole menu, not the selected tab. A cashier
    // typing "coke" wants the Coke, not to be told it is not in Momo.
    const scoped =
      query.length > 0 || categoryId === null
        ? categories
        : categories.filter((category) => category.id === categoryId);

    return scoped
      .map((category) => ({
        ...category,
        items:
          query.length === 0
            ? category.items
            : category.items.filter(
                (item) =>
                  item.name.toLowerCase().includes(query) ||
                  (item.nameNp ?? '').toLowerCase().includes(query),
              ),
      }))
      .filter((category) => category.items.length > 0);
  }, [categories, categoryId, query]);

  return (
    <div className="min-w-0 flex-1">
      <div className="relative mb-4 flex flex-wrap items-center gap-2">
        <Search
          aria-hidden
          size={17}
          className="text-muted-3 pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2"
        />
        <input
          type="search"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
          }}
          placeholder="Search the menu…"
          aria-label="Search the menu"
          className="bg-field border-border-3 focus:ring-accent-hover/20 focus:border-accent-hover h-11 w-full rounded-control border pr-3.5 pl-10 text-body outline-none focus:ring-3 sm:w-80"
        />
        {query.length > 0 && (
          <span className="text-muted-2 text-[12px] font-semibold">Searching all categories</span>
        )}
      </div>

      <div
        role="tablist"
        aria-label="Menu categories"
        className="-mx-1 mb-5 flex gap-2 overflow-x-auto px-1 pb-1"
      >
        <CategoryTab
          label="All"
          active={categoryId === null}
          onClick={() => {
            setCategoryId(null);
          }}
        />
        {categories.map((category) => (
          <CategoryTab
            key={category.id}
            label={category.name}
            sublabel={category.nameNp}
            active={categoryId === category.id}
            onClick={() => {
              setCategoryId(category.id);
            }}
          />
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="border-border-2 text-muted-2 rounded-card border border-dashed px-4 py-8 text-center text-[13px]">
          {query.length > 0
            ? `Nothing on the menu matches "${search.trim()}".`
            : 'Nothing to sell here yet.'}
        </p>
      ) : (
        <div className="flex flex-col gap-6">
          {visible.map((category) => (
            <section key={category.id} aria-label={category.name}>
              <h3 className="text-muted mb-2.5 font-mono text-[11px] font-semibold tracking-widest uppercase">
                {category.name}
              </h3>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
                {category.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      onAdd(item.id);
                    }}
                    className={cn(
                      'group border-border bg-surface shadow-card relative flex min-h-[96px] flex-col items-start rounded-card border p-3.5 text-left',
                      'hover:border-accent hover:bg-accent-soft transition-[colors,transform] active:scale-[0.98]',
                      'focus-visible:ring-accent-hover/50 outline-none focus-visible:ring-2',
                      'disabled:cursor-not-allowed disabled:opacity-60',
                    )}
                  >
                    <span className="text-[14px] leading-tight font-bold">{item.name}</span>
                    {(item.components?.length ?? 0) > 0 && (
                      <span className="text-muted-2 block text-xs">
                        {item
                          .components!.map((part) => `${part.quantity} × ${part.name}`)
                          .join(', ')}
                      </span>
                    )}
                    {item.promotion && (
                      <span className="text-accent block text-xs">
                        {item.promotion.name} · {item.promotion.rateBp / 100}% off{' '}
                        <del className="text-muted-2">
                          {formatPaisa(item.promotion.regularUnitPricePaisa)}
                        </del>
                      </span>
                    )}
                    {item.nameNp !== null && (
                      <span className="text-muted-2 mt-0.5 text-[12px] leading-tight">
                        {item.nameNp}
                      </span>
                    )}
                    <span className="mt-auto flex w-full items-end justify-between gap-2 pt-2">
                      <span className="text-text font-mono text-[13px] font-bold">
                        {formatPaisa(item.pricePaisa)}
                      </span>
                      <span
                        aria-hidden
                        className="bg-accent-soft text-accent-hover group-hover:bg-accent grid size-7 place-items-center rounded-full transition-colors group-hover:text-white"
                      >
                        <Plus size={15} strokeWidth={2.5} />
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function CategoryTab({
  label,
  sublabel,
  active,
  onClick,
}: {
  label: string;
  sublabel?: string | null;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'shrink-0 rounded-full border px-4 py-2 text-[13px] font-bold whitespace-nowrap transition-colors',
        'focus-visible:ring-accent-hover/50 outline-none focus-visible:ring-2',
        active
          ? 'border-accent bg-accent text-white'
          : 'border-border-2 bg-surface text-text-2 hover:border-accent-hover',
      )}
    >
      {label}
      {sublabel !== undefined && sublabel !== null && (
        <span className={cn('ml-1.5 text-[11px]', active ? 'text-white/70' : 'text-muted-2')}>
          {sublabel}
        </span>
      )}
    </button>
  );
}
