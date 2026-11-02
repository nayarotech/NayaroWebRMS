import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  REALTIME_EVENTS,
  type AddOrderItemTarget,
  type MaybeOrderListResponse,
  type MenuResponse,
  type OrderDto,
  type OrderResponse,
  type KotUpdatedPayload,
  type OrderUpdatedPayload,
} from '@nayaro/shared';
import { ApiRequestError } from '@/services/apiClient';
import { subscribeToRealtimeEvent } from '@/services/socket';
import * as ordersApi from '../api/orders.api';

/**
 * Server state for the POS. As with the floor, TanStack Query owns it and
 * there is no client-side cart.
 *
 * That is the whole point of Phase 4C: the draft lives in SQLite, so walking
 * back to the floor plan and returning to Table 4 shows the same order, and so
 * does the till on the other side of the room. A cart in React state would be
 * lost by a reload and invisible to every other terminal.
 */

export const ORDER_KEY = ['order'] as const;
export const MENU_KEY = ['menu'] as const;

/** What the screen is pointed at. See router.tsx for the matching routes. */
export type OrderTarget =
  | { readonly kind: 'TABLE'; readonly tableId: string }
  | { readonly kind: 'ORDER'; readonly orderId: string }
  | { readonly kind: 'TAKEAWAY' };

/**
 * Open takeaway orders.
 *
 * A takeaway has no table, so without this list it vanishes from the interface
 * the moment a cashier walks back to the floor plan - open, unbillable and
 * unreachable. Bounded by the same `closedAt: null` rule as the floor, so it
 * lists work in progress and never history.
 */
export function useOpenTakeaways(): UseQueryResult<MaybeOrderListResponse, Error> {
  return useQuery({
    queryKey: [...ORDER_KEY, 'takeaway', 'open'],
    queryFn: () => ordersApi.fetchOpenTakeaways(),
    refetchInterval: 30_000,
  });
}

export function useMenu(): UseQueryResult<MenuResponse, Error> {
  return useQuery({
    queryKey: MENU_KEY,
    queryFn: ordersApi.fetchMenu,
    // Scheduled offers can start or end without a catalogue edit. Poll prices
    // as well as refetching after menu events; the server prices every addition.
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

/**
 * The order this screen is editing, or null when none exists yet.
 *
 * A TAKEAWAY target has nothing to fetch: the order does not exist until the
 * first item is added, and until then the correct answer is genuinely "no
 * order". The query is disabled rather than faked.
 */
export function useOrderForTarget(target: OrderTarget): UseQueryResult<OrderDto | null, Error> {
  return useQuery({
    queryKey: [...ORDER_KEY, target],
    queryFn: async (): Promise<OrderDto | null> => {
      if (target.kind === 'TABLE') return (await ordersApi.fetchTableOrder(target.tableId)).order;
      if (target.kind === 'ORDER') return (await ordersApi.fetchOrder(target.orderId)).order;
      return null;
    },
    enabled: target.kind !== 'TAKEAWAY',
    refetchOnMount: 'always',
    refetchInterval: 10_000,
    ...(target.kind === 'TAKEAWAY' ? { initialData: null } : {}),
  });
}

/**
 * Keeps this window in step with the others.
 *
 * Order events invalidate the floor as well as the order, because a table's
 * colour is derived from the order sitting on it - adding the first item to
 * Table 4 is exactly what turns it OCCUPIED on the manager's screen.
 */
export function useOrderRealtime(): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const invalidate = (): void => {
      void queryClient.invalidateQueries({ queryKey: ORDER_KEY });
      void queryClient.invalidateQueries({ queryKey: ['floor'] });
      // A ticket cut on another terminal changes what is left to send here.
      void queryClient.invalidateQueries({ queryKey: ['kitchen'] });
    };
    const unsubscribes = [
      subscribeToRealtimeEvent<OrderUpdatedPayload>(REALTIME_EVENTS.orderUpdated, invalidate),
      // The kitchen summary in the panel moves when a ticket does.
      subscribeToRealtimeEvent<KotUpdatedPayload>(REALTIME_EVENTS.kotUpdated, invalidate),
    ];
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
    };
  }, [queryClient]);
}

export interface OrderEditor {
  /**
   * Adds one of this dish, merging into an existing line where the rules
   * allow. Returns the resulting order so a takeaway - which had no id until
   * this moment - can learn the one it was just given.
   */
  addItem: (menuItemId: string, note?: string) => Promise<OrderDto | null>;
  setQuantity: (itemId: string, quantity: number) => Promise<void>;
  setNote: (itemId: string, note: string | null) => Promise<void>;
  removeItem: (itemId: string) => Promise<void>;
  /** Sends every undispatched quantity to the kitchen as one new ticket. */
  sendToKitchen: () => Promise<void>;
  transferTable: (toTableId: string) => Promise<OrderDto | null>;
  readonly isSaving: boolean;
  /** A message worth showing the cashier, or null. Cleared by `dismissNotice`. */
  readonly notice: string | null;
  dismissNotice: () => void;
}

/**
 * Every draft edit, with the version protocol and conflict handling in one
 * place so no component has to remember either.
 *
 * CONFLICTS ARE NOT ERRORS. Two tills on one order is a normal Friday, so a
 * 409 is handled by refetching and telling the cashier plainly what happened -
 * never by a red failure box, and never by silently retrying with the new
 * version, which would apply an edit the cashier made against a screen that no
 * longer existed.
 */
export function useOrderEditor(
  target: OrderTarget,
  order: OrderDto | null,
  onEmptied?: () => void,
): OrderEditor {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ORDER_KEY });
    void queryClient.invalidateQueries({ queryKey: ['floor'] });
  }, [queryClient]);

  const run = useCallback(
    async <T>(action: () => Promise<T>): Promise<T | null> => {
      setIsSaving(true);
      try {
        const result = await action();
        setNotice(null);
        return result;
      } catch (cause: unknown) {
        if (cause instanceof ApiRequestError && cause.kind === 'http') {
          // ORDER_CHANGED and ORDER_ALREADY_OPEN both mean "your copy is
          // behind" - the server's own wording already says so usefully.
          setNotice(cause.message);
        } else {
          setNotice(
            'Could not confirm whether that saved. Check the refreshed order before trying again.',
          );
        }
        return null;
      } finally {
        // Refetch on success AND on failure: after a conflict the whole point
        // is to show the cashier what the order actually looks like now.
        await refresh();
        setIsSaving(false);
      }
    },
    [refresh],
  );

  /** Where an added item should go: an existing order, or a new one. */
  const addTarget = useCallback((): AddOrderItemTarget => {
    if (order !== null) {
      return { kind: 'ORDER', orderId: order.id, expectedVersion: order.version };
    }
    if (target.kind === 'ORDER')
      throw new ApiRequestError('http', 'This order is no longer available. Return to tables.', {
        status: 409,
      });
    if (target.kind === 'TABLE') return { kind: 'TABLE', tableId: target.tableId };
    return { kind: 'TAKEAWAY' };
  }, [order, target]);

  const addItem = useCallback(
    async (menuItemId: string, note?: string): Promise<OrderDto | null> => {
      const result: OrderResponse | null = await run(() =>
        ordersApi.addOrderItem({
          target: addTarget(),
          menuItemId,
          ...(note === undefined || note.length === 0 ? {} : { note }),
        }),
      );
      return result?.order ?? null;
    },
    [addTarget, run],
  );

  const setQuantity = useCallback(
    async (itemId: string, quantity: number): Promise<void> => {
      if (order === null) return;
      // Zero is not a quantity, it is a removal. Routing it here rather than
      // letting the server reject it keeps the stepper honest at its own edge.
      if (quantity < 1) {
        const result = await run(() => ordersApi.removeOrderItem(order.id, itemId, order.version));
        if (result?.order === null) onEmptied?.();
        return;
      }
      await run(() =>
        ordersApi.updateOrderItem(order.id, itemId, {
          expectedVersion: order.version,
          quantity,
        }),
      );
    },
    [order, run, onEmptied],
  );

  const setNote = useCallback(
    async (itemId: string, note: string | null): Promise<void> => {
      if (order === null) return;
      await run(() =>
        ordersApi.updateOrderItem(order.id, itemId, { expectedVersion: order.version, note }),
      );
    },
    [order, run],
  );

  const removeItem = useCallback(
    async (itemId: string): Promise<void> => {
      if (order === null) return;
      const result = await run(() => ordersApi.removeOrderItem(order.id, itemId, order.version));
      if (result?.order === null) onEmptied?.();
    },
    [order, run, onEmptied],
  );

  const sendToKitchen = useCallback(async (): Promise<void> => {
    if (order === null) return;
    await run(() => ordersApi.sendToKitchen(order.id, order.version));
  }, [order, run]);

  const dismissNotice = useCallback(() => {
    setNotice(null);
  }, []);

  const transferTable = useCallback(
    async (toTableId: string): Promise<OrderDto | null> => {
      if (order === null) return null;
      const result = await run(() =>
        ordersApi.transferTable(order.id, { expectedVersion: order.version, toTableId }),
      );
      void queryClient.invalidateQueries({ queryKey: ['kitchen'] });
      return result?.order ?? null;
    },
    [order, queryClient, run],
  );

  return {
    transferTable,
    addItem,
    setQuantity,
    setNote,
    removeItem,
    sendToKitchen,
    isSaving,
    notice,
    dismissNotice,
  };
}
