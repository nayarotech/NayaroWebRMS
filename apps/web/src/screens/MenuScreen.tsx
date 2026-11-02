import { OffersPanel } from '@/features/offers/OffersPanel';
import { useMemo, useState, type JSX } from 'react';
import type { ComboComponent, ManagedMenuCategory, ManagedMenuItem } from '@nayaro/shared';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { formatPaisa } from '@/lib/money';
import { ApiRequestError } from '@/services/apiClient';
import {
  MANAGED_MENU_KEY,
  managementApi,
  useManagedMenu,
  useManagementActions,
  useMenuRealtime,
} from '@/features/management/hooks/useManagement';
import { Page, PageHeader } from '@/components/layout/Page';
import { LoadingState } from '@/components/ui/States';

/**
 * Menu management.
 *
 * A MANAGEMENT screen, not a second POS. The till is built for speed with big
 * tappable tiles; this is built for editing - a list, a price, a toggle. Two
 * screens for two jobs, and duplicating the POS grid here would mean every
 * future menu feature had to be built twice.
 *
 * Availability is the control that gets used every day, so it sits on the row
 * itself as a single tap. Everything else lives behind an edit action.
 */
export function MenuScreen(): JSX.Element {
  const menu = useManagedMenu();
  useMenuRealtime();
  const actions = useManagementActions([MANAGED_MENU_KEY, ['menu']]);

  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null);
  const [addingCategory, setAddingCategory] = useState(false);
  const [addingItem, setAddingItem] = useState(false);
  const [components, setComponents] = useState<readonly ComboComponent[]>([]);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);

  const categories = useMemo(() => menu.data?.categories ?? [], [menu.data]);
  // Derived, not synchronised: if a category disappears the fallback lands on
  // the first one without an effect that fights the query.
  const selected =
    categories.find((category) => category.id === selectedCategoryId) ?? categories[0];

  if (menu.isPending)
    return (
      <Page>
        <LoadingState label="Loading the menu…" />
      </Page>
    );

  if (menu.isError && menu.data === undefined) {
    const forbidden = menu.error instanceof ApiRequestError && menu.error.status === 403;
    return (
      <Page>
        <div className="border-border bg-surface shadow-card rounded-card border px-8 py-12 text-center">
          <h2 className="text-[18px] font-extrabold tracking-tight">
            {forbidden ? 'Menu management is not part of your role' : 'Could not load the menu'}
          </h2>
          <p className="text-muted mt-2 text-[14px]">
            {forbidden
              ? 'An owner or manager can change what the restaurant sells.'
              : 'Nayaro RMS could not be reached. Check your internet connection.'}
          </p>
        </div>
      </Page>
    );
  }

  return (
    <Page>
      <PageHeader
        title="Menu"
        description={
          <>
            {categories.length === 0
              ? 'Nothing on the menu yet.'
              : `${String(categories.flatMap((c) => c.items).length)} items in ${String(categories.length)} categories.`}
          </>
        }
        actions={
          <>
            <div className="ml-auto flex gap-2.5">
              <Button
                variant="secondary"
                onClick={() => {
                  setAddingCategory(true);
                }}
              >
                Add category
              </Button>
              {selected !== undefined && (
                <Button
                  onClick={() => {
                    setComponents([]);
                    setAddingItem(true);
                  }}
                >
                  Add item / set menu
                </Button>
              )}
            </div>
          </>
        }
      />

      <OffersPanel categories={categories} />

      {actions.error !== null && (
        <p
          role="alert"
          className="border-danger/40 bg-danger/8 text-danger-fg mb-4 rounded-xl border px-3.5 py-2.5 text-[13px] font-semibold"
        >
          {actions.error}
          <button
            type="button"
            onClick={actions.clearError}
            className="ml-2 underline underline-offset-2"
          >
            Dismiss
          </button>
        </p>
      )}

      {categories.length === 0 ? (
        <EmptyMenu
          onAdd={() => {
            setAddingCategory(true);
          }}
        />
      ) : (
        <div className="grid grid-cols-[minmax(0,260px)_1fr] gap-6">
          <CategoryList
            categories={categories}
            selectedId={selected?.id ?? null}
            busy={actions.isSaving}
            onSelect={setSelectedCategoryId}
            onToggleActive={(category) =>
              void actions.run(() =>
                managementApi.updateCategory(category.id, { isActive: !category.isActive }),
              )
            }
            onRename={(category, name) =>
              void actions.run(() => managementApi.updateCategory(category.id, { name }))
            }
          />

          {selected === undefined ? null : (
            <ItemTable
              category={selected}
              allItems={categories.flatMap((c) => c.items)}
              busy={actions.isSaving}
              editingItemId={editingItemId}
              onEdit={setEditingItemId}
              onSave={async (item, patch) => {
                const ok = await actions.run(() => managementApi.updateItem(item.id, patch));
                if (ok) setEditingItemId(null);
              }}
              onToggleAvailable={(item) =>
                void actions.run(() =>
                  managementApi.updateItem(item.id, { isAvailable: !item.isAvailable }),
                )
              }
              onToggleActive={(item) =>
                void actions.run(() =>
                  managementApi.updateItem(item.id, { isActive: !item.isActive }),
                )
              }
            />
          )}
        </div>
      )}

      {addingCategory && (
        <AddDialog
          title="Add a category"
          fields={[
            { key: 'name', label: 'Name', placeholder: 'Momo' },
            { key: 'nameNp', label: 'Nepali name (optional)', placeholder: 'मम' },
          ]}
          busy={actions.isSaving}
          onCancel={() => {
            setAddingCategory(false);
          }}
          onSubmit={async (values) => {
            const ok = await actions.run(() =>
              managementApi.createCategory({
                name: values['name'] ?? '',
                ...(values['nameNp'] ? { nameNp: values['nameNp'] } : {}),
              }),
            );
            if (ok) setAddingCategory(false);
          }}
        />
      )}

      {addingItem && selected !== undefined && (
        <AddDialog
          title={`Add an item or set menu to ${selected.name}`}
          extra={
            <BundleFields
              items={categories.flatMap((c) => c.items)}
              value={components}
              onChange={setComponents}
            />
          }
          fields={[
            { key: 'name', label: 'Name', placeholder: 'Chicken Momo' },
            { key: 'nameNp', label: 'Nepali name (optional)', placeholder: 'चिकन मम' },
            { key: 'price', label: 'Price (₨)', placeholder: '220' },
          ]}
          busy={actions.isSaving}
          onCancel={() => {
            setAddingItem(false);
          }}
          onSubmit={async (values) => {
            const rupees = Number(values['price']);
            if (!Number.isFinite(rupees) || rupees < 0) return;
            const ok = await actions.run(() =>
              managementApi.createItem({
                categoryId: selected.id,
                name: values['name'] ?? '',
                ...(values['nameNp'] ? { nameNp: values['nameNp'] } : {}),
                // Rupees in, paisa on the wire. Rounded, because 220.1 * 100
                // is 22009.999... often enough to matter.
                pricePaisa: Math.round(rupees * 100),
                components,
              }),
            );
            if (ok) setAddingItem(false);
          }}
        />
      )}
    </Page>
  );
}

function EmptyMenu({ onAdd }: { onAdd: () => void }): JSX.Element {
  return (
    <div className="border-border-3 bg-surface rounded-card border border-dashed px-8 py-12 text-center">
      <h2 className="text-[19px] font-extrabold tracking-tight">Your menu is empty</h2>
      <p className="text-muted mx-auto mt-2 max-w-sm text-[14px] leading-relaxed">
        Start with a category — Momo, Chowmein, Drinks — then add the dishes that belong in it.
        Nothing can be sold until there is something on the menu.
      </p>
      <Button className="mt-6" size="lg" onClick={onAdd}>
        Add the first category
      </Button>
    </div>
  );
}

function CategoryList({
  categories,
  selectedId,
  busy,
  onSelect,
  onToggleActive,
  onRename,
}: {
  categories: readonly ManagedMenuCategory[];
  selectedId: string | null;
  busy: boolean;
  onSelect: (id: string) => void;
  onToggleActive: (category: ManagedMenuCategory) => void;
  onRename: (category: ManagedMenuCategory, name: string) => void;
}): JSX.Element {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  return (
    <section aria-label="Categories">
      <h2 className="text-muted mb-2.5 font-mono text-[11px] font-semibold tracking-widest uppercase">
        Categories
      </h2>
      <div className="flex flex-col gap-1.5">
        {categories.map((category) => (
          <div
            key={category.id}
            className={cn(
              'rounded-xl border px-3 py-2.5 transition-colors',
              selectedId === category.id
                ? 'border-accent bg-accent/10'
                : 'border-border-2 bg-surface',
              !category.isActive && 'opacity-60',
            )}
          >
            {renamingId === category.id ? (
              <form
                className="flex gap-1.5"
                onSubmit={(event) => {
                  event.preventDefault();
                  const trimmed = draft.trim();
                  if (trimmed.length > 0 && trimmed !== category.name) onRename(category, trimmed);
                  setRenamingId(null);
                }}
              >
                {/* Focused on mount: the user pressed Rename. */}
                <input
                  autoFocus
                  aria-label="Category name"
                  value={draft}
                  maxLength={80}
                  onChange={(event) => {
                    setDraft(event.target.value);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Escape') setRenamingId(null);
                  }}
                  className="bg-field border-accent-hover min-w-0 flex-1 rounded-lg border px-2 py-1 text-[13px] outline-none"
                />
                <MiniButton busy={busy} type="submit">
                  Save
                </MiniButton>
              </form>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    onSelect(category.id);
                  }}
                  className="flex w-full items-center gap-2 text-left"
                >
                  <span className="min-w-0 flex-1 truncate text-[13.5px] font-bold">
                    {category.name}
                    {category.nameNp !== null && (
                      <span className="text-muted-2 ml-1.5 text-[11.5px]">{category.nameNp}</span>
                    )}
                  </span>
                  <span className="text-muted-2 font-mono text-[10.5px]">
                    {category.items.length}
                  </span>
                </button>
                <div className="mt-1.5 flex gap-1">
                  <MiniButton
                    busy={busy}
                    onClick={() => {
                      setDraft(category.name);
                      setRenamingId(category.id);
                    }}
                  >
                    Rename
                  </MiniButton>
                  <MiniButton
                    busy={busy}
                    onClick={() => {
                      onToggleActive(category);
                    }}
                  >
                    {category.isActive ? 'Hide' : 'Show'}
                  </MiniButton>
                  {!category.isActive && (
                    <span className="text-muted-2 border-border-2 ml-auto rounded-md border px-1.5 py-0.5 text-[10px] font-bold">
                      Hidden
                    </span>
                  )}
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function ItemTable({
  category,
  allItems,
  busy,
  editingItemId,
  onEdit,
  onSave,
  onToggleAvailable,
  onToggleActive,
}: {
  category: ManagedMenuCategory;
  allItems: readonly ManagedMenuItem[];
  busy: boolean;
  editingItemId: string | null;
  onEdit: (id: string | null) => void;
  onSave: (item: ManagedMenuItem, patch: Record<string, unknown>) => void;
  onToggleAvailable: (item: ManagedMenuItem) => void;
  onToggleActive: (item: ManagedMenuItem) => void;
}): JSX.Element {
  return (
    <section aria-label="Items" className="min-w-0">
      <h2 className="text-muted mb-2.5 font-mono text-[11px] font-semibold tracking-widest uppercase">
        {category.name}
      </h2>

      {category.items.length === 0 ? (
        <p className="border-border-2 text-muted-2 rounded-card border border-dashed px-4 py-8 text-center text-[13px]">
          No items in {category.name} yet.
        </p>
      ) : (
        <div className="border-border-2 bg-surface overflow-hidden rounded-card border">
          <table className="w-full">
            <thead className="border-border bg-surface-2 border-b">
              <tr className="text-muted font-mono text-[10.5px] font-semibold tracking-widest uppercase">
                <th className="px-4 py-2.5 text-left">Item</th>
                <th className="px-2 py-2.5 text-right">Price</th>
                <th className="px-2 py-2.5 text-center">Available</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {category.items.map((item) => (
                <tr
                  key={item.id}
                  className={cn(
                    'border-border/70 border-b last:border-b-0',
                    !item.isActive && 'opacity-55',
                  )}
                >
                  {editingItemId === item.id ? (
                    <EditRow
                      item={item}
                      allItems={allItems}
                      busy={busy}
                      onCancel={() => {
                        onEdit(null);
                      }}
                      onSave={(patch) => {
                        onSave(item, patch);
                      }}
                    />
                  ) : (
                    <>
                      <td className="px-4 py-2.5">
                        <span className="text-[14px] font-bold">{item.name}</span>
                        {item.components.length > 0 && (
                          <p className="text-muted text-xs">
                            Set menu ·{' '}
                            {item.components
                              .map(
                                (part) =>
                                  `${part.quantity} × ${allItems.find((dish) => dish.id === part.menuItemId)?.name ?? 'Unavailable dish'}`,
                              )
                              .join(', ')}
                          </p>
                        )}
                        {item.nameNp !== null && (
                          <span className="text-muted-2 ml-2 text-[12px]">{item.nameNp}</span>
                        )}
                        {!item.isActive && (
                          <span className="text-muted-2 border-border-2 ml-2 rounded-md border px-1.5 py-0.5 text-[10px] font-bold">
                            Off the menu
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2.5 text-right font-mono text-[13.5px] font-bold tabular-nums">
                        {formatPaisa(item.pricePaisa)}
                      </td>
                      <td className="px-2 py-2.5 text-center">
                        {/*
                         * The one control used every day: a dish runs out and
                         * somebody flips it in a single tap, from wherever
                         * they are standing.
                         */}
                        <button
                          type="button"
                          role="switch"
                          aria-checked={item.isAvailable}
                          aria-label={`${item.name} available`}
                          disabled={busy || !item.isActive}
                          onClick={() => {
                            onToggleAvailable(item);
                          }}
                          className={cn(
                            'inline-flex h-6 w-11 items-center rounded-full border transition-colors',
                            item.isAvailable
                              ? 'border-ok bg-ok/80'
                              : 'border-border-3 bg-neutral-tint',
                            (busy || !item.isActive) && 'opacity-50',
                          )}
                        >
                          <span
                            className={cn(
                              'size-4 rounded-full bg-white transition-transform',
                              item.isAvailable ? 'translate-x-6' : 'translate-x-1',
                            )}
                          />
                        </button>
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <MiniButton
                          busy={busy}
                          onClick={() => {
                            onEdit(item.id);
                          }}
                        >
                          Edit
                        </MiniButton>
                        <MiniButton
                          busy={busy}
                          onClick={() => {
                            onToggleActive(item);
                          }}
                        >
                          {item.isActive ? 'Remove' : 'Restore'}
                        </MiniButton>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function EditRow({
  item,
  allItems,
  busy,
  onCancel,
  onSave,
}: {
  item: ManagedMenuItem;
  allItems: readonly ManagedMenuItem[];
  busy: boolean;
  onCancel: () => void;
  onSave: (patch: Record<string, unknown>) => void;
}): JSX.Element {
  const [components, setComponents] = useState(item.components);
  const [name, setName] = useState(item.name);
  const [nameNp, setNameNp] = useState(item.nameNp ?? '');
  const [price, setPrice] = useState((item.pricePaisa / 100).toFixed(2));

  return (
    <td colSpan={4} className="px-4 py-3">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const rupees = Number(price);
          if (name.trim().length === 0 || !Number.isFinite(rupees) || rupees < 0) return;
          onSave({
            name: name.trim(),
            nameNp: nameNp.trim().length === 0 ? null : nameNp.trim(),
            pricePaisa: Math.round(rupees * 100),
            components,
          });
        }}
      >
        <Labelled label="Name">
          <input
            autoFocus
            aria-label="Item name"
            value={name}
            maxLength={80}
            onChange={(event) => {
              setName(event.target.value);
            }}
            className="bg-field border-border-3 focus:border-accent-hover w-48 rounded-lg border px-2 py-1.5 text-[13px] outline-none"
          />
        </Labelled>
        <Labelled label="Nepali name">
          <input
            aria-label="Item Nepali name"
            value={nameNp}
            maxLength={80}
            onChange={(event) => {
              setNameNp(event.target.value);
            }}
            className="bg-field border-border-3 focus:border-accent-hover w-40 rounded-lg border px-2 py-1.5 text-[13px] outline-none"
          />
        </Labelled>
        <Labelled label="Price (₨)">
          <input
            aria-label="Item price"
            inputMode="decimal"
            value={price}
            onChange={(event) => {
              setPrice(event.target.value);
            }}
            className="bg-field border-border-3 focus:border-accent-hover w-28 rounded-lg border px-2 py-1.5 text-right font-mono text-[13px] outline-none"
          />
        </Labelled>
        <BundleFields
          items={allItems.filter((dish) => dish.id !== item.id)}
          value={components}
          onChange={setComponents}
        />
        <Button type="submit" variant="secondary" disabled={busy} className="h-9 px-3 text-[13px]">
          Save
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} className="h-9 px-2.5 text-[13px]">
          Cancel
        </Button>
      </form>
    </td>
  );
}

function AddDialog({
  title,
  extra,
  fields,
  busy,
  onCancel,
  onSubmit,
}: {
  title: string;
  extra?: JSX.Element;
  fields: readonly { key: string; label: string; placeholder: string }[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (values: Record<string, string>) => void;
}): JSX.Element {
  const [values, setValues] = useState<Record<string, string>>({});

  return (
    <div className="border-accent/40 bg-accent/5 mt-5 rounded-card border p-4">
      <h3 className="mb-3 text-[14px] font-extrabold tracking-tight">{title}</h3>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(values);
        }}
      >
        {fields.map((field, index) => (
          <Labelled key={field.key} label={field.label}>
            <input
              autoFocus={index === 0}
              aria-label={field.label}
              placeholder={field.placeholder}
              value={values[field.key] ?? ''}
              maxLength={80}
              onChange={(event) => {
                setValues((current) => ({ ...current, [field.key]: event.target.value }));
              }}
              className="bg-field border-border-3 focus:border-accent-hover w-44 rounded-lg border px-2.5 py-1.5 text-[13px] outline-none"
            />
          </Labelled>
        ))}
        {extra}
        <Button
          type="submit"
          disabled={busy || (values['name'] ?? '').trim().length === 0}
          className="h-9 px-4 text-[13px]"
        >
          Add
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} className="h-9 px-2.5 text-[13px]">
          Cancel
        </Button>
      </form>
    </div>
  );
}

function Labelled({ label, children }: { label: string; children: JSX.Element }): JSX.Element {
  return (
    <label className="block">
      <span className="text-muted mb-1 block text-[11px] font-semibold">{label}</span>
      {children}
    </label>
  );
}

function MiniButton({
  children,
  busy,
  onClick,
  type = 'button',
}: {
  children: string;
  busy: boolean;
  onClick?: () => void;
  type?: 'button' | 'submit';
}): JSX.Element {
  return (
    <button
      type={type}
      disabled={busy}
      {...(onClick === undefined ? {} : { onClick })}
      className="border-border-2 text-muted hover:border-accent-hover hover:text-accent-hover ml-1 shrink-0 rounded-lg border px-2 py-1 text-[11.5px] font-bold transition-colors disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function BundleFields({
  items,
  value,
  onChange,
}: {
  items: readonly ManagedMenuItem[];
  value: readonly ComboComponent[];
  onChange: (value: readonly ComboComponent[]) => void;
}): JSX.Element {
  const candidates = items.filter((item) => item.isActive && item.components.length === 0);
  return (
    <fieldset className="border-border-2 w-full rounded-lg border p-3">
      <legend className="text-sm font-semibold">Combo / set menu dishes (optional)</legend>
      <p className="text-muted mb-2 text-xs">
        Leave empty for a single dish. A set menu uses the price above and consumes each dish’s
        ingredients. Cancellations apply to the whole set.
      </p>
      {value.map((part) => (
        <div key={part.menuItemId} className="mb-2 flex items-center gap-2">
          <span className="flex-1 text-sm">
            {items.find((item) => item.id === part.menuItemId)?.name ?? 'Unavailable dish'}
          </span>
          <input
            aria-label={`Quantity of ${items.find((item) => item.id === part.menuItemId)?.name ?? 'dish'}`}
            type="number"
            min={1}
            max={99}
            required
            value={part.quantity}
            className="bg-field w-20 rounded border px-2 py-1"
            onChange={(event) =>
              onChange(
                value.map((row) =>
                  row.menuItemId === part.menuItemId
                    ? { ...row, quantity: Number(event.target.value) }
                    : row,
                ),
              )
            }
          />
          <button
            type="button"
            className="text-sm underline"
            onClick={() => onChange(value.filter((row) => row.menuItemId !== part.menuItemId))}
          >
            Remove dish
          </button>
        </div>
      ))}
      <select
        aria-label="Add dish to set menu"
        value=""
        className="bg-field max-w-full rounded border px-2 py-1 text-sm"
        disabled={value.length >= 30}
        onChange={(event) => {
          if (event.target.value)
            onChange([...value, { menuItemId: event.target.value, quantity: 1 }]);
        }}
      >
        <option value="">Add a dish…</option>
        {candidates
          .filter((item) => !value.some((part) => part.menuItemId === item.id))
          .map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
      </select>
    </fieldset>
  );
}
