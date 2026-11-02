import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  REALTIME_EVENTS,
  type KitchenTicketsResponse,
  type KotCreatedPayload,
  type KotStatus,
  type KotTransitionTarget,
  type KotUpdatedPayload,
} from '@nayaro/shared';
import { ApiRequestError, apiClient } from '@/services/apiClient';
import { subscribeToRealtimeEvent } from '@/services/socket';

export const KITCHEN_KEY = ['kitchen', 'tickets'] as const;

export function useKitchenTickets(): UseQueryResult<KitchenTicketsResponse, Error> {
  return useQuery({
    queryKey: KITCHEN_KEY,
    queryFn: () => apiClient.get<KitchenTicketsResponse>('/kitchen/tickets'),
    // A fallback, not the mechanism. `kot:created` is what makes a ticket
    // appear the instant it is cut; this catches the case where a socket
    // dropped and reconnected without anyone noticing. A kitchen screen that
    // silently stops updating is the worst failure this app could have.
    refetchInterval: 20_000,
  });
}

/**
 * New tickets and their movements arrive here, without anyone touching the
 * screen. Two events, one consequence: a ticket cut on the POS and a ticket
 * moved on another kitchen terminal both mean this board is out of date.
 */
export function useKitchenRealtime(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const invalidate = (): void => {
      void queryClient.invalidateQueries({ queryKey: KITCHEN_KEY });
    };
    const unsubscribes = [
      subscribeToRealtimeEvent(REALTIME_EVENTS.orderUpdated, invalidate),
      subscribeToRealtimeEvent<KotCreatedPayload>(REALTIME_EVENTS.kotCreated, invalidate),
      subscribeToRealtimeEvent<KotUpdatedPayload>(REALTIME_EVENTS.kotUpdated, invalidate),
    ];
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [queryClient]);
}
/**
 * The state machine, on the client side too - as a lookup rather than as
 * branching scattered through the card.
 *
 * The server is authoritative; this exists so the board OFFERS only the legal
 * move. A cook never picks a status from a dropdown, they press the one button
 * that describes what they just did.
 */
export const NEXT_STEP: Readonly<
  Partial<Record<KotStatus, { readonly target: KotTransitionTarget; readonly label: string }>>
> = {
  NEW: { target: 'PREPARING', label: 'Start preparing' },
  PREPARING: { target: 'READY', label: 'Mark ready' },
  READY: { target: 'SERVED', label: 'Mark served' },
};

export interface KotTransitions {
  move: (kotId: string, target: KotTransitionTarget) => Promise<void>;
  /** True while THIS ticket is being moved. */
  isMoving: (kotId: string) => boolean;
  readonly notice: string | null;
  dismissNotice: () => void;
}

/**
 * Ticket transitions, with mutation state scoped PER TICKET.
 *
 * A single `isPending` would freeze the whole board while one ticket moved,
 * which on a busy pass is the difference between a usable screen and a
 * useless one: marking #12 ready must not stop anyone starting #13. The set of
 * in-flight ids is the smallest thing that gets that right.
 */
export function useKotTransitions(): KotTransitions {
  const queryClient = useQueryClient();
  const [moving, setMoving] = useState<ReadonlySet<string>>(() => new Set());
  const [notice, setNotice] = useState<string | null>(null);

  const move = useCallback(
    async (kotId: string, target: KotTransitionTarget): Promise<void> => {
      setMoving((current) => new Set(current).add(kotId));
      try {
        await apiClient.patch(`/kitchen/tickets/${kotId}/status`, { status: target });
        setNotice(null);
      } catch (cause: unknown) {
        // KOT_CHANGED is not a failure, it is another terminal being quicker.
        // The server's wording already says so usefully.
        setNotice(
          cause instanceof ApiRequestError && cause.kind === 'http'
            ? cause.message
            : 'Could not move that ticket. Check your connection and try again.',
        );
      } finally {
        // Refetch either way: after a conflict the point is to show the cook
        // where the ticket actually is now.
        void queryClient.invalidateQueries({ queryKey: KITCHEN_KEY });
        void queryClient.invalidateQueries({ queryKey: ['floor'] });
        void queryClient.invalidateQueries({ queryKey: ['order'] });
        setMoving((current) => {
          const next = new Set(current);
          next.delete(kotId);
          return next;
        });
      }
    },
    [queryClient],
  );

  return {
    move,
    isMoving: (kotId) => moving.has(kotId),
    notice,
    dismissNotice: () => {
      setNotice(null);
    },
  };
}

/**
 * A clock that ticks once a second, for elapsed-time labels.
 *
 * ONE interval for the whole board, shared by every ticket. Fifty tickets each
 * running their own timer would be fifty re-renders a second; this is one.
 *
 * Elapsed time is computed from each ticket's immutable `createdAt` rather than
 * counted up from a starting number, so it stays correct across a refetch, a
 * re-render, or a laptop waking from sleep.
 */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [intervalMs]);

  return now;
}
