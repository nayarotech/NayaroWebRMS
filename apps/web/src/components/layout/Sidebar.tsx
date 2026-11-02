import type { JSX } from 'react';
import { NavLink } from 'react-router';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { visibleNavigation } from '@/app/navigation';
import { cn } from '@/lib/utils';
import { NayaroAttribution, NayaroLogo } from './NayaroBrand';

export interface SidebarProps {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  /** Called after a link is followed, so the mobile drawer can close. */
  readonly onNavigate?: () => void;
  readonly className?: string;
}

/** A pale panel in light mode, navy in dark (see --ny-sidebar). */
export function Sidebar({ collapsed, onToggle, onNavigate, className }: SidebarProps): JSX.Element {
  const { staff, tenant } = useAuth();
  const groups = staff === null ? [] : visibleNavigation(staff);

  return (
    <nav
      aria-label="Main"
      className={cn(
        'bg-sidebar flex h-full shrink-0 flex-col border-r border-border text-text-2 transition-[width] duration-200',
        collapsed ? 'w-sidebar-collapsed' : 'w-sidebar',
        className,
      )}
    >
      <div
        className={cn(
          'flex h-topbar shrink-0 items-center gap-2',
          collapsed ? 'justify-center px-2' : 'px-5',
        )}
      >
        {collapsed ? (
          <NayaroLogo compact className="size-8" />
        ) : (
          <>
            <NayaroLogo tone="light" className="h-auto w-[132px] dark:hidden" />
            <NayaroLogo className="hidden h-auto w-[132px] dark:block" />
          </>
        )}
        {!collapsed && (
          <span className="rounded border border-accent/40 bg-accent-soft px-1.5 py-0.5 font-mono text-[10px] font-semibold tracking-widest text-accent">
            RMS
          </span>
        )}
      </div>

      {!collapsed && tenant !== null && (
        <div className="mx-3 mt-4 rounded-control bg-neutral-tint px-3 py-2.5">
          <p className="truncate text-body font-bold text-text">{tenant.name}</p>
          <p className="truncate font-mono text-[11px] text-muted-2">{tenant.workspace}</p>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
        {groups.map((group) => (
          <div key={group.label ?? 'home'} className="mb-4 last:mb-0">
            {group.label !== null && !collapsed && (
              <p className="mb-1.5 px-3 text-overline font-bold tracking-wider text-muted-3 uppercase">
                {group.label}
              </p>
            )}
            <ul className="space-y-0.5">
              {group.items.map(({ to, label, icon: Icon, description }) => (
                <li key={to}>
                  <NavLink
                    to={to}
                    end={to === '/orders/takeaway'}
                    onClick={onNavigate}
                    title={collapsed ? `${label} – ${description}` : undefined}
                    className={({ isActive }) =>
                      cn(
                        'flex items-center gap-3 rounded-control border-l-[3px] px-3 py-2 text-body font-semibold transition-colors',
                        collapsed && 'justify-center px-0',
                        isActive
                          ? 'border-accent bg-accent-soft text-text'
                          : 'border-transparent text-text-3 hover:bg-neutral-tint hover:text-text',
                      )
                    }
                  >
                    <Icon aria-hidden size={18} strokeWidth={2} className="shrink-0" />
                    {!collapsed && <span className="truncate">{label}</span>}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className={cn('shrink-0 border-t border-border p-3', collapsed && 'flex justify-center')}>
        <button
          type="button"
          onClick={onToggle}
          title={collapsed ? 'Expand sidebar (Ctrl+B)' : 'Collapse sidebar (Ctrl+B)'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="hidden items-center gap-2 rounded-control px-2 py-1.5 text-caption font-semibold text-muted hover:bg-neutral-tint hover:text-text lg:flex"
        >
          {collapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          {!collapsed && 'Collapse'}
        </button>
        {!collapsed && <NayaroAttribution className="mt-2 px-2 text-[10.5px] leading-relaxed text-muted-3" />}
      </div>
    </nav>
  );
}
