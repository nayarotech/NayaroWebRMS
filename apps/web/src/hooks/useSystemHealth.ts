import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { HealthResponse } from '@nayaro/shared';
import { apiClient } from '@/services/apiClient';

/** Query key root, so future code can invalidate system queries as a group. */
export const systemHealthQueryKey = ['system', 'health'] as const;

/**
 * Polls GET /health.
 *
 * Ten seconds is a deliberate compromise for a status screen: quick enough
 * that a developer notices the server dying without watching logs, slow enough
 * that the log is not flooded. Nothing else in the app should poll - once real
 * screens exist they are driven by Socket.IO events, not intervals.
 */
export function useSystemHealth(): UseQueryResult<HealthResponse, Error> {
  return useQuery({
    queryKey: systemHealthQueryKey,
    queryFn: () => apiClient.get<HealthResponse>('/health'),
    refetchInterval: 10_000,
    // Keep polling while the window sits in the background: a POS is often
    // left open beside other software and the status must stay truthful.
    refetchIntervalInBackground: true,
  });
}
