import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CustomerDto,
  CustomerListResponse,
  CustomerRequest,
  CustomerStatementResponse,
  RepaymentRequest,
  UnassignedCreditResponse,
} from '@nayaro/shared';
import { apiClient, ApiRequestError } from '@/services/apiClient';

export function useCustomers(search = '', enabled = true) {
  return useQuery({
    queryKey: ['customers', 'list', search],
    queryFn: () =>
      apiClient.get<CustomerListResponse>(`/customers?search=${encodeURIComponent(search)}`),
    enabled,
    refetchInterval: 15_000,
  });
}
export function useStatement(id: string | undefined) {
  return useQuery({
    queryKey: ['customers', 'statement', id],
    queryFn: () => apiClient.get<CustomerStatementResponse>(`/customers/${id!}/statement`),
    enabled: id !== undefined,
    refetchInterval: 15_000,
  });
}
export function useUnassignedCredit() {
  return useQuery({
    queryKey: ['customers', 'unassigned'],
    queryFn: () => apiClient.get<UnassignedCreditResponse>('/credit/unassigned'),
    refetchInterval: 15_000,
  });
}
export function useCreditActions() {
  const cache = useQueryClient();
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(
    action: () => Promise<CustomerStatementResponse>,
  ): Promise<CustomerDto | null> {
    if (locked.current) return null;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      return result.customer;
    } catch (cause: unknown) {
      setError(
        cause instanceof ApiRequestError && cause.kind === 'http'
          ? cause.message
          : 'Could not confirm that action. Refresh the statement and check it before trying again.',
      );
      return null;
    } finally {
      await cache.invalidateQueries({ queryKey: ['customers'] });
      void cache.invalidateQueries({ queryKey: ['shift'] });
      void cache.invalidateQueries({ queryKey: ['reports'] });
      locked.current = false;
      setBusy(false);
    }
  }
  return {
    busy,
    error,
    clearError: () => setError(null),
    create: (request: CustomerRequest) =>
      run(() => apiClient.postWithReceipt('/customers', request)),
    edit: (customer: CustomerDto, request: CustomerRequest & { isActive: boolean }) =>
      run(() =>
        apiClient.patch(`/customers/${customer.id}`, {
          ...request,
          expectedVersion: customer.version,
        }),
      ),
    repay: (id: string, request: RepaymentRequest) =>
      run(() => apiClient.postWithReceipt(`/customers/${id}/repayments`, request)),
    reverse: (customer: CustomerDto, repaymentId: string, reason: string) =>
      run(() =>
        apiClient.postWithReceipt(`/credit-repayments/${repaymentId}/reverse`, {
          expectedVersion: customer.version,
          reason,
        }),
      ),
    assign: (customer: CustomerDto, paymentId: string) =>
      run(() =>
        apiClient.postWithReceipt(`/credit/${paymentId}/customer`, {
          customerId: customer.id,
          expectedVersion: customer.version,
        }),
      ),
  };
}
