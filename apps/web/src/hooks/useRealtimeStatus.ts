import { useSyncExternalStore } from 'react';
import { getRealtimeSnapshot, subscribeToRealtime, type RealtimeSnapshot } from '@/services/socket';

/**
 * Connection state of the single Socket.IO client.
 *
 * `useSyncExternalStore` rather than useEffect + useState: the socket lives
 * outside React, this is the sanctioned way to read such a source, and it is
 * immune to StrictMode's double-invoked effects - subscribing twice is
 * harmless because the store is a set of listeners over one connection.
 */
export function useRealtimeStatus(): RealtimeSnapshot {
  return useSyncExternalStore(subscribeToRealtime, getRealtimeSnapshot, getRealtimeSnapshot);
}
