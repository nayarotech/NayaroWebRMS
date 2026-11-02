import { useMemo, useState, type JSX } from 'react';
import { useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { CustomerMenuResponse } from '@nayaro/shared';
import { apiClient, ApiRequestError } from '@/services/apiClient';
import { formatPaisa } from '@/lib/money';
import { cn } from '@/lib/utils';
import { NayaroLogo } from '@/components/layout/NayaroBrand';

/** Guest menu at /m/:workspace. Sends no staff credentials and opens no live connection. */
export function GuestMenuScreen(): JSX.Element {
  const workspace = (useParams()['workspace'] ?? '').toLowerCase();
  const validLink = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(workspace);
  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const menu = useQuery({
    queryKey: ['customer-menu', workspace],
    enabled: validLink,
    queryFn: () =>
      apiClient.getPublic<CustomerMenuResponse>(
        `/public/menu?workspace=${encodeURIComponent(workspace)}`,
      ),
    staleTime: 15_000,
    refetchInterval: 30_000,
    retry: (attempt, error) =>
      !(error instanceof ApiRequestError && error.status === 404) && attempt < 1,
  });
  const categories = useMemo(() => {
    const term = search.trim().toLocaleLowerCase();
    const source = menu.data?.categories ?? [];
    const selectedExists = source.some((row) => row.id === categoryId);
    return source
      .filter(
        (category) =>
          term.length > 0 || categoryId === null || !selectedExists || category.id === categoryId,
      )
      .map((category) => ({
        ...category,
        items: category.items.filter(
          (item) =>
            term.length === 0 ||
            [item.name, item.nameNp ?? '', ...item.components.map((part) => part.name)].some(
              (text) => text.toLocaleLowerCase().includes(term),
            ),
        ),
      }))
      .filter((category) => category.items.length > 0);
  }, [menu.data, categoryId, search]);
  const unavailable =
    !validLink || (menu.error instanceof ApiRequestError && menu.error.status === 404);

  return (
    <div className="bg-base min-h-dvh">
      <div className="mx-auto max-w-3xl px-4 pb-8">
        <header className="border-border-2 flex items-center gap-2 border-b py-4">
          <NayaroLogo compact className="size-7" />
          <span className="text-muted text-xs font-semibold">Restaurant menu</span>
        </header>
        {unavailable ? (
          <Message title="Menu unavailable" body="Please ask a member of staff for the menu." />
        ) : menu.isPending ? (
          <p role="status" className="py-12 text-center">
            Opening the menu…
          </p>
        ) : menu.data === undefined ? (
          <Message
            title="Could not open the menu"
            body="Check your internet connection and try again. If it still won’t open, ask a member of staff."
          >
            <Refresh
              busy={menu.isFetching}
              onClick={() => {
                void menu.refetch();
              }}
            />
          </Message>
        ) : (
          <>
            <section className="py-7">
              <p className="text-accent mb-2 text-xs font-bold tracking-widest uppercase">
                Welcome
              </p>
              <h1 className="text-3xl leading-tight font-extrabold tracking-tight">
                {menu.data.restaurant.name}
              </h1>
              {menu.data.restaurant.address && (
                <p className="text-muted mt-2 text-sm">{menu.data.restaurant.address}</p>
              )}
              {menu.data.restaurant.phone && (
                <p className="text-muted mt-1 text-sm">{menu.data.restaurant.phone}</p>
              )}
              <p className="text-muted mt-4 text-sm">
                Find something you like? Ask our team to place your order.
              </p>
              {(menu.data.charges.vatRateBp > 0 || menu.data.charges.serviceChargeRateBp > 0) && (
                <p className="text-muted mt-2 text-xs">
                  Prices exclude{' '}
                  {[
                    menu.data.charges.vatRateBp > 0
                      ? `${menu.data.charges.vatRateBp / 100}% VAT`
                      : null,
                    menu.data.charges.serviceChargeRateBp > 0
                      ? `${menu.data.charges.serviceChargeRateBp / 100}% service charge`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' and ')}
                  , where applicable.
                </p>
              )}
            </section>
            <div className="border-border-2 bg-surface/95 sticky top-0 z-10 -mx-4 border-y px-4 py-3 backdrop-blur">
              <label className="block">
                <span className="sr-only">Search dishes</span>
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search dishes or set menus…"
                  className="bg-field border-border-3 focus:border-accent w-full rounded-xl border px-3 py-3 text-[1rem] outline-none"
                />
              </label>
              <nav aria-label="Menu categories" className="mt-3 flex gap-2 overflow-x-auto pb-1">
                <Category
                  label="All"
                  active={categoryId === null}
                  onClick={() => setCategoryId(null)}
                />
                {menu.data.categories.map((category) => (
                  <Category
                    key={category.id}
                    label={category.name}
                    active={categoryId === category.id}
                    onClick={() => setCategoryId(category.id)}
                  />
                ))}
              </nav>
            </div>
            <div className="text-muted my-4 flex items-center justify-between gap-3 text-xs">
              <p role="status">
                {menu.isError
                  ? 'Could not refresh. Prices and availability may have changed.'
                  : `Updated ${new Date(menu.dataUpdatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
              </p>
              <Refresh
                busy={menu.isFetching}
                onClick={() => {
                  void menu.refetch();
                }}
              />
            </div>
            {categories.length === 0 ? (
              <Message
                title={search.trim() ? 'No dishes found' : 'The menu is being prepared'}
                body={
                  search.trim()
                    ? 'Try another name or clear your search.'
                    : 'Please ask our team what’s available today.'
                }
              />
            ) : (
              <div className="space-y-7">
                {categories.map((category) => (
                  <section key={category.id} aria-label={category.name}>
                    <h2 className="mb-3 text-xl font-extrabold">
                      {category.name}
                      {category.nameNp && (
                        <span lang="ne" className="text-muted ml-2 text-[1rem] font-normal">
                          {category.nameNp}
                        </span>
                      )}
                    </h2>
                    <ul className="border-border-2 bg-surface divide-border-2 divide-y overflow-hidden rounded-card border">
                      {category.items.map((item) => (
                        <li key={item.id} className="px-4 py-4">
                          <div className="flex items-start justify-between gap-4">
                            <div className="min-w-0">
                              <h3 className="text-[1rem] font-bold">{item.name}</h3>
                              {item.promotion && (
                                <p className="text-accent mt-1 text-xs">
                                  {item.promotion.name} · {item.promotion.rateBp / 100}% off{' '}
                                  <del className="text-muted-2">
                                    {formatPaisa(item.promotion.regularUnitPricePaisa)}
                                  </del>
                                </p>
                              )}
                              {item.nameNp && (
                                <p lang="ne" className="text-muted mt-0.5 text-sm">
                                  {item.nameNp}
                                </p>
                              )}
                            </div>
                            <p className="shrink-0 font-mono text-sm font-bold tabular-nums">
                              {formatPaisa(item.pricePaisa)}
                            </p>
                          </div>
                          {item.components.length > 0 && (
                            <p className="text-muted mt-2 text-sm">
                              Set menu ·{' '}
                              {item.components
                                .map((part) => `${part.quantity} × ${part.name}`)
                                .join(', ')}
                            </p>
                          )}
                          {!item.isAvailable && (
                            <p className="text-muted mt-2 text-xs font-bold">Unavailable today</p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            )}
          </>
        )}
        <footer className="text-muted-2 mt-10 text-center text-xs">Menu by Nayaro RMS</footer>
      </div>
    </div>
  );
}

function Category({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'min-h-10 shrink-0 rounded-full border px-4 text-sm font-semibold',
        active ? 'border-accent bg-accent text-white' : 'border-border-2 bg-surface',
      )}
    >
      {label}
    </button>
  );
}
function Refresh({ busy, onClick }: { busy: boolean; onClick: () => void }): JSX.Element {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="border-border-2 min-h-10 shrink-0 rounded-lg border px-3 text-xs font-bold disabled:opacity-50"
    >
      {busy ? 'Refreshing…' : 'Refresh'}
    </button>
  );
}
function Message({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: JSX.Element;
}): JSX.Element {
  return (
    <section className="py-12 text-center">
      <h1 className="text-xl font-bold">{title}</h1>
      <p className="text-muted mx-auto mt-2 mb-4 max-w-sm text-sm">{body}</p>
      {children}
    </section>
  );
}
