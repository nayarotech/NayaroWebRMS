import { useSystemHealth } from './useSystemHealth';
import { useRealtimeStatus } from './useRealtimeStatus';

export type ConnectionState = 'connecting' | 'online' | 'degraded' | 'offline';

export interface ConnectionStatus {
  readonly state: ConnectionState;
  /** Short label for restaurant staff. Deliberately not technical. */
  readonly label: string;
}

/**
 * One status for the whole shell, combining the HTTP health check and the
 * Socket.IO connection.
 *
 * Reduces two technical signals to one word a cashier can act on. Electron,
 * Node and Chromium versions and the API URL were Phase 1 diagnostics; they
 * have no place in the production shell.
 */
export function useConnectionStatus(): ConnectionStatus {
  const health = useSystemHealth();
  const realtime = useRealtimeStatus();

  // As established in Step 4: `isSuccess` alone would keep reporting
  // "connected" from a stale cache after a failed background refetch. The
  // timestamps say how the most recent attempt actually ended.
  const lastAttemptFailed = health.errorUpdatedAt > health.dataUpdatedAt;
  const httpOk = health.isSuccess && !lastAttemptFailed && health.data.database === 'connected';
  const realtimeOk = realtime.state === 'connected';

  if (health.isPending) return { state: 'connecting', label: 'Connecting' };
  if (!httpOk) return { state: 'offline', label: 'Offline' };
  if (!realtimeOk) return { state: 'degraded', label: 'Reconnecting' };
  return { state: 'online', label: 'Connected' };
}
