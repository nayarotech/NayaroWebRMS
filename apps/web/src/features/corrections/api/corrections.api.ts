import type {
  CancelOrderItemRequest,
  CorrectionRequest,
  InvoiceDto,
  OrderResponse,
} from '@nayaro/shared';
import { apiClient } from '@/services/apiClient';

/**
 * The four corrections, as four explicit actions.
 *
 * Note the absence of anything called `deleteInvoice` or `deletePayment`.
 * Nothing in this file removes a row: a correction reverses a record and says
 * who did it and why, and the API offers no other shape.
 */

export function voidKot(kotId: string, request: CorrectionRequest): Promise<OrderResponse> {
  return apiClient.post<OrderResponse>(`/kitchen/tickets/${kotId}/void`, request);
}

export function cancelOrderItem(
  orderId: string,
  itemId: string,
  request: CancelOrderItemRequest,
): Promise<OrderResponse> {
  return apiClient.post<OrderResponse>(`/orders/${orderId}/items/${itemId}/cancellations`, request);
}

export function voidInvoice(
  invoiceId: string,
  request: CorrectionRequest,
): Promise<{ invoice: InvoiceDto }> {
  return apiClient.post<{ invoice: InvoiceDto }>(`/invoices/${invoiceId}/void`, request);
}

export function voidPayment(
  paymentId: string,
  request: CorrectionRequest,
): Promise<{ invoice: InvoiceDto }> {
  return apiClient.post<{ invoice: InvoiceDto }>(`/payments/${paymentId}/void`, request);
}
