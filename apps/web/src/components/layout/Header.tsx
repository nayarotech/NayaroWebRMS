import { useEffect, useRef, useState, type JSX } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { ChevronDown, LogOut, Menu, Moon, Sun } from 'lucide-react';
import { ConnectionBadge } from '@/components/ui/ConnectionBadge';
import { Button } from '@/components/ui/Button';
import { useTheme } from '@/hooks/useTheme';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { LowStockAlert } from '@/features/operations/LowStockAlert';
import { TrialBadge } from '@/features/tenant/TrialBadge';
import { currentSection } from '@/app/navigation';

function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('');
}

const ROLE_LABELS = {
  OWNER: 'Owner',
  MANAGER: 'Manager',
  CASHIER: 'Cashier',
  WAITER: 'Waiter',
  KITCHEN: 'Kitchen',
} as const;

export function Header({ onOpenMenu }: { readonly onOpenMenu: () => void }): JSX.Element {
  const { pathname } = useLocation();
  const section = currentSection(pathname);
  const { theme, toggleTheme } = useTheme();

  return (
    <header className="border-border bg-[var(--ny-header-bg)] sticky top-0 z-20 flex h-topbar shrink-0 items-center gap-3 border-b px-4 backdrop-blur sm:px-6 lg:px-8">
      <Button
        variant="ghost"
        iconOnly
        icon={Menu}
        aria-label="Open menu"
        onClick={onOpenMenu}
        className="lg:hidden"
      />
      {section !== null && (
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="bg-accent-soft text-accent-hover hidden size-8 place-items-center rounded-control sm:grid">
            <section.icon size={17} aria-hidden />
          </span>
          <span className="truncate text-heading font-extrabold tracking-tight">{section.label}</span>
        </div>
      )}

      <div className="ml-auto flex items-center gap-2">
        <TrialBadge />
        <LowStockAlert />
        <ConnectionBadge />
        <Button
          variant="ghost"
          iconOnly
          icon={theme === 'dark' ? Sun : Moon}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          title={theme === 'dark' ? 'Light theme' : 'Dark theme'}
          onClick={toggleTheme}
        />
        <UserMenu />
      </div>
    </header>
  );
}

function UserMenu(): JSX.Element | null {
  const { staff, tenant, signOut } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent): void => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !ref.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  if (staff === null) return null;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
        }}
        className="hover:bg-neutral-tint flex items-center gap-2.5 rounded-control py-1 pr-2 pl-1"
      >
        <span className="bg-accent grid size-8 place-items-center rounded-control text-caption font-extrabold text-white">
          {initialsOf(staff.name)}
        </span>
        <span className="hidden text-left leading-tight sm:block">
          <span className="block text-caption font-bold">{staff.name}</span>
          <span className="text-muted block text-[11px] font-semibold">{ROLE_LABELS[staff.role]}</span>
        </span>
        <ChevronDown size={15} className="text-muted hidden sm:block" aria-hidden />
      </button>
      {open && (
        <div
          role="menu"
          className="border-border bg-surface shadow-overlay animate-fade absolute right-0 mt-2 w-64 rounded-card border p-1.5"
        >
          <div className="px-3 py-2.5">
            <p className="text-body font-bold">{staff.name}</p>
            <p className="text-muted text-caption">
              {staff.username} · {ROLE_LABELS[staff.role]}
            </p>
            {tenant !== null && <p className="text-muted mt-1 truncate text-caption">{tenant.name}</p>}
          </div>
          <div className="border-border my-1 border-t" />
          <button
            type="button"
            role="menuitem"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void signOut().then(() => navigate('/login', { replace: true }));
            }}
            className="text-danger hover:bg-danger/8 flex w-full items-center gap-2.5 rounded-control px-3 py-2 text-body font-semibold"
          >
            <LogOut size={16} aria-hidden />
            {busy ? 'Signing out…' : 'Sign out'}
          </button>
        </div>
      )}
    </div>
  );
}
