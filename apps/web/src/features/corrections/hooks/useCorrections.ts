import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { StaffRole } from '@nayaro/shared';
import { ApiRequestError } from '@/services/apiClient';
import { useAuthStore } from '@/stores/authStore';
import * as correctionsApi from '../api/corrections.api';

/**
 * Corrections, in one hook.
 *
 * All four reverse something and all four need the same three things around
 * them: a reason, a refusal the user can read, and a refetch afterwards. Doing
 * that once here keeps the components describing consequences rather than
 * plumbing.
 */

/** Owners and managers. Mirrors CAN_CORRECT on the server, which is the real gate. */
const CORRECTION_ROLES: readonly StaffRole[] = ['OWNER', 'MANAGER'];

/**
 * Whether to offer correction controls at all.
 *
 * Hiding them from a cashier is a courtesy, not the safeguard: the server
 * returns 403 to a hand-rolled request either way. But a button that is only
 * ever going to refuse is a worse thing to show someone than no button.
 */
export function useMayCorrect(): boolean {
  const staff = useAuthStore((state) => state.staff);
  return staff !== null && CORRECTION_ROLES.includes(staff.role);
}

export interface Corrections {
  voidKot: (kotId: string, reason: string) => Promise<boolean>;
  cancelItem: (
    orderId: string,
    itemId: string,
    quantity: number,
    reason: string,
  ) => Promise<boolean>;
  voidInvoice: (invoiceId: string, reason: string) => Promise<boolean>;
  voidPayment: (paymentId: string, reason: string) => Promise<boolean>;
  readonly isSaving: boolean;
  /** The server's own wording when a correction was refused, or null. */
  readonly error: string | null;
  clearError: () => void;
}

export function useCorrections(): Corrections {
  const queryClient = useQueryClient();
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (action: () => Promise<unknown>): Promise<boolean> => {
      setIsSaving(true);
      setError(null);
      try {
        await action();
        return true;
      } catch (cause: unknown) {
        // The server's message is written for the person reading it - "This
        // food has already been served..." - so it is shown as-is rather than
        // being replaced by something vaguer.
        setError(
          cause instanceof ApiRequestError && cause.kind === 'http'
            ? cause.message
            : 'Could not apply that correction. Check your connection and try again.',
        );
        return false;
      } finally {
        /*
         * Everything, on success AND on failure. A correction moves the order,
         * the floor, the kitchen board and the bill at once - and after a
         * refusal the whole point is to show what the record actually says now.
         */
        for (const key of [['order'], ['floor'], ['kitchen'], ['billing']]) {
          void queryClient.invalidateQueries({ queryKey: key });
        }
        setIsSaving(false);
      }
    },
    [queryClient],
  );

  return {
    voidKot: useCallback(
      (kotId, reason) => run(() => correctionsApi.voidKot(kotId, { reason })),
      [run],
    ),
    cancelItem: useCallback(
      (orderId, itemId, quantity, reason) =>
        run(() => correctionsApi.cancelOrderItem(orderId, itemId, { quantity, reason })),
      [run],
    ),
    voidInvoice: useCallback(
      (invoiceId, reason) => run(() => correctionsApi.voidInvoice(invoiceId, { reason })),
      [run],
    ),
    voidPayment: useCallback(
      (paymentId, reason) => run(() => correctionsApi.voidPayment(paymentId, { reason })),
      [run],
    ),
    isSaving,
    error,
    clearError: useCallback(() => {
      setError(null);
    }, []),
  };
}
