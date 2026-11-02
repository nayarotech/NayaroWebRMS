import { hasServicePermission, type StaffDuties, type ServicePermission } from '@nayaro/shared';
import { useState, type JSX } from 'react';
import type { ManagedStaff, StaffRole } from '@nayaro/shared';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/utils';
import { ApiRequestError } from '@/services/apiClient';
import { useAuth } from '@/features/auth/hooks/useAuth';
import {
  STAFF_KEY,
  managementApi,
  useManagementActions,
  useStaffList,
} from '@/features/management/hooks/useManagement';
import { Page, PageHeader } from '@/components/layout/Page';
import { LoadingState } from '@/components/ui/States';

/**
 * Staff management.
 *
 * WHY THIS SCREEN EARNS ITS PLACE. Every financial record names a person - who
 * opened the order, who approved the discount, who took the money. Until a
 * restaurant can create real accounts, all of them say "the owner", and the
 * audit trail is only worth the columns it occupies.
 *
 * Nothing here deletes. Somebody who leaves is deactivated, and every order
 * they ever rang up still resolves to their name.
 */
const ROLES: ReadonlyArray<{ value: StaffRole; label: string; blurb: string }> = [
  { value: 'OWNER', label: 'Owner', blurb: 'Everything, including tax settings' },
  { value: 'MANAGER', label: 'Manager', blurb: 'Menu, staff, discounts, floor' },
  { value: 'CASHIER', label: 'Cashier', blurb: 'Orders, bills and payments' },
  // Ordered by authority, so the list reads as a ladder. Waiter sits below
  // cashier because it is a cashier minus the money.
  { value: 'WAITER', label: 'Waiter', blurb: 'Takes orders on a phone. No bills, no payments' },
  { value: 'KITCHEN', label: 'Kitchen', blurb: 'The kitchen board only' },
];

export function StaffScreen(): JSX.Element {
  const { staff: me } = useAuth();
  const list = useStaffList();
  const actions = useManagementActions([STAFF_KEY]);
  const [adding, setAdding] = useState(false);
  const [resettingId, setResettingId] = useState<string | null>(null);
  const [changingOwn, setChangingOwn] = useState(false);

  const isOwner = me?.role === 'OWNER';

  if (list.isPending)
    return (
      <Page>
        <LoadingState label="Loading the team…" />
      </Page>
    );

  if (list.isError && list.data === undefined) {
    const forbidden = list.error instanceof ApiRequestError && list.error.status === 403;
    return (
      <Page>
        <div className="border-border bg-surface shadow-card rounded-card border px-8 py-12 text-center">
          <h2 className="text-[18px] font-extrabold tracking-tight">
            {forbidden ? 'Staff management is not part of your role' : 'Could not load the team'}
          </h2>
          <p className="text-muted mt-2 text-[14px]">
            {forbidden
              ? 'An owner or manager can manage accounts.'
              : 'Nayaro RMS could not be reached. Check your internet connection.'}
          </p>
        </div>
      </Page>
    );
  }

  const rows = list.data?.staff ?? [];

  return (
    <Page>
      <PageHeader
        title="Staff"
        description={
          <>
            {rows.filter((s) => s.isActive).length} active of {rows.length}. Everyone who takes an
            order should have their own sign-in.
          </>
        }
        actions={
          <>
            <div className="ml-auto flex gap-2.5">
              <Button
                variant="secondary"
                onClick={() => {
                  setChangingOwn(true);
                }}
              >
                Change my password
              </Button>
              <Button
                onClick={() => {
                  setAdding(true);
                }}
              >
                Add staff
              </Button>
            </div>
          </>
        }
      />

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

      <div className="border-border bg-surface shadow-card overflow-x-auto rounded-card border">
        <table className="w-full">
          <thead className="border-border bg-surface-2 border-b">
            <tr className="text-muted text-overline font-bold tracking-wider uppercase">
              <th className="px-4 py-2.5 text-left">Staff member</th>
              <th className="px-2 py-2.5 text-left">Role</th>
              <th className="px-2 py-2.5 text-left">Service duties</th>
              <th className="px-2 py-2.5 text-left">Status</th>
              <th className="px-4 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((person) => (
              <tr
                key={person.id}
                className={cn(
                  'border-border/70 border-b last:border-b-0',
                  !person.isActive && 'opacity-55',
                )}
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-3">
                    <span className="bg-accent grid size-10 shrink-0 place-items-center rounded-full text-caption font-extrabold text-white">
                      {person.name
                        .split(/\s+/)
                        .slice(0, 2)
                        .map((part) => part.charAt(0).toUpperCase())
                        .join('')}
                    </span>
                    <div className="min-w-0">
                      <p className="font-bold">
                        {person.name}
                        {person.isSelf && (
                          <Badge tone="accent" className="ml-2">
                            You
                          </Badge>
                        )}
                      </p>
                      <p className="text-muted-2 font-mono text-caption">{person.username}</p>
                    </div>
                  </div>
                </td>
                <td className="px-2 py-2.5">
                  <RoleSelect
                    person={person}
                    canEdit={isOwner || person.role !== 'OWNER'}
                    busy={actions.isSaving}
                    onChange={(role) =>
                      void actions.run(() => managementApi.updateStaff(person.id, { role }))
                    }
                  />
                </td>
                <td className="px-2 py-2.5">
                  <ServiceDuties
                    person={person}
                    disabled={actions.isSaving || (!isOwner && person.role === 'OWNER')}
                    onChange={(duties) =>
                      void actions.run(() => managementApi.updateStaff(person.id, { ...duties }))
                    }
                  />
                </td>
                <td className="px-2 py-2.5">
                  <Badge tone={person.isActive ? 'success' : 'neutral'} dot>
                    {person.isActive ? 'Active' : 'Inactive'}
                  </Badge>
                  {person.lastLoginAt !== null && (
                    <span className="text-muted-2 block text-[11px]">
                      Last in {new Date(person.lastLoginAt).toLocaleDateString()}
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-right whitespace-nowrap">
                  {!person.isSelf && (
                    <MiniButton
                      busy={actions.isSaving}
                      onClick={() => {
                        setResettingId(person.id);
                      }}
                    >
                      Reset password
                    </MiniButton>
                  )}
                  <MiniButton
                    busy={actions.isSaving || person.isSelf}
                    onClick={() =>
                      void actions.run(() =>
                        managementApi.updateStaff(person.id, { isActive: !person.isActive }),
                      )
                    }
                  >
                    {person.isActive ? 'Deactivate' : 'Reactivate'}
                  </MiniButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-muted-2 mt-3 text-[12px]">
        Accounts are never deleted — deactivating keeps every order, bill and payment they handled
        attached to their name. Extra service duties add to the role preset; payments and management
        stay with the role. Changing duties signs the person out so they can sign in with their new
        access.
      </p>

      {adding && (
        <AddStaffForm
          canCreateOwner={isOwner}
          busy={actions.isSaving}
          onCancel={() => {
            setAdding(false);
          }}
          onSubmit={async (values) => {
            const ok = await actions.run(() => managementApi.createStaff(values));
            if (ok) setAdding(false);
          }}
        />
      )}

      {resettingId !== null && (
        <PasswordForm
          title={`Set a new password for ${rows.find((s) => s.id === resettingId)?.name ?? 'this account'}`}
          note="They will be signed out everywhere and will need the new password."
          busy={actions.isSaving}
          onCancel={() => {
            setResettingId(null);
          }}
          onSubmit={async (values) => {
            const ok = await actions.run(() =>
              managementApi.resetPassword(resettingId, values.newPassword),
            );
            if (ok) setResettingId(null);
          }}
        />
      )}

      {changingOwn && (
        <PasswordForm
          title="Change my password"
          note="You will be signed out and will need to sign in again with the new password."
          requireCurrent
          busy={actions.isSaving}
          onCancel={() => {
            setChangingOwn(false);
          }}
          onSubmit={async (values) => {
            const ok = await actions.run(() =>
              managementApi.changeOwnPassword(values.currentPassword ?? '', values.newPassword),
            );
            if (ok) setChangingOwn(false);
          }}
        />
      )}
    </Page>
  );
}

function RoleSelect({
  person,
  canEdit,
  busy,
  onChange,
}: {
  person: ManagedStaff;
  canEdit: boolean;
  busy: boolean;
  onChange: (role: StaffRole) => void;
}): JSX.Element {
  if (!canEdit) {
    return <span className="text-[13px] font-semibold">{roleLabel(person.role)}</span>;
  }
  return (
    <select
      aria-label={`Role for ${person.name}`}
      value={person.role}
      disabled={busy}
      onChange={(event) => {
        onChange(event.target.value as StaffRole);
      }}
      className="bg-field border-border-3 focus:border-accent-hover rounded-lg border px-2 py-1 text-[13px] outline-none"
    >
      {ROLES.map((role) => (
        <option key={role.value} value={role.value}>
          {role.label}
        </option>
      ))}
    </select>
  );
}

function AddStaffForm({
  canCreateOwner,
  busy,
  onCancel,
  onSubmit,
}: {
  canCreateOwner: boolean;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (
    values: { name: string; username: string; password: string; role: StaffRole } & StaffDuties,
  ) => void;
}): JSX.Element {
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<StaffRole>('CASHIER');
  const [duties, setDuties] = useState<StaffDuties>({
    canTakeOrders: false,
    canManageKitchen: false,
  });
  const valid = name.trim().length > 0 && username.trim().length >= 3 && password.length >= 8;

  return (
    <div className="border-accent/40 bg-accent/5 mt-5 rounded-card border p-4">
      <h3 className="mb-3 text-[14px] font-extrabold tracking-tight">Add a staff account</h3>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          onSubmit({ name: name.trim(), username: username.trim(), password, role, ...duties });
        }}
      >
        <Field label="Full name" value={name} onChange={setName} placeholder="Bikash Tamang" />
        <Field
          label="Username"
          value={username}
          onChange={setUsername}
          placeholder="bikash.t"
          mono
        />
        <Field
          label="Password"
          value={password}
          onChange={setPassword}
          placeholder="At least 8 characters"
          secret
        />
        <label className="block">
          <span className="text-muted mb-1 block text-[11px] font-semibold">Role</span>
          <select
            aria-label="Role"
            value={role}
            onChange={(event) => {
              setRole(event.target.value as StaffRole);
            }}
            className="bg-field border-border-3 focus:border-accent-hover rounded-lg border px-2 py-1.5 text-[13px] outline-none"
          >
            {ROLES.filter((option) => canCreateOwner || option.value !== 'OWNER').map((option) => (
              <option key={option.value} value={option.value}>
                {option.label} — {option.blurb}
              </option>
            ))}
          </select>
        </label>
        <ServiceDuties
          person={{ role, ...duties }}
          disabled={busy}
          onChange={(changes) => setDuties((current) => ({ ...current, ...changes }))}
        />
        <Button type="submit" disabled={busy || !valid} className="h-9 px-4 text-[13px]">
          Create
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} className="h-9 px-2.5 text-[13px]">
          Cancel
        </Button>
      </form>
      {!valid && (name.length > 0 || username.length > 0 || password.length > 0) && (
        <p className="text-muted-2 mt-2 text-[11.5px]">
          A name, a username of at least 3 characters and a password of at least 8 are required.
        </p>
      )}
    </div>
  );
}

function PasswordForm({
  title,
  note,
  requireCurrent = false,
  busy,
  onCancel,
  onSubmit,
}: {
  title: string;
  note: string;
  requireCurrent?: boolean;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (values: { currentPassword?: string; newPassword: string }) => void;
}): JSX.Element {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const valid = next.length >= 8 && (!requireCurrent || current.length > 0);

  return (
    <div className="border-accent/40 bg-accent/5 mt-5 rounded-card border p-4">
      <h3 className="mb-1 text-[14px] font-extrabold tracking-tight">{title}</h3>
      <p className="text-muted-2 mb-3 text-[12px]">{note}</p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          onSubmit({ ...(requireCurrent ? { currentPassword: current } : {}), newPassword: next });
        }}
      >
        {requireCurrent && (
          <Field
            label="Current password"
            value={current}
            onChange={setCurrent}
            placeholder=""
            secret
          />
        )}
        <Field
          label="New password"
          value={next}
          onChange={setNext}
          placeholder="At least 8 characters"
          secret
        />
        <Button type="submit" disabled={busy || !valid} className="h-9 px-4 text-[13px]">
          Save
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} className="h-9 px-2.5 text-[13px]">
          Cancel
        </Button>
      </form>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  secret = false,
  mono = false,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  secret?: boolean;
  mono?: boolean;
}): JSX.Element {
  return (
    <label className="block">
      <span className="text-muted mb-1 block text-[11px] font-semibold">{label}</span>
      <input
        aria-label={label}
        type={secret ? 'password' : 'text'}
        value={value}
        placeholder={placeholder}
        maxLength={200}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className={cn(
          'bg-field border-border-3 focus:border-accent-hover w-44 rounded-lg border px-2.5 py-1.5 text-[13px] outline-none',
          mono && 'font-mono',
        )}
      />
    </label>
  );
}

function MiniButton({
  children,
  busy,
  onClick,
}: {
  children: string;
  busy: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className="border-border-2 text-muted hover:border-accent-hover hover:text-accent-hover ml-1.5 rounded-lg border px-2 py-1 text-[11.5px] font-bold transition-colors disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function roleLabel(role: StaffRole): string {
  return ROLES.find((option) => option.value === role)?.label ?? role;
}

/** Preset duties cannot be removed here; these switches grant additional jobs. */
function ServiceDuties({
  person,
  disabled,
  onChange,
}: {
  person: StaffDuties & { role: StaffRole };
  disabled: boolean;
  onChange: (duties: StaffDuties) => void;
}): JSX.Element {
  const options: { key: keyof StaffDuties; permission: ServicePermission; label: string }[] = [
    { key: 'canTakeOrders', permission: 'TAKE_ORDERS', label: 'Take orders' },
    { key: 'canManageKitchen', permission: 'MANAGE_KITCHEN', label: 'Update kitchen tickets' },
  ];
  return (
    <fieldset disabled={disabled} className="flex flex-col gap-1 text-[12px]">
      <legend className="sr-only">Service duties</legend>
      {options.map(({ key, permission, label }) => {
        const preset = hasServicePermission({ role: person.role }, permission);
        return (
          <label key={key} className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={hasServicePermission(person, permission)}
              disabled={disabled || preset}
              onChange={(event) => onChange({ [key]: event.target.checked })}
            />
            {label}
            {preset && <span className="text-muted-2">(role)</span>}
          </label>
        );
      })}
    </fieldset>
  );
}
