import type { JSX } from 'react';
import { Link } from 'react-router';
import { BellOff, ChefHat, Clock, CreditCard, type LucideIcon, PackageX } from 'lucide-react';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/States';
import { useLowStockAlerts } from '@/features/operations/LowStockAlert';
import { useFloor } from '@/features/floor/hooks/useFloor';
import { useKitchenTickets, useNow } from '@/features/kitchen/hooks/useKitchen';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { cn } from '@/lib/utils';

export interface DashboardNotification {
  readonly id: string;
  readonly icon: LucideIcon;
  readonly tone: 'danger' | 'warning' | 'info';
  readonly title: string;
  readonly detail: string;
  readonly to: string;
  readonly action: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Things that need someone's attention now, derived from live service data.
 * Nothing here is stored; once the cause is dealt with, the notice goes away.
 */
export function useNotifications(): DashboardNotification[] {
  const lowStock = useLowStockAlerts();
  const floor = useFloor();
  const kitchen = useKitchenTickets();
  const { tenant } = useAuth();
  const now = useNow(30_000);
  const items: DashboardNotification[] = [];

  const alertMinutes = kitchen.data?.newTicketAlertMinutes ?? 5;
  for (const ticket of kitchen.data?.tickets ?? []) {
    const waited = Math.round((now - Date.parse(ticket.createdAt)) / 60_000);
    const where = ticket.tableName ?? 'Takeaway';
    if (ticket.status === 'READY') {
      items.push({
        id: `ready-${ticket.id}`,
        icon: ChefHat,
        tone: 'warning',
        title: `${where} food is ready to serve`,
        detail: `KOT ${String(ticket.kotNumber)} is waiting at the pass.`,
        to: '/kitchen',
        action: 'Kitchen board',
      });
    } else if (ticket.status === 'NEW' && waited >= alertMinutes) {
      items.push({
        id: `new-${ticket.id}`,
        icon: Clock,
        tone: 'danger',
        title: `KOT ${String(ticket.kotNumber)} not started after ${String(waited)} min`,
        detail: `${where} is still waiting for the kitchen to pick it up.`,
        to: '/kitchen',
        action: 'Kitchen board',
      });
    }
  }

  for (const area of floor.data?.areas ?? []) {
    for (const table of area.tables) {
      if (table.status !== 'AWAITING_PAYMENT') continue;
      items.push({
        id: `pay-${table.id}`,
        icon: CreditCard,
        tone: 'info',
        title: `${table.name} is waiting to pay`,
        detail: `The bill is issued in ${area.name}.`,
        to: `/billing/table/${table.id}`,
        action: 'Take payment',
      });
    }
  }

  for (const ingredient of lowStock.data?.ingredients ?? []) {
    items.push({
      id: `stock-${ingredient.id}`,
      icon: PackageX,
      tone: 'warning',
      title: `${ingredient.name} is running low`,
      detail: 'At or below its reorder level. Dishes that use it may become unavailable.',
      to: '/inventory',
      action: 'Inventory',
    });
  }

  if (tenant?.status === 'TRIAL' && tenant.subscriptionEndsAt !== null) {
    const days = Math.ceil((Date.parse(tenant.subscriptionEndsAt) - now) / DAY_MS);
    if (days <= 5) {
      items.push({
        id: 'trial',
        icon: Clock,
        tone: 'info',
        title: days <= 0 ? 'Your trial ends today' : `Your trial ends in ${String(days)} days`,
        detail: 'Contact Nayaro Technology to keep using Nayaro RMS without interruption.',
        to: '/settings',
        action: 'Settings',
      });
    }
  }
  return items;
}

const TONES = {
  danger: 'bg-danger/12 text-danger-fg',
  warning: 'bg-warn/14 text-warn-fg',
  info: 'bg-accent-soft text-accent-hover',
} as const;

export function NotificationsView({ items }: { readonly items: readonly DashboardNotification[] }): JSX.Element {
  return (
    <Card>
      {items.length === 0 ? (
        <EmptyState icon={BellOff} title="All caught up" description="Kitchen delays, unpaid tables and low stock appear here." />
      ) : (
        <ul className="divide-border divide-y">
          {items.map((item) => (
            <li key={item.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
              <span className={cn('grid size-10 shrink-0 place-items-center rounded-control', TONES[item.tone])}>
                <item.icon size={18} aria-hidden />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-bold">{item.title}</p>
                <p className="text-muted text-caption">{item.detail}</p>
              </div>
              <Link
                to={item.to}
                className="border-border-2 hover:border-border-4 rounded-control border px-3 py-1.5 text-caption font-bold"
              >
                {item.action}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
