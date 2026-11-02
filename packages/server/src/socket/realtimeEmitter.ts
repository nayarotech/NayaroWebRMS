import type { Server as SocketIOServer } from 'socket.io';
import {
  REALTIME_EVENTS,
  type FloorUpdatedPayload,
  type KotCreatedPayload,
  type MenuUpdatedPayload,
  type InvoiceIssuedPayload,
  type PaymentRecordedPayload,
  type KotUpdatedPayload,
  type OrderUpdatedPayload,
} from '@nayaro/shared';
import { restaurantRoom } from './socketServer';

/**
 * How services announce that something changed.
 *
 * An interface rather than the Socket.IO server itself, for two reasons. The
 * app is constructed before Socket.IO exists, so routes need something they can
 * hold now and that resolves later. And a service that imports a socket server
 * is a service that cannot be tested without one.
 *
 * Events are INVALIDATION SIGNALS, not state transfer: the payload says which
 * restaurant changed, and clients refetch. Pushing the new floor down the wire
 * would create a second, subtly different copy of server state on every
 * terminal.
 */
export interface RealtimeEmitter {
  floorUpdated(payload: FloorUpdatedPayload): void;
  orderUpdated(payload: OrderUpdatedPayload): void;
  kotCreated(payload: KotCreatedPayload): void;
  kotUpdated(payload: KotUpdatedPayload): void;
  invoiceIssued(payload: InvoiceIssuedPayload): void;
  paymentRecorded(payload: PaymentRecordedPayload): void;
  menuUpdated(payload: MenuUpdatedPayload): void;
}

/**
 * Emitter backed by a live Socket.IO server, resolved lazily.
 *
 * Every event goes to its restaurant's room, never to every connected socket:
 * only authenticated sockets join a room (see socketServer.ts).
 */
export function createRealtimeEmitter(getServer: () => SocketIOServer | null): RealtimeEmitter {
  return {
    floorUpdated(payload) {
      getServer()
        ?.to(restaurantRoom(payload.restaurantId))
        .emit(REALTIME_EVENTS.floorUpdated, payload);
    },
    orderUpdated(payload) {
      getServer()
        ?.to(restaurantRoom(payload.restaurantId))
        .emit(REALTIME_EVENTS.orderUpdated, payload);
    },
    kotCreated(payload) {
      getServer()
        ?.to(restaurantRoom(payload.restaurantId))
        .emit(REALTIME_EVENTS.kotCreated, payload);
    },
    kotUpdated(payload) {
      getServer()
        ?.to(restaurantRoom(payload.restaurantId))
        .emit(REALTIME_EVENTS.kotUpdated, payload);
    },
    invoiceIssued(payload) {
      getServer()
        ?.to(restaurantRoom(payload.restaurantId))
        .emit(REALTIME_EVENTS.invoiceIssued, payload);
    },
    paymentRecorded(payload) {
      getServer()
        ?.to(restaurantRoom(payload.restaurantId))
        .emit(REALTIME_EVENTS.paymentRecorded, payload);
    },
    menuUpdated(payload) {
      getServer()
        ?.to(restaurantRoom(payload.restaurantId))
        .emit(REALTIME_EVENTS.menuUpdated, payload);
    },
  };
}

/** Emitter that does nothing. Handy in tests that do not care about realtime. */
export const noopRealtimeEmitter: RealtimeEmitter = {
  floorUpdated() {
    /* intentionally empty */
  },
  orderUpdated() {
    /* intentionally empty */
  },
  kotCreated() {
    /* intentionally empty */
  },
  kotUpdated() {
    /* intentionally empty */
  },
  invoiceIssued() {
    /* intentionally empty */
  },
  paymentRecorded() {
    /* intentionally empty */
  },
  menuUpdated() {
    /* intentionally empty */
  },
};
