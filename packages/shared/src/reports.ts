/**
 * Cash drawer and end-of-day contracts.
 *
 * Kept apart from api.ts for the same reason management.ts is: these are read
 * at the end of a shift by the person responsible for the money, and change
 * for different reasons than the service-floor contracts do.
 *
 * Money is integer paisa throughout, as everywhere else.
 */
import type { CreditCollectionsDto } from './credit';
import type { ExpenseSummaryDto, RefundSummaryDto } from './operations';
import type { OrderStatus, OrderType, PaymentMethod } from './api';

interface StaffRef {
  readonly id: string;
  readonly name: string;
}

// --- cash drawer -------------------------------------------------------------

export type CashMovementType = 'PAY_IN' | 'PAY_OUT';

export interface CashMovementDto {
  readonly id: string;
  readonly type: CashMovementType;
  readonly amountPaisa: number;
  readonly reason: string;
  readonly createdAt: string;
  readonly staff: StaffRef;
}

/** Live payments taken while the drawer was open, by method. */
export interface ShiftTakingsDto {
  readonly method: PaymentMethod;
  readonly count: number;
  readonly amountPaisa: number;
}

export interface ShiftCloseDto {
  readonly closedAt: string;
  readonly closedBy: StaffRef;
  /** Frozen at close. Later corrections do not rewrite it. */
  readonly expectedCashPaisa: number;
  readonly countedCashPaisa: number;
  /** counted - expected. Negative is a shortage. */
  readonly variancePaisa: number;
  readonly note: string | null;
}

export interface ShiftDto {
  readonly id: string;
  readonly businessDate: string;
  readonly status: 'OPEN' | 'CLOSED';
  readonly openedAt: string;
  readonly openedBy: StaffRef;
  readonly openingFloatPaisa: number;
  readonly takings: readonly ShiftTakingsDto[];
  /** Cash payments only - the part of the takings that is in the drawer. */
  readonly cashSalesPaisa: number;
  readonly cashCreditCollectionsPaisa: number;
  readonly payInsPaisa: number;
  readonly payOutsPaisa: number;
  /**
   * float + cash sales + net cash credit collections + pay-ins - pay-outs. For an open drawer this is live;
   * for a closed one it is the figure frozen at close.
   */
  readonly expectedCashPaisa: number;
  readonly movements: readonly CashMovementDto[];
  readonly close: ShiftCloseDto | null;
}

export interface CurrentShiftResponse {
  readonly shift: ShiftDto | null;
}

export interface ShiftResponse {
  readonly shift: ShiftDto;
}

export interface OpenShiftRequest {
  readonly openingFloatPaisa: number;
}

export interface CashMovementRequest {
  readonly type: CashMovementType;
  readonly amountPaisa: number;
  readonly reason: string;
}

export interface CloseShiftRequest {
  readonly countedCashPaisa: number;
  readonly note?: string;
}

// --- end-of-day report -------------------------------------------------------

export interface DailySalesDto {
  /** ACTIVE invoices only. A voided bill was never a sale. */
  readonly invoiceCount: number;
  readonly subtotalPaisa: number;
  readonly discountPaisa: number;
  readonly serviceChargePaisa: number;
  readonly vatPaisa: number;
  readonly roundingPaisa: number;
  readonly grandTotalPaisa: number;
  readonly averageBillPaisa: number;
}

export interface OrderTypeSalesDto {
  readonly type: OrderType;
  readonly invoiceCount: number;
  readonly grandTotalPaisa: number;
}

export interface MethodTotalDto {
  readonly method: PaymentMethod;
  readonly count: number;
  readonly amountPaisa: number;
}

export interface DailyPaymentsDto {
  /** Live payments against the day's ACTIVE invoices. */
  readonly byMethod: readonly MethodTotalDto[];
  readonly totalPaisa: number;
  /** Billed but not yet paid. */
  readonly outstandingPaisa: number;
  readonly unpaidInvoiceCount: number;
}

/** Line totals before bill-level discount, service charge and VAT. */
export interface ItemSalesDto {
  readonly name: string;
  readonly category: string;
  readonly quantity: number;
  readonly totalPaisa: number;
}

export interface CategorySalesDto {
  readonly category: string;
  readonly quantity: number;
  readonly totalPaisa: number;
}

export interface StaffSalesDto {
  readonly staff: StaffRef;
  readonly invoiceCount: number;
  readonly grandTotalPaisa: number;
}

export interface DiscountRowDto {
  readonly invoiceNumber: number;
  readonly fiscalYearLabel: string;
  readonly orderId: string;
  readonly amountPaisa: number;
  readonly approvedBy: StaffRef | null;
}

export interface VoidedInvoiceRowDto {
  readonly invoiceNumber: number;
  readonly fiscalYearLabel: string;
  readonly orderId: string;
  readonly grandTotalPaisa: number;
  readonly reason: string;
  readonly voidedBy: StaffRef;
  readonly voidedAt: string;
}

export interface VoidedPaymentRowDto {
  readonly invoiceNumber: number;
  readonly method: PaymentMethod;
  readonly amountPaisa: number;
  readonly reason: string;
  readonly voidedBy: StaffRef;
  readonly voidedAt: string;
}

export interface CancelledItemRowDto {
  readonly orderNumber: number;
  readonly name: string;
  readonly quantity: number;
  readonly valuePaisa: number;
  readonly reason: string;
  readonly cancelledBy: StaffRef;
  readonly cancelledAt: string;
}

export interface VoidedTicketRowDto {
  readonly orderNumber: number;
  readonly kotNumber: number;
  readonly reason: string;
  readonly voidedBy: StaffRef;
  readonly voidedAt: string;
}

export interface UnbilledOrderDto {
  readonly orderId: string;
  readonly orderNumber: number;
  readonly status: OrderStatus;
  readonly tableName: string | null;
}

export interface DailyReportResponse {
  readonly expenses: ExpenseSummaryDto;
  readonly refunds: RefundSummaryDto;
  readonly businessDate: string;
  readonly generatedAt: string;
  readonly sales: DailySalesDto;
  readonly byOrderType: readonly OrderTypeSalesDto[];
  readonly payments: DailyPaymentsDto;
  readonly creditCollections: CreditCollectionsDto;
  /** Highest takings first. */
  readonly items: readonly ItemSalesDto[];
  readonly categories: readonly CategorySalesDto[];
  readonly staff: readonly StaffSalesDto[];
  readonly discounts: {
    readonly totalPaisa: number;
    readonly rows: readonly DiscountRowDto[];
  };
  readonly corrections: {
    readonly voidedInvoices: readonly VoidedInvoiceRowDto[];
    readonly voidedPayments: readonly VoidedPaymentRowDto[];
    readonly cancelledItems: readonly CancelledItemRowDto[];
    readonly voidedTickets: readonly VoidedTicketRowDto[];
  };
  /** Drawers opened on this business day, oldest first. */
  readonly shifts: readonly ShiftDto[];
  /** Orders from this day still not billed. A day is not finished while any exist. */
  readonly unbilledOrders: readonly UnbilledOrderDto[];
}

// --- dashboard overview ------------------------------------------------------

export interface SalesOverviewDay {
  readonly businessDate: string;
  readonly salesPaisa: number;
  readonly invoiceCount: number;
}

export interface SalesOverviewResponse {
  readonly businessDate: string;
  /** Oldest first, one entry per business day including today. */
  readonly days: readonly SalesOverviewDay[];
  /** Today's sales by hour of the restaurant's local day. */
  readonly hourly: readonly { readonly hour: number; readonly salesPaisa: number; readonly invoiceCount: number }[];
  readonly topItems: readonly { readonly name: string; readonly quantity: number; readonly salesPaisa: number }[];
  readonly paymentMix: readonly { readonly method: PaymentMethod; readonly amountPaisa: number }[];
  readonly live: {
    readonly openOrders: number;
    readonly occupiedTables: number;
    readonly awaitingPayment: number;
    readonly openTakeaways: number;
    readonly kitchen: { readonly NEW: number; readonly PREPARING: number; readonly READY: number };
    readonly lowStockIngredients: number;
  };
}
