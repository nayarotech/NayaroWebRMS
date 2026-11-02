import { useState, type JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { LoyaltyProgram } from '@nayaro/shared';
import { apiClient } from '@/services/apiClient';
import { Button } from '@/components/ui/Button';
import { useManagementActions } from '@/features/management/hooks/useManagement';

export function LoyaltySettingsPanel({ canEdit }: { canEdit: boolean }): JSX.Element {
  const program = useQuery({
    queryKey: ['loyalty', 'settings'],
    queryFn: () => apiClient.get<LoyaltyProgram>('/loyalty/settings'),
    refetchInterval: 30_000,
  });
  const actions = useManagementActions([['loyalty'], ['management', 'settings']]);
  return (
    <section className="border-border bg-surface shadow-card rounded-card border p-5">
      <h2 className="text-[1rem] font-extrabold">Loyalty program</h2>
      <p className="text-muted mt-1 mb-3 text-xs">
        Earn points on cash, QR and card payments after a bill settles. Credit purchases do not earn
        points. Rewards reduce future bills before tax.
      </p>
      {!canEdit && (
        <p className="text-muted mb-3 text-xs">Only an owner can change loyalty rules.</p>
      )}
      {program.isError && (
        <p role="alert" className="text-danger-fg text-sm">
          Could not refresh loyalty settings.
        </p>
      )}
      {actions.error && (
        <p role="alert" className="text-danger-fg mb-3 text-sm">
          {actions.error}
        </p>
      )}
      {program.data ? (
        <ProgramForm
          key={program.data.version}
          value={program.data}
          disabled={!canEdit || actions.isSaving}
          save={(input) => {
            void actions.run(() =>
              apiClient.patch('/loyalty/settings', {
                ...input,
                expectedVersion: program.data!.version,
              }),
            );
          }}
        />
      ) : (
        <p className="text-muted text-sm">Loading loyalty settings…</p>
      )}
    </section>
  );
}
function ProgramForm({
  value,
  disabled,
  save,
}: {
  value: LoyaltyProgram;
  disabled: boolean;
  save: (input: { enabled: boolean; earnEveryPaisa: number; pointValuePaisa: number }) => void;
}): JSX.Element {
  const [enabled, setEnabled] = useState(value.enabled);
  const [earn, setEarn] = useState(String(value.earnEveryPaisa / 100));
  const [reward, setReward] = useState(String(value.pointValuePaisa / 100));
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const earnEveryPaisa = Math.round(Number(earn) * 100),
          pointValuePaisa = Math.round(Number(reward) * 100);
        if (
          Number.isInteger(earnEveryPaisa) &&
          earnEveryPaisa >= 100 &&
          Number.isInteger(pointValuePaisa) &&
          pointValuePaisa >= 1
        )
          save({ enabled, earnEveryPaisa, pointValuePaisa });
      }}
    >
      <fieldset disabled={disabled} className="space-y-3 disabled:opacity-60">
        <label className="flex items-center gap-2 text-sm font-bold">
          <input
            type="checkbox"
            aria-label="Enable loyalty program"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
          />
          Enable loyalty program
        </label>
        <label className="block text-sm">
          Spend (₨) to earn one point
          <input
            aria-label="Loyalty earning spend"
            type="number"
            min="1"
            max="1000000"
            step="0.01"
            required
            value={earn}
            onChange={(event) => setEarn(event.target.value)}
            className="bg-field border-border-3 mt-1 block w-36 rounded-lg border px-3 py-2"
          />
        </label>
        <label className="block text-sm">
          Value (₨) of one redeemed point
          <input
            aria-label="Loyalty point value"
            type="number"
            min="0.01"
            max="10000"
            step="0.01"
            required
            value={reward}
            onChange={(event) => setReward(event.target.value)}
            className="bg-field border-border-3 mt-1 block w-36 rounded-lg border px-3 py-2"
          />
        </label>
        <p className="text-muted text-xs">
          Rate changes affect new bills. Issued bills retain their earning rules. Refund adjustments
          still apply when the program is disabled.
        </p>
        <Button type="submit" variant="secondary" disabled={disabled}>
          Save loyalty settings
        </Button>
      </fieldset>
    </form>
  );
}
