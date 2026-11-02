import type { KotStatus, OrderStatus, OrderType } from '@nayaro/database';

/**
 * Wire contracts live in @nayaro/shared so the renderer consumes the identical
 * types. Re-exported here so nothing inside this module has to know that.
 */
export type {
  AddOrderItemRequest,
  KitchenTicket,
  KitchenTicketsResponse,
  SendToKitchenResponse,
  AddOrderItemTarget,
  MaybeOrderResponse,
  OrderDto,
  OrderItemDto,
  OrderResponse,
  UpdateOrderItemRequest,
} from '@nayaro/shared';

/** Exactly what ORDER_SELECT returns. Internal to this module. */
export interface OrderItemRow {
  readonly id: string;
  readonly menuItemId: string;
  readonly comboSnapshot: string;
  readonly promotionSnapshot: string | null;
  readonly nameSnapshot: string;
  readonly nameNpSnapshot: string | null;
  readonly quantity: number;
  readonly unitPricePaisa: number;
  readonly note: string | null;
  readonly createdAt: Date;
  /** Non-VOID dispatches of this line. Summed into dispatchedQuantity. */
  readonly kotItems: readonly { readonly quantity: number }[];
  /** Customer cancellations. Summed into cancelledQuantity. */
  readonly cancellations: readonly {
    readonly id: string;
    readonly quantity: number;
    readonly reason: string;
    readonly cancelledAt: Date;
    readonly cancelledByStaff: { readonly id: string; readonly name: string };
  }[];
}

/** One ticket as the POS sees it. VOID tickets are included; see ORDER_SELECT. */
export interface OrderKotRow {
  readonly id: string;
  readonly kotNumber: number;
  readonly status: KotStatus;
  readonly createdAt: Date;
  readonly voidedAt: Date | null;
  readonly voidReason: string | null;
  readonly voidedByStaff: { readonly id: string; readonly name: string } | null;
  readonly items: readonly {
    readonly quantity: number;
    readonly orderItem: { readonly nameSnapshot: string };
  }[];
}

export interface OrderRow {
  readonly id: string;
  readonly orderNumber: number;
  readonly status: OrderStatus;
  readonly type: OrderType;
  readonly version: number;
  readonly table: { readonly id: string; readonly name: string } | null;
  readonly items: readonly OrderItemRow[];
  /** ALL tickets for this order. The mapper filters VOID out of the counts. */
  readonly kots: readonly OrderKotRow[];
  readonly _count: { readonly invoices: number };
  readonly tableTransfers: readonly {
    readonly id: string;
    readonly fromTableId: string;
    readonly toTableId: string;
    readonly fromTableName: string;
    readonly toTableName: string;
    readonly createdAt: Date;
    readonly staff: { readonly id: string; readonly name: string };
  }[];
}
