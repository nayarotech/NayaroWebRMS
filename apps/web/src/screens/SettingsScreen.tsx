import { LoyaltySettingsPanel } from '@/features/loyalty/LoyaltySettingsPanel';
import { useState, type JSX, type ReactNode } from 'react';
import { useSearchParams } from 'react-router';
import { Building2, Gift, QrCode, Receipt, ShieldCheck, SlidersHorizontal } from 'lucide-react';
import type { SettingsResponse } from '@nayaro/shared';
import { Button } from '@/components/ui/Button';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { ErrorState, InlineAlert, LoadingState } from '@/components/ui/States';
import { Tabs, type TabItem } from '@/components/ui/Tabs';
import { Page, PageBody, PageHeader } from '@/components/layout/Page';
import { cn } from '@/lib/utils';
import { formatPaisa } from '@/lib/money';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { QrStudioPanel } from '@/features/connect/components/QrStudioPanel';
import { GuestMenuPanel } from '@/features/settings/GuestMenuPanel';
import { AuditLogPanel, SessionsPanel } from '@/features/settings/SecurityPanel';
import {
  SETTINGS_KEY,
  managementApi,
  useManagementActions,
  useSettings,
} from '@/features/management/hooks/useManagement';

/**
 * Settings.
 *
 * Every value is read from the server and written back to it.
 *
 * WHO MAY CHANGE WHAT. Tax rates, invoice identity and abbreviated-invoice
 * authorisation are OWNER-only, because each is a claim about the business:
 * enabling VAT asserts the restaurant is registered, and enabling abbreviated
 * invoices asserts the tax office authorised it. A manager may change
 * operational and display settings. The server enforces this; the UI only
 * avoids offering what would be refused.
 */
type SettingsTab = 'general' | 'billing' | 'operations' | 'loyalty' | 'guest-menu' | 'security';

const TABS: readonly TabItem<SettingsTab>[] = [
  { value: 'general', label: 'Restaurant', icon: Building2 },
  { value: 'billing', label: 'Tax & billing', icon: Receipt },
  { value: 'operations', label: 'Operations', icon: SlidersHorizontal },
  { value: 'loyalty', label: 'Loyalty', icon: Gift },
  { value: 'guest-menu', label: 'Guest menu & QR', icon: QrCode },
  { value: 'security', label: 'Security', icon: ShieldCheck },
];

export function SettingsScreen(): JSX.Element {
  const { staff } = useAuth();
  const settings = useSettings();
  const actions = useManagementActions([SETTINGS_KEY]);
  const isOwner = staff?.role === 'OWNER';
  const [params, setParams] = useSearchParams();
  const tab = (TABS.find((item) => item.value === params.get('tab'))?.value ??
    'general') as SettingsTab;

  const data = settings.data;
  const description =
    data === undefined
      ? 'How this restaurant is configured.'
      : data.updatedBy === null
        ? 'Not changed since the restaurant was registered.'
        : `Last changed by ${data.updatedBy} on ${new Date(data.updatedAt).toLocaleDateString()}.`;

  return (
    <Page>
      <PageHeader title="Settings" description={description}>
        <Tabs
          label="Settings sections"
          items={TABS}
          value={tab}
          onChange={(value) => {
            setParams({ tab: value }, { replace: true });
          }}
        />
      </PageHeader>

      {settings.isPending ? (
        <LoadingState label="Loading settings…" />
      ) : data === undefined ? (
        <Card>
          <ErrorState
            error={settings.error}
            forbiddenMessage="An owner or manager can change how the restaurant is configured."
            onRetry={() => void settings.refetch()}
          />
        </Card>
      ) : (
        <PageBody>
          {actions.error !== null && (
            <InlineAlert onDismiss={actions.clearError}>{actions.error}</InlineAlert>
          )}
          {tab === 'general' && <RestaurantPanel data={data} canEdit={isOwner} actions={actions} />}
          {tab === 'billing' && <FinancialPanel data={data} canEdit={isOwner} actions={actions} />}
          {tab === 'operations' && <OperationalPanel data={data} actions={actions} />}
          {tab === 'loyalty' && <LoyaltySettingsPanel canEdit={isOwner} />}
          {tab === 'guest-menu' && (
            <>
              <GuestMenuPanel
                enabled={data.operational.customerMenuEnabled}
                busy={actions.isSaving}
                onToggle={() => {
                  void actions.run(() =>
                    managementApi.updateOperational({
                      customerMenuEnabled: !data.operational.customerMenuEnabled,
                    }),
                  );
                }}
              />
              <QrStudioPanel />
            </>
          )}
          {tab === 'security' && (
            <>
              <SessionsPanel />
              {isOwner && <AuditLogPanel />}
            </>
          )}
        </PageBody>
      )}
    </Page>
  );
}

function RestaurantPanel({
  data,
  canEdit,
  actions,
}: {
  data: SettingsResponse;
  canEdit: boolean;
  actions: ReturnType<typeof useManagementActions>;
}): JSX.Element {
  const [draft, setDraft] = useState(data.restaurant);
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.restaurant);

  return (
    <Panel
      title="Restaurant"
      blurb="Printed on every bill as the seller. Invoices already issued keep the details they were issued with."
    >
      {!canEdit && <ReadOnlyNote>Only an owner can change the restaurant's details.</ReadOnlyNote>}
      <form
        className="flex flex-col gap-2.5"
        onSubmit={(event) => {
          event.preventDefault();
          void actions.run(() => managementApi.updateRestaurant({ ...draft }));
        }}
      >
        <TextRow
          label="Name"
          value={draft.name}
          disabled={!canEdit}
          onChange={(name) => {
            setDraft((d) => ({ ...d, name }));
          }}
        />
        <TextRow
          label="Address"
          value={draft.address}
          disabled={!canEdit}
          onChange={(address) => {
            setDraft((d) => ({ ...d, address }));
          }}
        />
        <TextRow
          label="Phone"
          value={draft.phone}
          disabled={!canEdit}
          onChange={(phone) => {
            setDraft((d) => ({ ...d, phone }));
          }}
        />
        <TextRow
          label="PAN"
          value={draft.panNumber}
          disabled={!canEdit}
          mono
          hint="Nine digits. Leave blank if the business is not registered."
          onChange={(panNumber) => {
            setDraft((d) => ({ ...d, panNumber }));
          }}
        />
        {canEdit && (
          <Button
            type="submit"
            variant="secondary"
            disabled={!dirty || actions.isSaving}
            className="mt-1 self-start"
          >
            Save details
          </Button>
        )}
      </form>
    </Panel>
  );
}

function FinancialPanel({
  data,
  canEdit,
  actions,
}: {
  data: SettingsResponse;
  canEdit: boolean;
  actions: ReturnType<typeof useManagementActions>;
}): JSX.Element {
  const f = data.financial;
  const save = (patch: Record<string, unknown>): void => {
    void actions.run(() => managementApi.updateFinancial(patch));
  };

  return (
    <Panel
      title="Tax and charges"
      blurb="Applies to bills made from now on. Invoices already issued are never recalculated."
    >
      {!canEdit && (
        <ReadOnlyNote>
          Only an owner can change tax settings — each one is a claim about the business.
        </ReadOnlyNote>
      )}

      <Toggle
        label="Charge VAT"
        hint={`Adds VAT to every bill at ${(f.vatRateBp / 100).toString()}%. Switch on only if the restaurant is VAT-registered.`}
        checked={f.vatEnabled}
        disabled={!canEdit || actions.isSaving}
        onChange={(vatEnabled) => {
          save({ vatEnabled });
        }}
      />
      {f.vatEnabled && canEdit && (
        <RateRow
          label="VAT rate"
          rateBp={f.vatRateBp}
          disabled={actions.isSaving}
          onSave={(vatRateBp) => {
            save({ vatRateBp });
          }}
        />
      )}

      <Toggle
        label="Charge service charge"
        hint={`Adds ${(f.serviceChargeRateBp / 100).toString()}% to dine-in bills.`}
        checked={f.serviceChargeEnabled}
        disabled={!canEdit || actions.isSaving}
        onChange={(serviceChargeEnabled) => {
          save({ serviceChargeEnabled });
        }}
      />
      {f.serviceChargeEnabled && canEdit && (
        <>
          <RateRow
            label="Service charge rate"
            rateBp={f.serviceChargeRateBp}
            disabled={actions.isSaving}
            onSave={(serviceChargeRateBp) => {
              save({ serviceChargeRateBp });
            }}
          />
          <Toggle
            label="Also on takeaway"
            hint="Most restaurants charge for table service only."
            checked={f.serviceChargeAppliesToTakeaway}
            disabled={actions.isSaving}
            onChange={(serviceChargeAppliesToTakeaway) => {
              save({ serviceChargeAppliesToTakeaway });
            }}
          />
        </>
      )}

      <Toggle
        label="Round totals to the rupee"
        hint="Paisa coins are not in circulation, so most restaurants round."
        checked={f.roundGrandTotalToRupee}
        disabled={!canEdit || actions.isSaving}
        onChange={(roundGrandTotalToRupee) => {
          save({ roundGrandTotalToRupee });
        }}
      />

      <Toggle
        label="Abbreviated tax invoices are authorised"
        hint={`Only switch on if the tax office authorised them. Bills up to ${formatPaisa(f.abbreviatedInvoiceCeilingPaisa)} could then be issued as abbreviated, and only when someone chooses it.`}
        checked={f.abbreviatedInvoiceAuthorized}
        disabled={!canEdit || actions.isSaving}
        onChange={(abbreviatedInvoiceAuthorized) => {
          save({ abbreviatedInvoiceAuthorized });
        }}
      />
    </Panel>
  );
}

function OperationalPanel({
  data,
  actions,
}: {
  data: SettingsResponse;
  actions: ReturnType<typeof useManagementActions>;
}): JSX.Element {
  const o = data.operational;
  const [footer, setFooter] = useState(o.billFooterText ?? '');
  const [alertMinutes, setAlertMinutes] = useState(String(o.kitchenNewTicketAlertMinutes));
  const save = (patch: Record<string, unknown>): void => {
    void actions.run(() => managementApi.updateOperational(patch));
  };

  return (
    <Panel title="Operations" blurb="Day-to-day settings. A manager can change these.">
      <form
        className="mb-4"
        onSubmit={(event) => {
          event.preventDefault();
          const minutes = Number(alertMinutes);
          if (Number.isInteger(minutes) && minutes >= 1 && minutes <= 60)
            save({ kitchenNewTicketAlertMinutes: minutes });
        }}
      >
        <label className="block">
          <span className="text-[13px] font-bold">Kitchen waiting alert</span>
          <span className="text-muted-2 mb-1.5 block text-[11.5px]">
            Highlight tickets nobody has started preparing after this many minutes (1–60). Applies
            to phones and desktop.
          </span>
          <input
            aria-label="Kitchen waiting alert minutes"
            type="number"
            min={1}
            max={60}
            step={1}
            required
            value={alertMinutes}
            disabled={actions.isSaving}
            onChange={(event) => setAlertMinutes(event.target.value)}
            className="bg-field border-border-3 w-20 rounded-lg border px-2.5 py-1.5 text-[13px]"
          />
        </label>
        <Button
          type="submit"
          variant="secondary"
          disabled={actions.isSaving || Number(alertMinutes) === o.kitchenNewTicketAlertMinutes}
          className="mt-2"
        >
          Save waiting alert
        </Button>
      </form>
      <label className="mb-3 block">
        <span className="text-[13px] font-bold">Business day starts at</span>
        <span className="text-muted-2 mb-1.5 block text-[11.5px]">
          Sales after midnight but before this time count as the previous day, so a late night lands
          in the right day's takings.
        </span>
        <input
          aria-label="Business day start hour"
          type="time"
          value={minutesToTime(o.businessDayStartsAtMinutes)}
          disabled={actions.isSaving}
          onChange={(event) => {
            const minutes = timeToMinutes(event.target.value);
            if (minutes !== null) save({ businessDayStartsAtMinutes: minutes });
          }}
          className="bg-field border-border-3 focus:border-accent-hover rounded-lg border px-2.5 py-1.5 font-mono text-[13px] outline-none"
        />
      </label>

      <Toggle
        label="Print PAN on bills"
        hint="Shows the restaurant's PAN number on printed bills."
        checked={o.printPanOnBill}
        disabled={actions.isSaving}
        onChange={(printPanOnBill) => {
          save({ printPanOnBill });
        }}
      />
      <Toggle
        label="Show Bikram Sambat date"
        hint="Prints the B.S. date alongside the A.D. date."
        checked={o.showBsDateOnBill}
        disabled={actions.isSaving}
        onChange={(showBsDateOnBill) => {
          save({ showBsDateOnBill });
        }}
      />

      <form
        className="mt-2"
        onSubmit={(event) => {
          event.preventDefault();
          save({ billFooterText: footer.trim().length === 0 ? null : footer.trim() });
        }}
      >
        <label className="block">
          <span className="text-[13px] font-bold">Bill footer</span>
          <span className="text-muted-2 mb-1.5 block text-[11.5px]">
            A line printed at the bottom of every bill.
          </span>
          <div className="flex gap-2">
            <input
              aria-label="Bill footer text"
              value={footer}
              maxLength={200}
              placeholder="Thank you, please visit again"
              onChange={(event) => {
                setFooter(event.target.value);
              }}
              className="bg-field border-border-3 focus:border-accent-hover min-w-0 flex-1 rounded-lg border px-2.5 py-1.5 text-[13px] outline-none"
            />
            <Button
              type="submit"
              variant="secondary"
              disabled={actions.isSaving || footer === (o.billFooterText ?? '')}
              className="h-9 px-3 text-[13px]"
            >
              Save
            </Button>
          </div>
        </label>
      </form>
    </Panel>
  );
}

// --- small pieces ------------------------------------------------------------

function Panel({
  title,
  blurb,
  children,
}: {
  title: string;
  blurb: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <Card>
      <CardHeader title={title} description={blurb} />
      <CardBody>
        <div className="max-w-2xl">{children}</div>
      </CardBody>
    </Card>
  );
}

function ReadOnlyNote({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p className="border-border-2 bg-surface-3 text-muted-2 mb-3 rounded-lg border px-3 py-2 text-[11.5px] font-semibold">
      {children}
    </p>
  );
}

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}): JSX.Element {
  return (
    <div className="border-border/70 flex items-start gap-3 border-b py-2.5 last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-bold">{label}</p>
        <p className="text-muted-2 text-[11.5px] leading-snug">{hint}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        onClick={() => {
          onChange(!checked);
        }}
        className={cn(
          'mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors',
          checked ? 'border-accent bg-accent' : 'border-border-3 bg-neutral-tint',
          disabled && 'opacity-50',
        )}
      >
        <span
          className={cn(
            'size-4 rounded-full bg-white transition-transform',
            checked ? 'translate-x-6' : 'translate-x-1',
          )}
        />
      </button>
    </div>
  );
}

function RateRow({
  label,
  rateBp,
  disabled,
  onSave,
}: {
  label: string;
  rateBp: number;
  disabled: boolean;
  onSave: (rateBp: number) => void;
}): JSX.Element {
  const [value, setValue] = useState((rateBp / 100).toString());
  const parsed = Number(value);
  const valid = Number.isFinite(parsed) && parsed >= 0 && parsed <= 100;

  return (
    <form
      className="border-border/70 flex items-end gap-2 border-b py-2.5"
      onSubmit={(event) => {
        event.preventDefault();
        // Percent in, basis points on the wire.
        if (valid) onSave(Math.round(parsed * 100));
      }}
    >
      <label className="min-w-0 flex-1">
        <span className="text-[13px] font-bold">{label}</span>
        <div className="mt-1 flex gap-2">
          <input
            aria-label={label}
            inputMode="decimal"
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
            }}
            className="bg-field border-border-3 focus:border-accent-hover w-24 rounded-lg border px-2.5 py-1.5 text-right font-mono text-[13px] outline-none"
          />
          <Button
            type="submit"
            variant="secondary"
            disabled={disabled || !valid || Math.round(parsed * 100) === rateBp}
            className="h-9 px-3 text-[13px]"
          >
            Save
          </Button>
        </div>
      </label>
    </form>
  );
}

function TextRow({
  label,
  value,
  disabled,
  onChange,
  mono = false,
  hint,
}: {
  label: string;
  value: string;
  disabled: boolean;
  onChange: (next: string) => void;
  mono?: boolean;
  hint?: string;
}): JSX.Element {
  return (
    <label className="block">
      <span className="text-muted mb-1 block text-[11.5px] font-semibold">{label}</span>
      <input
        aria-label={label}
        value={value}
        disabled={disabled}
        maxLength={200}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className={cn(
          'bg-field border-border-3 focus:border-accent-hover w-full rounded-lg border px-2.5 py-1.5 text-[13px] outline-none disabled:opacity-60',
          mono && 'font-mono',
        )}
      />
      {hint !== undefined && <span className="text-muted-2 mt-1 block text-[11px]">{hint}</span>}
    </label>
  );
}

function minutesToTime(minutes: number): string {
  const h = String(Math.floor(minutes / 60)).padStart(2, '0');
  const m = String(minutes % 60).padStart(2, '0');
  return `${h}:${m}`;
}

function timeToMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}
