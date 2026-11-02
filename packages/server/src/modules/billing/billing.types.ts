import type {
  DiscountType,
  PaymentMethod,
  InvoiceStatus,
  InvoiceType,
  KotStatus,
  OrderStatus,
  OrderType,
} from '@nayaro/database';

export type {
  BillingResponse,
  InvoiceDto,
  IssueInvoiceRequest,
  PreBillDto,
  SetDiscountRequest,
} from '@nayaro/shared';

/** Exactly what INVOICE_SELECT returns. Internal to this module. */
export interface InvoiceRow {
  readonly loyaltySnapshot: string | null;
  readonly loyaltyEntries: readonly { readonly kind: string; readonly deltaPoints: number }[];
  readonly id: string;
  readonly invoiceType: InvoiceType;
  readonly invoiceNumber: number;
  readonly fiscalYearStartBsYear: number;
  readonly status: InvoiceStatus;
  readonly issuedAt: Date;
  readonly businessDate: string;
  readonly buyerName: string | null;
  readonly buyerPan: string | null;
  readonly buyerAddress: string | null;
  readonly sellerName: string | null;
  readonly sellerAddress: string | null;
  readonly sellerPan: string | null;
  readonly subtotalPaisa: number;
  readonly discountType: DiscountType;
  readonly discountValue: number;
  readonly discountPaisa: number;
  readonly serviceChargeRateBp: number;
  readonly serviceChargePaisa: number;
  readonly vatRateBp: number;
  readonly vatPaisa: number;
  readonly roundingAdjustmentPaisa: number;
  readonly grandTotalPaisa: number;
  readonly voidedAt: Date | null;
  readonly voidReason: string | null;
  readonly voidedByStaff: { readonly id: string; readonly name: string } | null;
  readonly order: {
    readonly id: string;
    readonly orderNumber: number;
    readonly type: OrderType;
    readonly status: OrderStatus;
    readonly version: number;
    readonly table: { readonly name: string } | null;
  };
  readonly payments: readonly {
    readonly id: string;
    readonly method: PaymentMethod;
    readonly amountPaisa: number;
    readonly refunds: readonly {
      readonly id: string;
      readonly paymentId: string;
      readonly amountPaisa: number;
      readonly method: PaymentMethod;
      readonly reason: string;
      readonly businessDate: string;
      readonly createdAt: Date;
      readonly staff: { readonly id: string; readonly name: string };
    }[];
    readonly itemAllocations: readonly {
      readonly invoiceLineId: string;
      readonly quantity: number;
      readonly amountPaisa: number;
    }[];
    readonly tenderedPaisa: number | null;
    readonly reference: string | null;
    readonly creditAccountName: string | null;
    readonly customerId: string | null;
    readonly createdAt: Date;
    readonly receivedByStaff: { readonly id: string; readonly name: string };
    readonly voidedAt: Date | null;
    readonly voidReason: string | null;
    readonly voidedByStaff: { readonly id: string; readonly name: string } | null;
  }[];
  readonly lines: readonly {
    readonly id: string;
    readonly lineNumber: number;
    readonly description: string;
    readonly descriptionNp: string | null;
    readonly promotionSnapshot: string | null;
    readonly quantity: number;
    readonly unitPricePaisa: number;
    readonly lineTotalPaisa: number;
  }[];
  readonly _count: { readonly prints: number };
}

/** The order shape the billing calculation reads. */
export interface OrderForBillingRow {
  readonly loyaltyPointsToRedeem: number;
  readonly loyaltyCustomer: { readonly name: string } | null;
  readonly id: string;
  readonly orderNumber: number;
  readonly type: OrderType;
  readonly status: OrderStatus;
  readonly version: number;
  readonly tableId: string | null;
  readonly table: { readonly name: string } | null;
  readonly discountType: DiscountType;
  readonly discountValue: number;
  readonly items: readonly {
    readonly id: string;
    readonly nameSnapshot: string;
    readonly nameNpSnapshot: string | null;
    readonly promotionSnapshot: string | null;
    readonly quantity: number;
    readonly unitPricePaisa: number;
    readonly createdAt: Date;
    readonly cancellations: readonly { readonly quantity: number }[];
  }[];
  readonly kots: readonly { readonly status: KotStatus }[];
  readonly settings: {
    readonly abbreviatedInvoiceAuthorized: boolean;
    readonly abbreviatedInvoiceCeilingPaisa: number;
    readonly businessDayStartsAtMinutes: number;
    readonly timezone: string;
  };
}
