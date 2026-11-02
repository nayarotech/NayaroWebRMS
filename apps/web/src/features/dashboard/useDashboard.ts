import { useEffect } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { REALTIME_EVENTS, type InventoryResponse, type SalesOverviewResponse } from '@nayaro/shared';
import { apiClient } from '@/services/apiClient';
import { subscribeToRealtimeEvent } from '@/services/socket';

export const OVERVIEW_KEY = ['reports', 'overview'] as const;

export function useSalesOverview(days: number): UseQueryResult<SalesOverviewResponse, Error> {
  return useQuery({
    queryKey: [...OVERVIEW_KEY, days],
    queryFn: () => apiClient.get<SalesOverviewResponse>(`/reports/overview?days=${String(days)}`),
    refetchInterval: 60_000,
  });
}

export function useInventorySnapshot(): UseQueryResult<InventoryResponse, Error> {
  return useQuery({
    queryKey: ['inventory', 'dashboard'],
    queryFn: () => apiClient.get<InventoryResponse>('/inventory'),
    refetchInterval: 60_000,
  });
}

/** Sales and service figures go stale the moment an order, bill or payment changes. */
export function useDashboardRealtime(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    const refresh = (): void => {
      void queryClient.invalidateQueries({ queryKey: OVERVIEW_KEY });
    };
    const unsubscribers = [
      REALTIME_EVENTS.invoiceIssued,
      REALTIME_EVENTS.paymentRecorded,
      REALTIME_EVENTS.orderUpdated,
      REALTIME_EVENTS.kotCreated,
      REALTIME_EVENTS.kotUpdated,
    ].map((event) => subscribeToRealtimeEvent(event, refresh));
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [queryClient]);
}
