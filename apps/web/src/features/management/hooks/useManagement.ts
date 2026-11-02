import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  REALTIME_EVENTS,
  type CreateStaffRequest,
  type CreateMenuItemRequest,
  type UpdateStaffRequest,
  type ManagedMenuResponse,
  type MenuUpdatedPayload,
  type SettingsResponse,
  type StaffListResponse,
} from '@nayaro/shared';
import { ApiRequestError, apiClient } from '@/services/apiClient';
import { subscribeToRealtimeEvent } from '@/services/socket';

/**
 * Management data: menu, staff and settings.
 *
 * One hook per screen, and one shared mutation runner. These screens are used
 * a few times a week rather than a few times a minute, so they are ordinary
 * request/response - no optimistic updates, no local caches to reconcile. The
 * server's answer is what the screen shows.
 */

export const MANAGED_MENU_KEY = ['management', 'menu'] as const;
export const STAFF_KEY = ['management', 'staff'] as const;
export const SETTINGS_KEY = ['management', 'settings'] as const;
export const SESSIONS_KEY = ['management', 'sessions'] as const;
export const AUDIT_KEY = ['management', 'audit'] as const;

export function useManagedMenu(): UseQueryResult<ManagedMenuResponse, Error> {
  return useQuery({
    queryKey: MANAGED_MENU_KEY,
    queryFn: () => apiClient.get<ManagedMenuResponse>('/management/menu'),
  });
}

export function useStaffList(): UseQueryResult<StaffListResponse, Error> {
  return useQuery({
    queryKey: STAFF_KEY,
    queryFn: () => apiClient.get<StaffListResponse>('/management/staff'),
  });
}

/**
 * `enabled` exists for callers outside the Settings screen.
 *
 * The billing screen wants one field from here - the bill's footer line - and
 * is used mostly by cashiers, who are refused this endpoint. Asking anyway
 * would mean a guaranteed 403, retried, on every bill a cashier opens all
 * evening. The caller passes its own role check instead, and the bill simply
 * prints without a footer.
 */
export function useSettings(
  options: { enabled?: boolean } = {},
): UseQueryResult<SettingsResponse, Error> {
  return useQuery({
    queryKey: SETTINGS_KEY,
    queryFn: () => apiClient.get<SettingsResponse>('/management/settings'),
    enabled: options.enabled ?? true,
  });
}

/**
 * A till holding a cached menu must not keep selling a dish the kitchen has
 * just run out of. This is the only management event that travels.
 */
export function useMenuRealtime(): void {
  const queryClient = useQueryClient();

  useEffect(
    () =>
      subscribeToRealtimeEvent<MenuUpdatedPayload>(REALTIME_EVENTS.menuUpdated, () => {
        void queryClient.invalidateQueries({ queryKey: ['menu'] });
        void queryClient.invalidateQueries({ queryKey: MANAGED_MENU_KEY });
        void queryClient.invalidateQueries({ queryKey: ['management', 'offers'] });
      }),
    [queryClient],
  );
}

export interface ManagementActions {
  run: (action: () => Promise<unknown>) => Promise<boolean>;
  readonly isSaving: boolean;
  readonly error: string | null;
  clearError: () => void;
}

/**
 * One place where a management mutation succeeds or explains itself.
 *
 * The server's message is shown verbatim, because it was written to be read:
 * "Ground Floor still has 3 active table(s)" or "This is the only owner
 * account". Anything that is not one of our error envelopes is replaced with a
 * generic line - a raw exception could carry internals, and the user cannot act
 * on it either way.
 */
export function useManagementActions(
  invalidate: readonly (readonly unknown[])[],
): ManagementActions {
  const queryClient = useQueryClient();
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (action: () => Promise<unknown>): Promise<boolean> => {
      setIsSaving(true);
      try {
        await action();
        setError(null);
        return true;
      } catch (cause: unknown) {
        setError(
          cause instanceof ApiRequestError && cause.kind === 'http'
            ? cause.message
            : 'Could not save that. Check your connection and try again.',
        );
        return false;
      } finally {
        for (const key of invalidate) {
          await queryClient.invalidateQueries({ queryKey: key });
        }
        setIsSaving(false);
      }
    },
    // The caller passes a literal, so identity churn would re-create this on
    // every render; the contents are what matter and they never change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient],
  );

  return {
    run,
    isSaving,
    error,
    clearError: () => {
      setError(null);
    },
  };
}

// --- thin API wrappers -------------------------------------------------------

export const managementApi = {
  createCategory: (body: { name: string; nameNp?: string }) =>
    apiClient.post<ManagedMenuResponse>('/management/menu/categories', body),
  updateCategory: (id: string, body: Record<string, unknown>) =>
    apiClient.patch<ManagedMenuResponse>(`/management/menu/categories/${id}`, body),
  createItem: (body: CreateMenuItemRequest) =>
    apiClient.post<ManagedMenuResponse>('/management/menu/items', body),
  updateItem: (id: string, body: Record<string, unknown>) =>
    apiClient.patch<ManagedMenuResponse>(`/management/menu/items/${id}`, body),

  createStaff: (body: CreateStaffRequest) =>
    apiClient.post<StaffListResponse>('/management/staff', body),
  updateStaff: (id: string, body: UpdateStaffRequest) =>
    apiClient.patch<StaffListResponse>(`/management/staff/${id}`, body),
  resetPassword: (id: string, newPassword: string) =>
    apiClient.post<void>(`/management/staff/${id}/password`, { newPassword }),
  changeOwnPassword: (currentPassword: string, newPassword: string) =>
    apiClient.post<void>('/auth/password', { currentPassword, newPassword }),

  updateRestaurant: (body: Record<string, unknown>) =>
    apiClient.patch<SettingsResponse>('/management/settings/restaurant', body),
  updateFinancial: (body: Record<string, unknown>) =>
    apiClient.patch<SettingsResponse>('/management/settings/financial', body),
  updateOperational: (body: Record<string, unknown>) =>
    apiClient.patch<SettingsResponse>('/management/settings/operational', body),

  revokeSession: (id: string) => apiClient.delete<void>(`/auth/sessions/${encodeURIComponent(id)}`),
};
