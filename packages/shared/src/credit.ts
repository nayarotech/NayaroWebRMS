import type { PaymentMethod } from './api';

export type CollectionMethod = Exclude<PaymentMethod, 'CREDIT'>;
export interface CustomerDto {
  readonly id: string;
  readonly name: string;
  readonly phone: string | null;
  readonly address: string | null;
  readonly isActive: boolean;
  readonly version: number;
  readonly creditPaisa: number;
  readonly repaidPaisa: number;
  readonly balancePaisa: number;
}
export interface CustomerListResponse {
  readonly customers: readonly CustomerDto[];
}
export interface CustomerRequest {
  readonly name: string;
  readonly phone?: string;
  readonly address?: string;
}
export interface CreditEntryDto {
  readonly id: string;
  readonly kind: 'CREDIT' | 'CREDIT_VOID' | 'REPAYMENT' | 'REVERSAL' | 'CREDIT_REFUND';
  readonly at: string;
  readonly description: string;
  readonly method: PaymentMethod;
  /** Positive adds debt; negative reduces it. */
  readonly amountPaisa: number;
  readonly balancePaisa: number;
  readonly staff: { readonly id: string; readonly name: string };
  readonly orderId: string | null;
  readonly repaymentId: string | null;
  readonly canReverse: boolean;
}
export interface CustomerStatementResponse {
  readonly customer: CustomerDto;
  readonly entries: readonly CreditEntryDto[];
}
export interface RepaymentRequest {
  readonly expectedVersion: number;
  readonly amountPaisa: number;
  readonly method: CollectionMethod;
  readonly reference?: string;
  readonly note?: string;
}
export interface UnassignedCreditDto {
  readonly id: string;
  readonly name: string | null;
  readonly amountPaisa: number;
  readonly at: string;
  readonly invoiceNumber: number;
  readonly fiscalYearLabel: string;
  readonly orderId: string;
}
export interface UnassignedCreditResponse {
  readonly payments: readonly UnassignedCreditDto[];
}
export interface CreditCollectionsDto {
  readonly byMethod: readonly {
    readonly method: CollectionMethod;
    readonly receivedPaisa: number;
    readonly reversedPaisa: number;
    readonly netPaisa: number;
  }[];
  readonly receivedPaisa: number;
  readonly reversedPaisa: number;
  readonly netPaisa: number;
}
