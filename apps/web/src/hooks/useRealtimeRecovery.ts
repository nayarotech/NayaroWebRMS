import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { watchServiceConnection } from '@/lib/serviceRecovery';
import { getRealtimeSnapshot, subscribeToRealtime } from '@/services/socket';

/**
 * After the live connection drops and comes back, events may have been missed.
 * Refetch what is on screen rather than trusting a cache that went deaf.
 */
export function useRealtimeRecovery(): void {
  const queryClient = useQueryClient();
  useEffect(
    () => watchServiceConnection(queryClient, subscribeToRealtime, getRealtimeSnapshot),
    [queryClient],
  );
}
