import { useEffect } from 'react';
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from '@tanstack/react-query';
import {
  REALTIME_EVENTS,
  type InvoiceListResponse,
  type InvoiceListStatusFilter,
} from '@nayaro/shared';
import { apiClient } from '@/services/apiClient';
import { subscribeToRealtimeEvent } from '@/services/socket';

export const INVOICE_HISTORY_KEY = ['invoices'] as const;

export interface InvoiceHistoryFilter {
  /** Business date, "YYYY-MM-DD". Null lets the server pick today's trading day. */
  readonly date: string | null;
  readonly status: InvoiceListStatusFilter;
  readonly q: string;
}

/**
 * The bills list. Read-only: opening a row goes to the billing screen, which
 * owns reprinting, settling and voiding.
 */
export function useInvoiceHistory(
  filter: InvoiceHistoryFilter,
): UseQueryResult<InvoiceListResponse, Error> {
  const params = new URLSearchParams();
  if (filter.date !== null) {
    params.set('from', filter.date);
    params.set('to', filter.date);
  }
  if (filter.status !== 'ALL') params.set('status', filter.status);
  if (filter.q.trim().length > 0) params.set('q', filter.q.trim());
  const search = params.toString();

  return useQuery({
    queryKey: [...INVOICE_HISTORY_KEY, search],
    queryFn: () =>
      apiClient.get<InvoiceListResponse>(`/invoices${search.length > 0 ? `?${search}` : ''}`),
    // Typing in the search box should not blank the table between keystrokes.
    placeholderData: keepPreviousData,
  });
}

/** A bill issued, paid or voided on another terminal shows up without a refresh. */
export function useInvoiceHistoryRealtime(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const invalidate = (): void => {
      void queryClient.invalidateQueries({ queryKey: INVOICE_HISTORY_KEY });
    };
    const unsubscribes = [
      subscribeToRealtimeEvent(REALTIME_EVENTS.invoiceIssued, invalidate),
      subscribeToRealtimeEvent(REALTIME_EVENTS.paymentRecorded, invalidate),
      // Voids announce themselves as order updates.
      subscribeToRealtimeEvent(REALTIME_EVENTS.orderUpdated, invalidate),
    ];
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [queryClient]);
}
