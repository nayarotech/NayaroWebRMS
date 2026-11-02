import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  REALTIME_EVENTS,
  type CreateAreaRequest,
  type CreateTableRequest,
  type FloorResponse,
  type FloorUpdatedPayload,
  type KotUpdatedPayload,
  type OrderUpdatedPayload,
  type UpdateAreaRequest,
  type UpdateTableRequest,
} from '@nayaro/shared';
import { subscribeToRealtimeEvent } from '@/services/socket';
import * as floorApi from '../api/floor.api';

/**
 * Server state for the floor plan. TanStack Query owns it; there is no Zustand
 * store here on purpose.
 *
 * The distinction the whole app follows: Zustand holds what only this window
 * knows (the session, the collapsed sidebar); Query holds what the server
 * knows. A copy of the floor in a client store would be a second source of
 * truth that goes stale the moment another till adds a table.
 */

/** Prefixed so `invalidateQueries({ queryKey: FLOOR_KEY })` catches both variants. */
export const FLOOR_KEY = ['floor'] as const;

export function floorQueryKey(includeInactive: boolean): readonly unknown[] {
  return [...FLOOR_KEY, { includeInactive }];
}

export function useFloor(
  options: { includeInactive?: boolean } = {},
): UseQueryResult<FloorResponse, Error> {
  const includeInactive = options.includeInactive ?? false;
  return useQuery({
    queryKey: floorQueryKey(includeInactive),
    queryFn: () => floorApi.fetchFloor({ includeInactive }),
    // A table's status is derived from orders, which change constantly during
    // service. Until Phase 4C emits order events, a slow poll keeps the board
    // honest; realtime invalidation (below) covers configuration changes now.
    refetchInterval: 15_000,
    staleTime: 5_000,
  });
}

/**
 * Keeps every open terminal's floor in step.
 *
 * The payload is discarded deliberately - it names the restaurant, and there is
 * only ever one per install. The event's job is to say "something changed",
 * after which the client asks the server what the floor looks like now. That is
 * the whole realtime contract: signals in, refetch out, no state on the wire.
 */
export function useFloorRealtime(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const invalidate = (): void => {
      void queryClient.invalidateQueries({ queryKey: FLOOR_KEY });
    };
    // Three sources, one consequence. Configuration changes reshape the board;
    // order and ticket changes recolour it - a table turns OCCUPIED when a
    // cashier adds the first item, and READY when the kitchen plates it.
    const unsubscribes = [
      subscribeToRealtimeEvent<FloorUpdatedPayload>(REALTIME_EVENTS.floorUpdated, invalidate),
      subscribeToRealtimeEvent<OrderUpdatedPayload>(REALTIME_EVENTS.orderUpdated, invalidate),
      // A ticket going READY is what turns a table READY on this board.
      subscribeToRealtimeEvent<KotUpdatedPayload>(REALTIME_EVENTS.kotUpdated, invalidate),
    ];
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [queryClient]);
}

/**
 * Floor configuration mutations.
 *
 * All four invalidate rather than write the response into the cache. The
 * response is the includeInactive view (the manager needs to see what they just
 * switched off), and pushing that into the active-only key would make
 * deactivated tables reappear on the service board. Invalidating costs one
 * loopback request and cannot get this wrong.
 */
export interface FloorMutations {
  readonly createArea: (request: CreateAreaRequest) => Promise<FloorResponse>;
  readonly updateArea: (areaId: string, request: UpdateAreaRequest) => Promise<FloorResponse>;
  readonly createTable: (request: CreateTableRequest) => Promise<FloorResponse>;
  readonly updateTable: (tableId: string, request: UpdateTableRequest) => Promise<FloorResponse>;
  readonly isSaving: boolean;
}

export function useFloorMutations(): FloorMutations {
  const queryClient = useQueryClient();
  const onSettled = (): void => {
    void queryClient.invalidateQueries({ queryKey: FLOOR_KEY });
  };

  const areaCreate = useMutation({ mutationFn: floorApi.createArea, onSettled });
  const areaUpdate = useMutation({
    mutationFn: ({ areaId, request }: { areaId: string; request: UpdateAreaRequest }) =>
      floorApi.updateArea(areaId, request),
    onSettled,
  });
  const tableCreate = useMutation({ mutationFn: floorApi.createTable, onSettled });
  const tableUpdate = useMutation({
    mutationFn: ({ tableId, request }: { tableId: string; request: UpdateTableRequest }) =>
      floorApi.updateTable(tableId, request),
    onSettled,
  });

  return {
    createArea: (request) => areaCreate.mutateAsync(request),
    updateArea: (areaId, request) => areaUpdate.mutateAsync({ areaId, request }),
    createTable: (request) => tableCreate.mutateAsync(request),
    updateTable: (tableId, request) => tableUpdate.mutateAsync({ tableId, request }),
    isSaving:
      areaCreate.isPending ||
      areaUpdate.isPending ||
      tableCreate.isPending ||
      tableUpdate.isPending,
  };
}
