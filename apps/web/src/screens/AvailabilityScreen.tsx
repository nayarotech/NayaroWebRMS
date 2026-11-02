import { useMemo, useState, type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Ban, CheckCircle2, PackageX, RefreshCw, Search, UtensilsCrossed } from 'lucide-react';
import type { AvailabilityResponse } from '@nayaro/shared';
import { apiClient } from '@/services/apiClient';
import { useOperation } from '@/features/operations/useOperation';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Card } from '@/components/ui/Card';
import { Field, Input } from '@/components/ui/Field';
import { StatCard } from '@/components/ui/StatCard';
import { EmptyState, ErrorState, InlineAlert, LoadingState } from '@/components/ui/States';
import { Page, PageBody, PageHeader } from '@/components/layout/Page';
import { cn } from '@/lib/utils';

type Filter = 'all' | 'available' | 'off';

export function AvailabilityScreen(): JSX.Element {
  const action = useOperation();
  const [reason, setReason] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const data = useQuery({
    queryKey: ['availability'],
    queryFn: () => apiClient.get<AvailabilityResponse>('/menu/availability'),
    refetchInterval: 15000,
  });

  const items = useMemo(() => data.data?.items ?? [], [data.data]);
  const sellable = items.filter((row) => row.isAvailable && row.stockAvailable).length;
  const soldOut = items.filter((row) => !row.isAvailable).length;
  const short = items.filter((row) => !row.stockAvailable).length;
  const reasonReady = reason.trim().length >= 3;

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const visible = items.filter((row) => {
      if (needle && !`${row.name} ${row.category}`.toLowerCase().includes(needle)) return false;
      if (filter === 'available') return row.isAvailable && row.stockAvailable;
      if (filter === 'off') return !row.isAvailable || !row.stockAvailable;
      return true;
    });
    const byCategory = new Map<string, typeof visible>();
    for (const row of visible) byCategory.set(row.category, [...(byCategory.get(row.category) ?? []), row]);
    return [...byCategory.entries()];
  }, [items, query, filter]);

  return (
    <Page>
      <PageHeader
        title="Dish availability"
        description="Mark dishes sold out for today. Dishes short of ingredients are hidden from ordering automatically."
        actions={
          <Button variant="secondary" icon={RefreshCw} onClick={() => void data.refetch()}>
            Refresh
          </Button>
        }
      />
      <PageBody>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <StatCard
            label="Available to order"
            icon={CheckCircle2}
            tone="accent"
            value={
              <>
                {sellable}
                <span className="text-muted-3 text-heading"> / {items.length}</span>
              </>
            }
          />
          <StatCard label="Marked sold out" icon={Ban} tone={soldOut > 0 ? 'danger' : 'default'} value={soldOut} />
          <StatCard
            label="Short of ingredients"
            icon={PackageX}
            tone={short > 0 ? 'warning' : 'default'}
            value={short}
            detail="Restock in Inventory to bring them back"
          />
        </div>

        <Card className="p-4">
          <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-end">
            <Field
              label="Reason for the change"
              hint={reasonReady ? 'Recorded with every change below.' : 'Enter a reason (3+ characters) to enable the buttons, e.g. “Ran out of chicken”.'}
            >
              {({ id, describedBy }) => (
                <Input
                  id={id}
                  aria-describedby={describedBy}
                  value={reason}
                  maxLength={300}
                  placeholder="Why is availability changing?"
                  onChange={(event) => setReason(event.target.value)}
                />
              )}
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative">
                <Search
                  aria-hidden
                  size={16}
                  className="text-muted-3 pointer-events-none absolute top-1/2 left-3 -translate-y-1/2"
                />
                <Input
                  type="search"
                  value={query}
                  placeholder="Search dishes"
                  aria-label="Search dishes"
                  onChange={(event) => setQuery(event.target.value)}
                  className="w-56 pl-9"
                />
              </div>
              {(
                [
                  ['all', 'All'],
                  ['available', 'Available'],
                  ['off', 'Unavailable'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={filter === value}
                  onClick={() => setFilter(value)}
                  className={cn(
                    'h-10 rounded-full border px-4 text-caption font-bold transition-colors',
                    filter === value
                      ? 'border-accent bg-accent text-white'
                      : 'border-border-2 bg-surface text-text-2 hover:border-border-4',
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </Card>

        {action.error && <InlineAlert>{action.error}</InlineAlert>}

        {data.isPending ? (
          <LoadingState label="Loading dishes…" />
        ) : data.isError ? (
          <Card>
            <ErrorState error={data.error} onRetry={() => void data.refetch()} />
          </Card>
        ) : groups.length === 0 ? (
          <Card>
            <EmptyState icon={UtensilsCrossed} title="No dishes match" description="Try another search or filter." />
          </Card>
        ) : (
          groups.map(([category, rows]) => (
            <section key={category}>
              <h2 className="text-muted mb-2.5 flex items-center gap-2 text-overline font-bold tracking-wider uppercase">
                {category}
                <span className="bg-neutral-tint rounded-full px-1.5">{rows.length}</span>
              </h2>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {rows.map((row) => {
                  const state = !row.stockAvailable ? 'short' : row.isAvailable ? 'on' : 'off';
                  return (
                    <div
                      key={row.id}
                      className={cn(
                        'bg-surface shadow-card flex items-center gap-3 rounded-card border p-3.5',
                        state === 'on' ? 'border-border' : state === 'off' ? 'border-danger/30' : 'border-warn/40',
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          'grid size-10 shrink-0 place-items-center rounded-control text-body font-extrabold',
                          state === 'on'
                            ? 'bg-accent-soft text-accent-hover'
                            : state === 'off'
                              ? 'bg-danger/10 text-danger-fg'
                              : 'bg-warn/14 text-warn-fg',
                        )}
                      >
                        {row.name.charAt(0)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-bold">{row.name}</p>
                        <div className="mt-1">
                          {state === 'on' ? (
                            <Badge tone="success" dot>
                              Available
                            </Badge>
                          ) : state === 'off' ? (
                            <Badge tone="danger" dot>
                              Sold out
                            </Badge>
                          ) : (
                            <Badge tone="warning" dot>
                              Short of stock
                            </Badge>
                          )}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        variant={row.isAvailable ? 'danger' : 'primary'}
                        disabled={action.busy || !reasonReady}
                        title={reasonReady ? undefined : 'Enter a reason first'}
                        onClick={() =>
                          void action.run(`/menu/availability/${row.id}`, {
                            expectedIsAvailable: row.isAvailable,
                            isAvailable: !row.isAvailable,
                            reason,
                          })
                        }
                      >
                        {row.isAvailable ? 'Sold out' : 'Available'}
                      </Button>
                    </div>
                  );
                })}
              </div>
            </section>
          ))
        )}
      </PageBody>
    </Page>
  );
}
