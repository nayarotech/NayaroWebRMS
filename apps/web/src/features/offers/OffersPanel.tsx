import { useState, type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import type {
  ManagedMenuCategory,
  ManagedOffer,
  OfferDefinition,
  OffersResponse,
  OfferScope,
} from '@nayaro/shared';
import { apiClient } from '@/services/apiClient';
import { Button } from '@/components/ui/Button';
import { useManagementActions } from '@/features/management/hooks/useManagement';

const OFFERS_KEY = ['management', 'offers'] as const;
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const localInput = (iso: string): string => {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

export function OffersPanel({
  categories,
}: {
  categories: readonly ManagedMenuCategory[];
}): JSX.Element {
  const offers = useQuery({
    queryKey: OFFERS_KEY,
    queryFn: () => apiClient.get<OffersResponse>('/management/offers'),
    refetchInterval: 30_000,
  });
  const actions = useManagementActions([OFFERS_KEY, ['menu'], ['management', 'menu']]);
  const [editing, setEditing] = useState<ManagedOffer | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [formKey, setFormKey] = useState(0);
  return (
    <details className="border-border-2 bg-surface mb-6 rounded-card border p-4">
      <summary className="cursor-pointer text-[1rem] font-extrabold">Promotional offers</summary>
      <p className="text-muted my-3 text-sm">
        Schedule percentage offers for dishes, categories or the whole menu. The best offer per dish
        wins. Manager-approved bill discounts apply afterwards. Prices lock when an order line is
        added; changing its quantity keeps that price.
      </p>
      <p className="text-muted mb-3 text-xs">
        Schedule times use this device’s time zone: {zone}.
      </p>
      {actions.error && (
        <p role="alert" className="text-danger-fg mb-3 text-sm">
          {actions.error}
        </p>
      )}
      {offers.isError && (
        <p role="alert" className="text-danger-fg mb-3 text-sm">
          Could not refresh offers. Refresh this screen before making changes.
        </p>
      )}
      {offers.isPending ? (
        <p className="text-muted text-sm">Loading offers…</p>
      ) : (
        <ul className="mb-3 space-y-2">
          {(offers.data?.offers ?? []).map((offer) => {
            const now = offers.dataUpdatedAt;
            const status = !offer.isActive
              ? 'Disabled'
              : now < Date.parse(offer.startsAt)
                ? 'Scheduled'
                : now >= Date.parse(offer.endsAt)
                  ? 'Ended'
                  : 'Active';
            return (
              <li
                key={offer.id}
                className="border-border-2 flex flex-wrap items-center gap-3 rounded-xl border p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-bold">
                    {offer.name} · {offer.rateBp / 100}% off · {status}
                  </p>
                  <p className="text-muted mt-1 text-xs">
                    {offer.scope === 'ALL'
                      ? 'Whole menu'
                      : offer.targetIds
                          .map((id) =>
                            offer.scope === 'ITEMS'
                              ? (categories
                                  .flatMap((category) => category.items)
                                  .find((item) => item.id === id)?.name ?? 'Unavailable dish')
                              : (categories.find((category) => category.id === id)?.name ??
                                'Unavailable category'),
                          )
                          .join(', ')}
                  </p>
                  <p className="text-muted mt-1 text-xs">
                    {new Date(offer.startsAt).toLocaleString()} –{' '}
                    {new Date(offer.endsAt).toLocaleString()}
                  </p>
                </div>
                <Button
                  variant="secondary"
                  disabled={actions.isSaving}
                  onClick={() => {
                    setEditing(offer);
                    setShowForm(true);
                    setFormKey((key) => key + 1);
                    actions.clearError();
                  }}
                >
                  Edit
                </Button>
                <Button
                  variant="secondary"
                  disabled={actions.isSaving}
                  onClick={() => {
                    void actions.run(() =>
                      apiClient.patch(`/management/offers/${offer.id}`, {
                        expectedVersion: offer.version,
                        isActive: !offer.isActive,
                      }),
                    );
                  }}
                >
                  {offer.isActive ? 'Disable' : 'Enable'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {!showForm ? (
        <Button
          variant="secondary"
          onClick={() => {
            setEditing(null);
            setShowForm(true);
            setFormKey((key) => key + 1);
          }}
        >
          Create offer
        </Button>
      ) : (
        <OfferForm
          key={formKey}
          categories={categories}
          editing={editing}
          busy={actions.isSaving}
          onCancel={() => setShowForm(false)}
          onSave={async (input) => {
            const ok = await actions.run(() =>
              editing
                ? apiClient.patch(`/management/offers/${editing.id}`, {
                    ...input,
                    expectedVersion: editing.version,
                  })
                : apiClient.post('/management/offers', input),
            );
            if (ok) {
              setShowForm(false);
              setEditing(null);
            }
          }}
        />
      )}
    </details>
  );
}

function OfferForm({
  categories,
  editing,
  busy,
  onCancel,
  onSave,
}: {
  categories: readonly ManagedMenuCategory[];
  editing: ManagedOffer | null;
  busy: boolean;
  onCancel: () => void;
  onSave: (input: OfferDefinition) => Promise<void>;
}): JSX.Element {
  const [name, setName] = useState(editing?.name ?? '');
  const [percent, setPercent] = useState(String((editing?.rateBp ?? 1000) / 100));
  const [scope, setScope] = useState<OfferScope>(editing?.scope ?? 'ALL');
  const [targets, setTargets] = useState<readonly string[]>(editing?.targetIds ?? []);
  const [start, setStart] = useState(() =>
    localInput(editing?.startsAt ?? new Date().toISOString()),
  );
  const [end, setEnd] = useState(() =>
    localInput(editing?.endsAt ?? new Date(Date.now() + 7 * 86400000).toISOString()),
  );
  const [error, setError] = useState<string | null>(null);
  const candidates =
    scope === 'ITEMS'
      ? categories
          .filter((category) => category.isActive)
          .flatMap((category) => category.items.filter((item) => item.isActive))
      : categories.filter((category) => category.isActive);
  const inputClass =
    'bg-field border-border-3 mt-1 block w-full rounded-lg border px-3 py-2 text-sm';
  return (
    <form
      className="border-border-2 rounded-xl border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        const startsAt = new Date(start),
          endsAt = new Date(end),
          rateBp = Math.round(Number(percent) * 100);
        if (
          !Number.isFinite(startsAt.getTime()) ||
          !Number.isFinite(endsAt.getTime()) ||
          endsAt <= startsAt ||
          !Number.isInteger(rateBp) ||
          rateBp < 1 ||
          rateBp > 10000 ||
          (scope !== 'ALL' && targets.length === 0)
        ) {
          setError(
            'Choose valid start/end times, a percentage from 0.01 to 100, and at least one target for item/category offers.',
          );
          return;
        }
        setError(null);
        void onSave({
          name: name.trim(),
          rateBp,
          scope,
          targetIds: scope === 'ALL' ? [] : targets,
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
          isActive: editing?.isActive ?? true,
        });
      }}
    >
      <h3 className="mb-3 text-sm font-bold">{editing ? 'Edit offer' : 'Create offer'}</h3>
      <fieldset disabled={busy} className="grid grid-cols-2 gap-3 disabled:opacity-60">
        <label className="text-sm">
          Offer name
          <input
            aria-label="Offer name"
            required
            maxLength={80}
            value={name}
            onChange={(event) => setName(event.target.value)}
            className={inputClass}
          />
        </label>
        <label className="text-sm">
          Percentage off
          <input
            aria-label="Offer percentage"
            type="number"
            min="0.01"
            max="100"
            step="0.01"
            required
            value={percent}
            onChange={(event) => setPercent(event.target.value)}
            className={inputClass}
          />
        </label>
        <label className="text-sm">
          Starts ({zone})
          <input
            aria-label="Offer starts"
            type="datetime-local"
            required
            value={start}
            onChange={(event) => setStart(event.target.value)}
            className={inputClass}
          />
        </label>
        <label className="text-sm">
          Ends ({zone})
          <input
            aria-label="Offer ends"
            type="datetime-local"
            required
            value={end}
            onChange={(event) => setEnd(event.target.value)}
            className={inputClass}
          />
        </label>
        <label className="col-span-2 text-sm">
          Applies to
          <select
            aria-label="Offer scope"
            value={scope}
            onChange={(event) => {
              setScope(event.target.value as OfferScope);
              setTargets([]);
            }}
            className={inputClass}
          >
            <option value="ALL">Whole menu</option>
            <option value="ITEMS">Selected dishes / set menus</option>
            <option value="CATEGORIES">Selected categories</option>
          </select>
        </label>
        {scope !== 'ALL' && (
          <div className="col-span-2 max-h-48 overflow-auto rounded-lg border p-2">
            {candidates.map((item) => (
              <label key={item.id} className="flex items-center gap-2 py-1 text-sm">
                <input
                  type="checkbox"
                  checked={targets.includes(item.id)}
                  onChange={(event) =>
                    setTargets((ids) =>
                      event.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id),
                    )
                  }
                />
                {item.name}
              </label>
            ))}
            {candidates.length === 0 && (
              <p className="text-muted text-sm">Add active dishes or categories first.</p>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="text-danger-fg col-span-2 text-sm">
            {error}
          </p>
        )}
        <div className="col-span-2 flex gap-2">
          <Button type="submit" disabled={busy || !name.trim()}>
            Save offer
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
