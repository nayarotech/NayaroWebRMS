import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  REALTIME_EVENTS,
  type BillingResponse,
  type DiscountType,
  type InvoiceDto,
  type InvoiceIssuedPayload,
  type InvoiceType,
  type OrderUpdatedPayload,
  type PaymentMethod,
  type PaymentRecordedPayload,
  type PaymentItemSelection,
} from '@nayaro/shared';
import { ApiRequestError, apiClient } from '@/services/apiClient';
import { subscribeToRealtimeEvent } from '@/services/socket';

export const BILLING_KEY = ['billing'] as const;

export function billingQueryKey(orderId: string): readonly unknown[] {
  return [...BILLING_KEY, orderId];
}

/**
 * The billing screen's single read.
 *
 * Returns a live pre-bill OR the issued invoice - never both, and the server
 * decides which. Reading this endpoint writes nothing: opening the screen must
 * not create a document.
 */
export function useBilling(orderId: string): UseQueryResult<BillingResponse, Error> {
  return useQuery({
    queryKey: billingQueryKey(orderId),
    queryFn: () => apiClient.get<BillingResponse>(`/orders/${orderId}/billing`),
    // A pre-bill is a live calculation over an order another terminal can still
    // change, so it is never considered fresh.
    staleTime: 0,
  });
}

/** Keeps the bill in step when the order changes or an invoice is issued. */
export function useBillingRealtime(orderId: string): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const invalidate = (): void => {
      void queryClient.invalidateQueries({ queryKey: billingQueryKey(orderId) });
      void queryClient.invalidateQueries({ queryKey: ['loyalty'] });
      void queryClient.invalidateQueries({ queryKey: ['floor'] });
      void queryClient.invalidateQueries({ queryKey: ['order'] });
    };
    const unsubscribes = [
      subscribeToRealtimeEvent<OrderUpdatedPayload>(REALTIME_EVENTS.orderUpdated, invalidate),
      subscribeToRealtimeEvent<InvoiceIssuedPayload>(REALTIME_EVENTS.invoiceIssued, invalidate),
      subscribeToRealtimeEvent<PaymentRecordedPayload>(REALTIME_EVENTS.paymentRecorded, invalidate),
    ];
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [queryClient, orderId]);
}

export interface BillingActions {
  setDiscount: (type: DiscountType, value: number) => Promise<void>;
  issue: (input: {
    invoiceType: InvoiceType;
    buyerName?: string;
    buyerPan?: string;
    buyerAddress?: string;
  }) => Promise<InvoiceDto | null>;
  /** Records money against the issued invoice. */
  pay: (input: {
    method: PaymentMethod;
    amountPaisa: number;
    items?: readonly PaymentItemSelection[];
    tenderedPaisa?: number;
    reference?: string;
    customerId?: string;
    creditAccountName?: string;
  }) => Promise<InvoiceDto | null>;
  /** Closes a bill that is genuinely for nothing. No payment row is written. */
  settleZero: () => Promise<InvoiceDto | null>;
  readonly isSaving: boolean;
  readonly notice: string | null;
  dismissNotice: () => void;
}

/**
 * Billing mutations.
 *
 * NOTHING here computes money. The client sends what the cashier chose - a
 * discount, a buyer, an invoice type - and the server returns the figures. A
 * total calculated in React would be a second implementation of the pipeline,
 * and the two would eventually disagree in front of a customer.
 */
export function useBillingActions(
  orderId: string,
  orderVersion: number | null,
  /** The order version to settle against once an invoice exists. */
  payVersion: number | null = null,
  invoiceId: string | null = null,
): BillingActions {
  const queryClient = useQueryClient();
  const [isSaving, setIsSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const run = useCallback(
    async <T>(action: () => Promise<T>): Promise<T | null> => {
      setIsSaving(true);
      try {
        const result = await action();
        setNotice(null);
        return result;
      } catch (cause: unknown) {
        setNotice(
          cause instanceof ApiRequestError && cause.kind === 'http'
            ? cause.message
            : 'Could not confirm that action. Check the refreshed bill before trying again.',
        );
        return null;
      } finally {
        // Refetch either way. After a conflict the whole point is to show the
        // cashier the total that is actually owed now.
        await queryClient.invalidateQueries({ queryKey: billingQueryKey(orderId) });
        void queryClient.invalidateQueries({ queryKey: ['loyalty'] });
        void queryClient.invalidateQueries({ queryKey: ['floor'] });
        void queryClient.invalidateQueries({ queryKey: ['order'] });
        void queryClient.invalidateQueries({ queryKey: ['customers'] });
        void queryClient.invalidateQueries({ queryKey: ['loyalty'] });
        setIsSaving(false);
      }
    },
    [orderId, queryClient],
  );

  const setDiscount = useCallback(
    async (type: DiscountType, value: number): Promise<void> => {
      if (orderVersion === null) return;
      await run(() =>
        apiClient.patch(`/orders/${orderId}/discount`, {
          expectedVersion: orderVersion,
          discountType: type,
          ...(type === 'NONE' ? {} : { discountValue: value }),
        }),
      );
    },
    [orderId, orderVersion, run],
  );

  const issue = useCallback(
    async (input: {
      invoiceType: InvoiceType;
      buyerName?: string;
      buyerPan?: string;
      buyerAddress?: string;
    }): Promise<InvoiceDto | null> => {
      if (orderVersion === null) return null;
      const result = await run(() =>
        apiClient.post<{ invoice: InvoiceDto }>(`/orders/${orderId}/invoice`, {
          expectedVersion: orderVersion,
          invoiceType: input.invoiceType,
          // Empty strings are absent, not blank values to store.
          ...(input.buyerName ? { buyerName: input.buyerName } : {}),
          ...(input.buyerPan ? { buyerPan: input.buyerPan } : {}),
          ...(input.buyerAddress ? { buyerAddress: input.buyerAddress } : {}),
        }),
      );
      return result?.invoice ?? null;
    },
    [orderId, orderVersion, run],
  );

  const pay = useCallback(
    async (input: {
      method: PaymentMethod;
      amountPaisa: number;
      items?: readonly PaymentItemSelection[];
      tenderedPaisa?: number;
      reference?: string;
      customerId?: string;
      creditAccountName?: string;
    }): Promise<InvoiceDto | null> => {
      if (invoiceId === null || payVersion === null) return null;
      const result = await run(() =>
        apiClient.postWithReceipt<{ invoice: InvoiceDto }>(`/invoices/${invoiceId}/payments`, {
          expectedOrderVersion: payVersion,
          ...input,
        }),
      );
      return result?.invoice ?? null;
    },
    [invoiceId, payVersion, run],
  );

  const settleZero = useCallback(async (): Promise<InvoiceDto | null> => {
    if (invoiceId === null || payVersion === null) return null;
    const result = await run(() =>
      apiClient.post<{ invoice: InvoiceDto }>(`/invoices/${invoiceId}/settle`, {
        expectedOrderVersion: payVersion,
      }),
    );
    return result?.invoice ?? null;
  }, [invoiceId, payVersion, run]);

  return {
    setDiscount,
    issue,
    pay,
    settleZero,
    isSaving,
    notice,
    dismissNotice: () => {
      setNotice(null);
    },
  };
}
