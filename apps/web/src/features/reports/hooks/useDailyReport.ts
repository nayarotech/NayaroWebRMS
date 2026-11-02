import { useEffect } from 'react';
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import { REALTIME_EVENTS, type DailyReportResponse } from '@nayaro/shared';
import { apiClient } from '@/services/apiClient';
import { subscribeToRealtimeEvent } from '@/services/socket';

export const REPORTS_KEY = ['reports'] as const;

/** The Z report for a business date. Null asks the server for today's trading day. */
export function useDailyReport(date: string | null): UseQueryResult<DailyReportResponse, Error> {
  return useQuery({
    queryKey: [...REPORTS_KEY, 'daily', date],
    queryFn: () =>
      apiClient.get<DailyReportResponse>(
        `/reports/daily${date === null ? '' : `?date=${encodeURIComponent(date)}`}`,
      ),
    placeholderData: keepPreviousData,
  });
}

/** Today's report keeps up with the floor while it is open on screen. */
export function useDailyReportRealtime(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const invalidate = (): void => {
      void queryClient.invalidateQueries({ queryKey: REPORTS_KEY });
    };
    const unsubscribes = [
      subscribeToRealtimeEvent(REALTIME_EVENTS.invoiceIssued, invalidate),
      subscribeToRealtimeEvent(REALTIME_EVENTS.paymentRecorded, invalidate),
      subscribeToRealtimeEvent(REALTIME_EVENTS.orderUpdated, invalidate),
      subscribeToRealtimeEvent(REALTIME_EVENTS.kotUpdated, invalidate),
    ];
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [queryClient]);
}
