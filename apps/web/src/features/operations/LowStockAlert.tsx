import type { JSX } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { PackageX } from 'lucide-react';
import { apiClient } from '@/services/apiClient';
import { useAuth } from '@/features/auth/hooks/useAuth';

export const INVENTORY_ALERTS_KEY = ['inventory-alerts'] as const;

export function useLowStockAlerts() {
  const { staff } = useAuth();
  return useQuery({
    queryKey: INVENTORY_ALERTS_KEY,
    queryFn: () =>
      apiClient.get<{ ingredients: { id: string; name: string }[] }>('/inventory/alerts'),
    enabled: staff?.role === 'OWNER' || staff?.role === 'MANAGER',
    refetchInterval: 30_000,
  });
}

/** Compact header indicator: ingredients at or below their reorder level. */
export function LowStockAlert(): JSX.Element | null {
  const alerts = useLowStockAlerts();
  const ingredients = alerts.data?.ingredients ?? [];
  if (ingredients.length === 0) return null;
  const names = ingredients.map((row) => row.name).join(', ');
  return (
    <Link
      to="/inventory"
      title={`Low stock: ${names}`}
      className="border-warn/30 bg-warn/10 text-warn-fg hover:bg-warn/15 hidden items-center gap-2 rounded-control border px-2.5 py-1.5 text-caption font-bold md:flex"
    >
      <PackageX size={15} aria-hidden />
      {ingredients.length === 1 ? `${ingredients[0]!.name} low` : `${String(ingredients.length)} items low`}
    </Link>
  );
}
