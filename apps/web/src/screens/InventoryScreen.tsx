import { useMemo, useState, type JSX, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import {
  BookOpenCheck,
  ChefHat,
  ChevronLeft,
  ChevronRight,
  Download,
  History,
  Package,
  PackageCheck,
  PackageX,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
} from 'lucide-react';
import type { IngredientDto, InventoryResponse, AvailabilityItemDto } from '@nayaro/shared';
import { apiClient } from '@/services/apiClient';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { useOperation } from '@/features/operations/useOperation';
import { exportCsv } from '@/features/operations/files';
import { formatPaisa, parseRupees } from '@/lib/money';
import { formatDateTime, formatRelative } from '@/lib/dates';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/Button';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { DataTable } from '@/components/ui/DataTable';
import { Drawer } from '@/components/ui/Drawer';
import { Field, Input, Select } from '@/components/ui/Field';
import { StatCard } from '@/components/ui/StatCard';
import { Segmented, Tabs, type TabItem } from '@/components/ui/Tabs';
import { EmptyState, ErrorState, InlineAlert, LoadingState } from '@/components/ui/States';
import { Page, PageBody, PageHeader } from '@/components/layout/Page';

function milli(value: string): number | null {
  if (!/^\d+(\.\d{0,3})?$/.test(value.trim())) return null;
  const [whole, fraction = ''] = value.trim().split('.');
  const amount = BigInt(whole!) * 1000n + BigInt(fraction.padEnd(3, '0'));
  return amount <= 1000000000n ? Number(amount) : null;
}
function units(value: number): string {
  return (value / 1000).toLocaleString('en-IN', { maximumFractionDigits: 3 });
}
function recipeText(json: string): string {
  const rows = JSON.parse(json) as { name: string; unit: string; quantityMilli: number }[];
  return (
    rows.map((row) => `${row.name}: ${units(row.quantityMilli)} ${row.unit}`).join(', ') ||
    'No automatic deductions'
  );
}

const KIND_META: Readonly<Record<string, { label: string; tone: BadgeTone }>> = {
  PURCHASE: { label: 'Purchase', tone: 'success' },
  COUNT: { label: 'Count', tone: 'accent' },
  WASTE: { label: 'Wastage', tone: 'danger' },
  DISPATCH: { label: 'Kitchen use', tone: 'neutral' },
};

type InventoryTab = 'stock' | 'recipes' | 'history' | 'changes';

const TABS: readonly TabItem<InventoryTab>[] = [
  { value: 'stock', label: 'Stock', icon: Package },
  { value: 'recipes', label: 'Recipes', icon: ChefHat },
  { value: 'history', label: 'Stock history', icon: History },
  { value: 'changes', label: 'Change log', icon: BookOpenCheck },
];

/** Shows each ingredient's balance against twice its reorder level. */
function StockLevel({ ingredient }: { ingredient: IngredientDto }): JSX.Element {
  const scale = Math.max(ingredient.lowStockMilli * 2, 1);
  const ratio = Math.min(1, ingredient.onHandMilli / scale);
  return (
    <div className="min-w-32">
      <div className="bg-neutral-tint h-1.5 rounded-full">
        <div
          className={cn(
            'h-1.5 rounded-full',
            !ingredient.isActive ? 'bg-muted-3' : ingredient.lowStock ? 'bg-warn' : 'bg-ok',
          )}
          style={{ width: `${Math.max(3, ratio * 100)}%` }}
        />
      </div>
      <p className="text-muted mt-1 text-caption">
        Reorder at {units(ingredient.lowStockMilli)} {ingredient.unit}
      </p>
    </div>
  );
}

export function InventoryScreen(): JSX.Element {
  const { staff } = useAuth();
  const allowed = staff?.role === 'OWNER' || staff?.role === 'MANAGER';
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((item) => item.value === params.get('tab'))?.value ?? 'stock') as InventoryTab;
  const [ingredientId, setIngredientId] = useState('');
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  const before = cursors.at(-1) ?? '';
  const query = new URLSearchParams();
  if (filter) query.set('ingredientId', filter);
  if (before) query.set('before', before);
  const data = useQuery({
    queryKey: ['inventory', filter, before],
    queryFn: () => apiClient.get<InventoryResponse>(`/inventory?${query}`),
    enabled: allowed,
    refetchInterval: 15000,
  });
  const inventory = data.data;
  const selected = inventory?.ingredients.find((row) => row.id === ingredientId);
  const active = inventory?.ingredients.filter((row) => row.isActive) ?? [];
  const low = active.filter((row) => row.lowStock);
  const tracked = new Set(inventory?.recipes.map((row) => row.menuItemId) ?? []).size;

  return (
    <Page>
      <PageHeader
        title="Inventory"
        description="Ingredients, purchases, counts, wastage and recipes. Stock is deducted when tickets go to the kitchen."
        actions={
          <>
            <Button variant="secondary" icon={RefreshCw} onClick={() => void data.refetch()}>
              Refresh
            </Button>
            <Button icon={Plus} onClick={() => setAdding(true)}>
              Add ingredient
            </Button>
          </>
        }
      >
        <Tabs
          label="Inventory sections"
          items={TABS.map((item) => (item.value === 'stock' ? { ...item, count: low.length } : item))}
          value={tab}
          onChange={(value) => setParams(value === 'stock' ? {} : { tab: value }, { replace: true })}
        />
      </PageHeader>

      {data.isPending ? (
        <LoadingState label="Loading inventory…" />
      ) : !inventory ? (
        <Card>
          <ErrorState error={data.error} onRetry={() => void data.refetch()} />
        </Card>
      ) : (
        <PageBody>
          {data.isError && <InlineAlert tone="warning">Showing the last loaded stock. Refresh to try again.</InlineAlert>}

          {tab === 'stock' && (
            <>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                <StatCard label="Tracked ingredients" icon={Package} tone="accent" value={active.length} />
                <StatCard
                  label="At or below reorder level"
                  icon={PackageX}
                  tone={low.length > 0 ? 'warning' : 'default'}
                  value={
                    <>
                      {low.length}
                      <span className="text-muted-3 text-heading"> / {active.length}</span>
                    </>
                  }
                  detail={low.length > 0 ? low.map((row) => row.name).join(', ') : 'Everything is stocked'}
                />
                <StatCard
                  label="Dishes with recipes"
                  icon={PackageCheck}
                  value={
                    <>
                      {tracked}
                      <span className="text-muted-3 text-heading"> / {inventory.menu.length}</span>
                    </>
                  }
                  detail="Stock deducts automatically for these"
                />
              </div>
              <DataTable
                rows={inventory.ingredients}
                getRowId={(row) => row.id}
                searchText={(row) => row.name}
                searchPlaceholder="Search ingredients"
                initialSort={{ key: 'status', direction: 'asc' }}
                onRowClick={(row) => setIngredientId(row.id)}
                empty={{
                  icon: Package,
                  title: 'No ingredients yet',
                  description: 'Add the ingredients you buy, then attach recipes so sales deduct stock.',
                  action: (
                    <Button icon={Plus} onClick={() => setAdding(true)}>
                      Add ingredient
                    </Button>
                  ),
                }}
                columns={[
                  {
                    key: 'name',
                    header: 'Ingredient',
                    sortValue: (row) => row.name,
                    cell: (row) => (
                      <div className="flex items-center gap-3">
                        <span className="bg-accent-soft text-accent-hover grid size-9 shrink-0 place-items-center rounded-control font-extrabold">
                          {row.name.charAt(0)}
                        </span>
                        <div>
                          <p className="font-bold">{row.name}</p>
                          <p className="text-muted text-caption">Measured in {row.unit}</p>
                        </div>
                      </div>
                    ),
                  },
                  {
                    key: 'onHand',
                    header: 'On hand',
                    align: 'right',
                    className: 'font-mono font-semibold tabular-nums whitespace-nowrap',
                    sortValue: (row) => row.onHandMilli,
                    cell: (row) => `${units(row.onHandMilli)} ${row.unit}`,
                  },
                  { key: 'level', header: 'Level', hideBelow: 'md', cell: (row) => <StockLevel ingredient={row} /> },
                  {
                    key: 'status',
                    header: 'Status',
                    sortValue: (row) => (!row.isActive ? 2 : row.lowStock ? 0 : 1),
                    cell: (row) =>
                      !row.isActive ? (
                        <Badge>Inactive</Badge>
                      ) : row.lowStock ? (
                        <Badge tone="warning" dot>
                          Low stock
                        </Badge>
                      ) : (
                        <Badge tone="success" dot>
                          In stock
                        </Badge>
                      ),
                  },
                  {
                    key: 'actions',
                    header: '',
                    align: 'right',
                    cell: (row) => (
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={SlidersHorizontal}
                        onClick={(event) => {
                          event.stopPropagation();
                          setIngredientId(row.id);
                        }}
                      >
                        Adjust
                      </Button>
                    ),
                  },
                ]}
              />
            </>
          )}

          {tab === 'recipes' && <RecipesView inventory={inventory} />}

          {tab === 'history' && (
            <HistoryView
              inventory={inventory}
              filter={filter}
              hasNewer={before !== ''}
              onFilter={(value) => {
                setFilter(value);
                setCursors([]);
              }}
              onNewer={() => setCursors((rows) => rows.slice(0, -1))}
              onOlder={() => {
                const last = inventory.movements.at(-1);
                if (last) setCursors((rows) => [...rows, last.id]);
              }}
            />
          )}

          {tab === 'changes' && <ChangeLog inventory={inventory} />}
        </PageBody>
      )}

      <AddIngredientDrawer
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={(id) => {
          setAdding(false);
          setIngredientId(id);
        }}
      />
      <Drawer
        open={selected !== undefined}
        title={selected ? selected.name : 'Ingredient'}
        description={selected ? `${units(selected.onHandMilli)} ${selected.unit} on hand` : undefined}
        onClose={() => setIngredientId('')}
      >
        {selected && <StockEditor key={`${selected.id}:${selected.version}`} ingredient={selected} />}
      </Drawer>
    </Page>
  );
}

function AddIngredientDrawer({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}): JSX.Element {
  const action = useOperation();
  const [name, setName] = useState('');
  const [unit, setUnit] = useState('g');
  const [threshold, setThreshold] = useState('0');
  const valid = name.trim().length > 0 && milli(threshold) !== null;
  const submit = async (): Promise<void> => {
    const lowStockMilli = milli(threshold);
    if (lowStockMilli === null || !valid) return;
    const result = await action.run<{ ingredient: IngredientDto }>('/inventory/ingredients', {
      name,
      unit,
      lowStockMilli,
    });
    if (result) {
      setName('');
      setThreshold('0');
      onCreated(result.ingredient.id);
    }
  };
  return (
    <Drawer
      open={open}
      title="Add ingredient"
      description="The unit cannot be changed later. Record the opening stock as a purchase or count afterwards."
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={action.busy} disabled={!valid} onClick={() => void submit()}>
            Add ingredient
          </Button>
        </>
      }
    >
      <form
        className="grid gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label="Name">
          {({ id }) => <Input id={id} maxLength={100} value={name} onChange={(event) => setName(event.target.value)} />}
        </Field>
        <div>
          <p className="text-text-3 mb-1.5 text-caption font-bold">Unit</p>
          <Segmented
            label="Unit"
            value={unit}
            onChange={setUnit}
            items={[
              { value: 'g', label: 'Grams (g)' },
              { value: 'ml', label: 'Millilitres (ml)' },
              { value: 'each', label: 'Pieces (each)' },
            ]}
          />
        </div>
        <Field label={`Reorder level (${unit})`} hint="You are alerted when stock falls to this level.">
          {({ id, describedBy }) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              inputMode="decimal"
              value={threshold}
              onChange={(event) => setThreshold(event.target.value)}
              className="font-mono"
            />
          )}
        </Field>
        {action.error && <InlineAlert>{action.error}</InlineAlert>}
      </form>
    </Drawer>
  );
}

function StockEditor({ ingredient }: { ingredient: IngredientDto }): JSX.Element {
  const action = useOperation();
  const [kind, setKind] = useState('PURCHASE');
  const [quantity, setQuantity] = useState('');
  const [reason, setReason] = useState('');
  const [supplier, setSupplier] = useState('');
  const [cost, setCost] = useState('0');
  const [expenseId, setExpenseId] = useState('');
  const [method, setMethod] = useState('CASH');
  const [fromDrawer, setFromDrawer] = useState(false);
  const [low, setLow] = useState(String(ingredient.lowStockMilli / 1000));
  const quantityMilli = milli(quantity);
  const costPaisa = parseRupees(cost);
  const reasonReady = reason.trim().length >= 3;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-surface-3 border-border rounded-card border p-3">
          <p className="text-muted text-caption">On hand</p>
          <p className="font-mono text-heading font-semibold">
            {units(ingredient.onHandMilli)} {ingredient.unit}
          </p>
        </div>
        <div className="bg-surface-3 border-border rounded-card border p-3">
          <p className="text-muted text-caption">Reorder level</p>
          <p className="font-mono text-heading font-semibold">
            {units(ingredient.lowStockMilli)} {ingredient.unit}
          </p>
        </div>
      </div>

      <form
        className="grid gap-4"
        onSubmit={async (event) => {
          event.preventDefault();
          if (quantityMilli === null) return;
          await action.run(`/inventory/ingredients/${ingredient.id}/stock`, {
            expectedVersion: ingredient.version,
            kind,
            quantityMilli,
            reason,
            ...(kind === 'PURCHASE'
              ? {
                  supplier,
                  costPaisa: costPaisa ?? 0,
                  ...(expenseId ? { expenseId } : { method, fromDrawer }),
                }
              : {}),
          });
        }}
      >
        <div>
          <p className="text-text-3 mb-1.5 text-caption font-bold">Record</p>
          <Segmented
            label="Stock action"
            value={kind}
            onChange={setKind}
            items={[
              { value: 'PURCHASE', label: 'Purchase' },
              { value: 'COUNT', label: 'Stock count' },
              { value: 'WASTE', label: 'Wastage' },
            ]}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={`${kind === 'COUNT' ? 'Counted quantity' : 'Quantity'} (${ingredient.unit})`}>
            {({ id }) => (
              <Input
                id={id}
                inputMode="decimal"
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                className="font-mono"
              />
            )}
          </Field>
          <Field label="Reason">
            {({ id }) => (
              <Input id={id} maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} />
            )}
          </Field>
        </div>
        {kind === 'PURCHASE' && (
          <div className="bg-surface-3 border-border grid gap-4 rounded-card border p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Supplier">
                {({ id }) => <Input id={id} maxLength={160} value={supplier} onChange={(event) => setSupplier(event.target.value)} />}
              </Field>
              <Field label="Total cost (Rs)">
                {({ id }) => (
                  <Input id={id} inputMode="decimal" value={cost} onChange={(event) => setCost(event.target.value)} className="font-mono" />
                )}
              </Field>
            </div>
            <Field label="Existing expense reference (optional)" hint="Link an expense already recorded with its receipt.">
              {({ id, describedBy }) => (
                <Input id={id} aria-describedby={describedBy} value={expenseId} onChange={(event) => setExpenseId(event.target.value)} />
              )}
            </Field>
            {!expenseId && (
              <div className="flex flex-wrap items-end gap-4">
                <Field label="Paid by" className="w-48">
                  {({ id }) => (
                    <Select
                      id={id}
                      value={method}
                      onChange={(event) => {
                        setMethod(event.target.value);
                        setFromDrawer(false);
                      }}
                    >
                      <option value="CASH">Cash</option>
                      <option value="QR">QR / wallet</option>
                      <option value="CARD">Card</option>
                    </Select>
                  )}
                </Field>
                {method === 'CASH' && (
                  <label className="flex h-10 items-center gap-2 text-body font-semibold">
                    <input
                      type="checkbox"
                      className="accent-[var(--ny-accent)] size-4"
                      checked={fromDrawer}
                      onChange={(event) => setFromDrawer(event.target.checked)}
                    />
                    Paid from the open drawer
                  </label>
                )}
              </div>
            )}
            <p className="text-muted text-caption">
              A positive cost creates an Ingredients expense unless you link an existing one. A zero cost records stock only.
            </p>
          </div>
        )}
        <Button
          type="submit"
          loading={action.busy}
          disabled={
            !ingredient.isActive ||
            quantityMilli === null ||
            !reasonReady ||
            (kind !== 'COUNT' && quantityMilli === 0) ||
            (kind === 'PURCHASE' && costPaisa === null)
          }
        >
          Record {kind === 'PURCHASE' ? 'purchase' : kind === 'COUNT' ? 'count' : 'wastage'}
        </Button>
      </form>

      <div className="border-border space-y-3 border-t pt-5">
        <h3 className="text-heading font-extrabold">Settings</h3>
        <p className="text-muted text-caption">Uses the reason entered above.</p>
        <div className="flex flex-wrap items-end gap-3">
          <Field label={`Reorder level (${ingredient.unit})`} className="w-48">
            {({ id }) => (
              <Input id={id} inputMode="decimal" value={low} onChange={(event) => setLow(event.target.value)} className="font-mono" />
            )}
          </Field>
          <Button
            variant="secondary"
            disabled={action.busy || milli(low) === null || !reasonReady}
            onClick={() => {
              const lowStockMilli = milli(low);
              if (lowStockMilli === null) return;
              void action.run(`/inventory/ingredients/${ingredient.id}/settings`, {
                expectedVersion: ingredient.version,
                lowStockMilli,
                isActive: ingredient.isActive,
                reason,
              });
            }}
          >
            Update level
          </Button>
          <Button
            variant={ingredient.isActive ? 'danger' : 'secondary'}
            disabled={action.busy || !reasonReady}
            onClick={() =>
              void action.run(`/inventory/ingredients/${ingredient.id}/settings`, {
                expectedVersion: ingredient.version,
                lowStockMilli: ingredient.lowStockMilli,
                isActive: !ingredient.isActive,
                reason,
              })
            }
          >
            {ingredient.isActive ? 'Deactivate' : 'Reactivate'}
          </Button>
        </div>
      </div>
      {action.error && <InlineAlert>{action.error}</InlineAlert>}
    </div>
  );
}

function RecipesView({ inventory }: { inventory: InventoryResponse }): JSX.Element {
  const [menuId, setMenuId] = useState('');
  const [query, setQuery] = useState('');
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of inventory.recipes) map.set(row.menuItemId, (map.get(row.menuItemId) ?? 0) + 1);
    return map;
  }, [inventory.recipes]);
  const dishes = inventory.menu.filter((row) => row.name.toLowerCase().includes(query.trim().toLowerCase()));
  const dish = inventory.menu.find((row) => row.id === menuId);

  return (
    <div className="grid grid-cols-1 gap-5 lg:grid-cols-[340px_1fr]">
      <Card className="flex flex-col overflow-hidden lg:max-h-[calc(100dvh-16rem)]">
        <div className="border-border border-b p-3">
          <div className="relative">
            <Search aria-hidden size={16} className="text-muted-3 pointer-events-none absolute top-1/2 left-3 -translate-y-1/2" />
            <Input type="search" value={query} placeholder="Search dishes" aria-label="Search dishes" onChange={(event) => setQuery(event.target.value)} className="pl-9" />
          </div>
        </div>
        <ul className="divide-border min-h-0 flex-1 divide-y overflow-y-auto">
          {dishes.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => setMenuId(row.id)}
                className={cn(
                  'flex w-full items-center gap-3 px-4 py-3 text-left transition-colors',
                  row.id === menuId ? 'bg-accent-soft' : 'hover:bg-surface-2',
                )}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-bold">{row.name}</span>
                  <span className="text-muted text-caption">{row.category}</span>
                </span>
                {counts.has(row.id) ? (
                  <Badge tone="success">{counts.get(row.id)} ingredients</Badge>
                ) : (
                  <Badge>No recipe</Badge>
                )}
              </button>
            </li>
          ))}
        </ul>
      </Card>
      <Card>
        {dish ? (
          <>
            <CardHeader
              title={dish.name}
              description="Ingredients used for one portion. Sending a kitchen ticket deducts these quantities."
            />
            <CardBody>
              <RecipeEditor key={`${dish.id}:${dish.recipeVersion}`} dish={dish} inventory={inventory} />
            </CardBody>
          </>
        ) : (
          <EmptyState
            icon={ChefHat}
            title="Choose a dish"
            description="Select a dish to set the ingredients it uses. Refunds, cancellations and voids do not return stock automatically; record a count when ingredients really come back."
          />
        )}
      </Card>
    </div>
  );
}

function RecipeEditor({ dish, inventory }: { dish: AvailabilityItemDto; inventory: InventoryResponse }): JSX.Element {
  const action = useOperation();
  const [quantities, setQuantities] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      inventory.recipes
        .filter((row) => row.menuItemId === dish.id)
        .map((row) => [row.ingredientId, String(row.quantityMilli / 1000)]),
    ),
  );
  const [reason, setReason] = useState('');
  const invalid = inventory.ingredients.some((row) => milli(quantities[row.id] || '0') === null);
  return (
    <form
      className="space-y-5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (invalid) return;
        const ingredients = inventory.ingredients.flatMap((row) => {
          const quantityMilli = milli(quantities[row.id] || '0');
          return quantityMilli && quantityMilli > 0 ? [{ ingredientId: row.id, quantityMilli }] : [];
        });
        await action.run(`/inventory/recipes/${dish.id}`, {
          expectedVersion: dish.recipeVersion,
          reason,
          ingredients,
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {inventory.ingredients.map((row) => {
          const used = (milli(quantities[row.id] || '0') ?? 0) > 0;
          return (
            <label
              key={row.id}
              className={cn(
                'flex items-center gap-3 rounded-card border px-3 py-2.5 transition-colors',
                used ? 'border-accent/40 bg-accent-soft' : 'border-border bg-surface',
              )}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-bold">{row.name}</span>
                {!row.isActive && <span className="text-muted text-caption">Inactive</span>}
              </span>
              <span className="relative">
                <Input
                  inputMode="decimal"
                  aria-label={`${row.name} per portion`}
                  value={quantities[row.id] ?? '0'}
                  onChange={(event) => setQuantities((current) => ({ ...current, [row.id]: event.target.value }))}
                  className="w-28 pr-10 text-right font-mono"
                />
                <span className="text-muted pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-caption">
                  {row.unit}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      <Field label="Reason for the change" hint="Use zero to remove an ingredient. All zeros stops stock tracking for this dish.">
        {({ id, describedBy }) => (
          <Input id={id} aria-describedby={describedBy} maxLength={300} value={reason} onChange={(event) => setReason(event.target.value)} />
        )}
      </Field>
      {action.error && <InlineAlert>{action.error}</InlineAlert>}
      <Button type="submit" loading={action.busy} disabled={invalid || reason.trim().length < 3}>
        Save recipe
      </Button>
    </form>
  );
}

function HistoryView({
  inventory,
  filter,
  hasNewer,
  onFilter,
  onNewer,
  onOlder,
}: {
  inventory: InventoryResponse;
  filter: string;
  hasNewer: boolean;
  onFilter: (value: string) => void;
  onNewer: () => void;
  onOlder: () => void;
}): JSX.Element {
  return (
    <div className="border-border bg-surface shadow-card overflow-hidden rounded-card border">
      <div className="border-border flex flex-wrap items-center gap-3 border-b px-4 py-3">
        <Select aria-label="Filter stock history" value={filter} onChange={(event) => onFilter(event.target.value)} className="w-full sm:w-64">
          <option value="">All ingredients</option>
          {inventory.ingredients.map((row) => (
            <option key={row.id} value={row.id}>
              {row.name}
            </option>
          ))}
        </Select>
        <Button
          variant="secondary"
          icon={Download}
          className="sm:ml-auto"
          onClick={() =>
            exportCsv('stock-history.csv', [
              ['Time', 'Ingredient', 'Unit', 'Kind', 'Change', 'Balance', 'Supplier', 'Cost (Rs)', 'Expense', 'Staff', 'Reason'],
              ...inventory.movements.map((row) => [
                row.createdAt,
                row.ingredient.name,
                row.ingredient.unit,
                row.kind,
                row.deltaMilli / 1000,
                row.balanceAfterMilli / 1000,
                row.supplier,
                row.costPaisa === null ? null : (row.costPaisa / 100).toFixed(2),
                row.expenseId,
                row.staff.name,
                row.reason,
              ]),
            ])
          }
        >
          Export shown
        </Button>
      </div>
      {inventory.movements.length === 0 ? (
        <EmptyState icon={History} title="No stock movements yet" />
      ) : (
        <div className="overflow-x-auto">
          <table className="ny-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Ingredient</th>
                <th>Type</th>
                <th className="text-right">Change</th>
                <th className="text-right">Balance</th>
                <th>Purchase</th>
              </tr>
            </thead>
            <tbody>
              {inventory.movements.map((row) => {
                const meta = KIND_META[row.kind] ?? { label: row.kind, tone: 'neutral' as const };
                return (
                  <tr key={row.id}>
                    <td className="whitespace-nowrap">
                      <span title={formatDateTime(row.createdAt)}>{formatRelative(row.createdAt)}</span>
                      <p className="text-muted text-caption">{row.staff.name}</p>
                    </td>
                    <td className="font-bold">{row.ingredient.name}</td>
                    <td>
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                      <p className="text-muted mt-1 max-w-xs text-caption">{row.reason}</p>
                    </td>
                    <td
                      className={cn(
                        'text-right font-mono font-semibold whitespace-nowrap',
                        row.deltaMilli > 0 ? 'text-ok-fg' : row.deltaMilli < 0 ? 'text-danger-fg' : '',
                      )}
                    >
                      {row.deltaMilli > 0 ? '+' : ''}
                      {units(row.deltaMilli)} {row.ingredient.unit}
                    </td>
                    <td className="text-right font-mono whitespace-nowrap">
                      {units(row.balanceAfterMilli)} {row.ingredient.unit}
                    </td>
                    <td>
                      {row.supplier && <p>{row.supplier}</p>}
                      {row.costPaisa !== null && <p className="font-mono text-caption">{formatPaisa(row.costPaisa)}</p>}
                      {row.expenseId && <p className="text-muted text-caption">Expense linked</p>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="border-border flex justify-end gap-2 border-t px-4 py-2.5">
        <Button size="sm" variant="secondary" icon={ChevronLeft} disabled={!hasNewer} onClick={onNewer}>
          Newer
        </Button>
        <Button size="sm" variant="secondary" disabled={!inventory.moreMovements} onClick={onOlder}>
          Older
          <ChevronRight size={15} aria-hidden />
        </Button>
      </div>
    </div>
  );
}

function FeedItem({ title, children, when, tone }: { title: string; children: ReactNode; when: string; tone: BadgeTone }): JSX.Element {
  const dot = {
    neutral: 'bg-muted-3',
    accent: 'bg-accent',
    success: 'bg-ok',
    warning: 'bg-warn',
    danger: 'bg-danger',
  }[tone];
  return (
    <li className="relative pb-5 pl-6 last:pb-0">
      <span aria-hidden className="bg-border absolute top-2 bottom-0 left-[5px] w-px" />
      <span aria-hidden className={cn('ring-surface absolute top-1.5 left-0 size-[11px] rounded-full ring-4', dot)} />
      <div className="flex flex-wrap items-baseline gap-x-3">
        <p className="font-bold">{title}</p>
        <span className="text-muted text-caption" title={formatDateTime(when)}>
          {formatRelative(when)}
        </span>
      </div>
      <div className="text-muted mt-0.5 text-body">{children}</div>
    </li>
  );
}

/** Recipe and availability edits as a timeline: who changed what, and why. */
function ChangeLog({ inventory }: { inventory: InventoryResponse }): JSX.Element {
  const entries = [
    ...inventory.recipeChanges.map((row) => ({ kind: 'recipe' as const, at: row.createdAt, row })),
    ...inventory.availabilityChanges.map((row) => ({ kind: 'availability' as const, at: row.createdAt, row })),
  ].sort((left, right) => right.at.localeCompare(left.at));

  return (
    <Card>
      <CardHeader title="Recent recipe and availability changes" description="The latest 100 changes of each kind." />
      <CardBody>
        {entries.length === 0 ? (
          <EmptyState icon={BookOpenCheck} title="No changes yet" className="py-8" />
        ) : (
          <ul>
            {entries.map((entry) =>
              entry.kind === 'recipe' ? (
                <FeedItem key={`r-${entry.row.id}`} tone="accent" when={entry.at} title={`Recipe updated · ${entry.row.menuItem.name}`}>
                  <p>
                    {entry.row.staff.name}: “{entry.row.reason}”
                  </p>
                  <p className="text-caption">Before: {recipeText(entry.row.beforeJson)}</p>
                  <p className="text-caption">After: {recipeText(entry.row.afterJson)}</p>
                </FeedItem>
              ) : (
                <FeedItem
                  key={`a-${entry.row.id}`}
                  tone={entry.row.isAvailable ? 'success' : 'danger'}
                  when={entry.at}
                  title={`${entry.row.menuItem.name} marked ${entry.row.isAvailable ? 'available' : 'sold out'}`}
                >
                  {entry.row.staff.name}: “{entry.row.reason}”
                </FeedItem>
              ),
            )}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}
