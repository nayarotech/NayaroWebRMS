import { useCallback, useState } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import type {
  CashMovementRequest,
  CloseShiftRequest,
  CurrentShiftResponse,
  ShiftDto,
  ShiftResponse,
} from '@nayaro/shared';
import { ApiRequestError, apiClient } from '@/services/apiClient';

export const CURRENT_SHIFT_KEY = ['shift', 'current'] as const;

/**
 * The open drawer, or null. Polled rather than pushed: cash sales land from
 * any terminal, and a drawer screen that is a few seconds behind is harmless -
 * the figure that counts is computed by the server at the moment of closing.
 */
export function useCurrentShift(): UseQueryResult<CurrentShiftResponse, Error> {
  return useQuery({
    queryKey: CURRENT_SHIFT_KEY,
    queryFn: () => apiClient.get<CurrentShiftResponse>('/shifts/current'),
    refetchInterval: 15_000,
  });
}

export interface DrawerActions {
  open: (openingFloatPaisa: number) => Promise<ShiftDto | null>;
  move: (shiftId: string, request: CashMovementRequest) => Promise<ShiftDto | null>;
  close: (shiftId: string, request: CloseShiftRequest) => Promise<ShiftDto | null>;
  readonly isSaving: boolean;
  readonly error: string | null;
  clearError: () => void;
}

export function useDrawerActions(): DrawerActions {
  const queryClient = useQueryClient();
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (action: () => Promise<ShiftResponse>): Promise<ShiftDto | null> => {
      setIsSaving(true);
      try {
        const { shift } = await action();
        setError(null);
        return shift;
      } catch (cause: unknown) {
        setError(
          cause instanceof ApiRequestError && cause.kind === 'http'
            ? cause.message
            : 'Could not do that. Check your connection and try again.',
        );
        return null;
      } finally {
        await queryClient.invalidateQueries({ queryKey: CURRENT_SHIFT_KEY });
        void queryClient.invalidateQueries({ queryKey: ['reports'] });
        setIsSaving(false);
      }
    },
    [queryClient],
  );

  return {
    open: (openingFloatPaisa) =>
      run(() => apiClient.post<ShiftResponse>('/shifts', { openingFloatPaisa })),
    move: (shiftId, request) =>
      run(() => apiClient.post<ShiftResponse>(`/shifts/${shiftId}/movements`, request)),
    close: (shiftId, request) =>
      run(() => apiClient.post<ShiftResponse>(`/shifts/${shiftId}/close`, request)),
    isSaving,
    error,
    clearError: () => {
      setError(null);
    },
  };
}
