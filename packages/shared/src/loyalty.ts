export interface LoyaltyProgram {
  readonly enabled: boolean;
  readonly earnEveryPaisa: number;
  readonly pointValuePaisa: number;
  readonly version: number;
}
export interface LoyaltySummary {
  readonly customerName: string;
  readonly pointsRedeemed: number;
  readonly redemptionPaisa: number;
  readonly pointsEarned: number;
  readonly pointsReturned: number;
}
export interface LoyaltyStatement {
  readonly customerId: string;
  readonly customerName: string;
  readonly isActive: boolean;
  readonly balancePoints: number;
  readonly entries: readonly {
    readonly id: string;
    readonly kind: string;
    readonly reason: string | null;
    readonly deltaPoints: number;
    readonly at: string;
    readonly invoiceNumber: number;
    readonly staffName: string;
  }[];
}
export interface OrderLoyaltyResponse {
  readonly rewardOnlyInvoiceId: string | null;
  readonly program: LoyaltyProgram;
  readonly orderVersion: number;
  readonly editable: boolean;
  readonly customerId: string | null;
  readonly pointsToRedeem: number;
  readonly redemptionPaisa: number;
  readonly statement: LoyaltyStatement | null;
}
