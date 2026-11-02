import type {
  AddOrderItemRequest,
  MaybeOrderListResponse,
  SendToKitchenResponse,
  MaybeOrderResponse,
  MenuResponse,
  OrderResponse,
  UpdateOrderItemRequest,
  TransferTableRequest,
} from '@nayaro/shared';
import { apiClient } from '@/services/apiClient';

/**
 * Menu and order endpoints.
 *
 * Note there is no `createOrder`. An order comes into existence only as a side
 * effect of `addItem`, which is what keeps a mis-tapped table from writing a
 * row nobody meant to create.
 */
export function fetchMenu(): Promise<MenuResponse> {
  return apiClient.get<MenuResponse>('/menu');
}

export function fetchOpenTakeaways(): Promise<MaybeOrderListResponse> {
  return apiClient.get<MaybeOrderListResponse>('/orders/takeaway/open');
}

export function fetchOrder(orderId: string): Promise<OrderResponse> {
  return apiClient.get<OrderResponse>(`/orders/${orderId}`);
}

export function fetchTableOrder(tableId: string): Promise<MaybeOrderResponse> {
  return apiClient.get<MaybeOrderResponse>(`/tables/${tableId}/order`);
}

export function addOrderItem(request: AddOrderItemRequest): Promise<OrderResponse> {
  return apiClient.postWithReceipt<OrderResponse>('/orders/items', request);
}

export function updateOrderItem(
  orderId: string,
  itemId: string,
  request: UpdateOrderItemRequest,
): Promise<OrderResponse> {
  return apiClient.patch<OrderResponse>(`/orders/${orderId}/items/${itemId}`, request);
}

/**
 * Dispatches everything not yet sent as one new ticket. The server computes
 * the delta; the client only says which version of the order it is looking at.
 */
export function sendToKitchen(
  orderId: string,
  expectedVersion: number,
): Promise<SendToKitchenResponse> {
  return apiClient.postWithReceipt<SendToKitchenResponse>(`/orders/${orderId}/send-kot`, {
    expectedVersion,
  });
}

/** The version rides in the query string because DELETE carries no body. */
export function removeOrderItem(
  orderId: string,
  itemId: string,
  expectedVersion: number,
): Promise<MaybeOrderResponse> {
  return apiClient.delete<MaybeOrderResponse>(
    `/orders/${orderId}/items/${itemId}?expectedVersion=${String(expectedVersion)}`,
  );
}

export function transferTable(
  orderId: string,
  request: TransferTableRequest,
): Promise<OrderResponse> {
  return apiClient.postWithReceipt(`/orders/${orderId}/transfer-table`, request);
}
