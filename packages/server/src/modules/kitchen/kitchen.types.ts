import type { KotStatus, OrderType } from '@nayaro/database';

export type { KitchenTicket, KitchenTicketsResponse } from '@nayaro/shared';

/** Exactly what KITCHEN_TICKET_SELECT returns. Internal to this module. */
export interface KitchenTicketItemRow {
  readonly id: string;
  readonly quantity: number;
  readonly noteSnapshot: string | null;
  readonly orderItem: {
    readonly comboSnapshot: string;
    readonly nameSnapshot: string;
    readonly nameNpSnapshot: string | null;
    readonly createdAt: Date;
  };
}

export interface KitchenTicketRow {
  readonly id: string;
  readonly kotNumber: number;
  readonly status: KotStatus;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly readyAt: Date | null;
  readonly servedAt: Date | null;
  readonly order: {
    readonly id: string;
    readonly orderNumber: number;
    readonly type: OrderType;
    readonly table: { readonly name: string } | null;
  };
  readonly items: readonly KitchenTicketItemRow[];
}
