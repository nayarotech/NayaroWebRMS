import type { PaymentMethod } from './api';

export interface RefundDto {
  readonly id: string;
  readonly paymentId: string;
  readonly amountPaisa: number;
  readonly method: PaymentMethod;
  readonly reason: string;
  readonly businessDate: string;
  readonly createdAt: string;
  readonly staff: { readonly id: string; readonly name: string };
}
export interface RefundSummaryDto {
  readonly totalPaisa: number;
  readonly byMethod: readonly { readonly method: PaymentMethod; readonly amountPaisa: number }[];
  readonly rows: readonly RefundDto[];
}

export interface ReceiptAttachment {
  readonly name: string;
  readonly mime: 'image/png' | 'image/jpeg' | 'application/pdf';
  readonly base64: string;
}
export interface ExpenseDto {
  readonly id: string;
  readonly amountPaisa: number;
  readonly method: Exclude<PaymentMethod, 'CREDIT'>;
  readonly category: string;
  readonly supplier: string | null;
  readonly note: string;
  readonly businessDate: string;
  readonly createdAt: string;
  readonly staff: { readonly id: string; readonly name: string };
  readonly cashMovementId: string | null;
  readonly receiptName: string | null;
}
export interface ExpenseSummaryDto {
  readonly currentBusinessDate: string;
  readonly from: string;
  readonly to: string;
  readonly expenses: readonly ExpenseDto[];
  readonly totalPaisa: number;
  readonly salesPaisa: number;
  readonly refundsPaisa: number;
  readonly salesLessRefundsAndExpensesPaisa: number;
  readonly byCategory: readonly { readonly category: string; readonly amountPaisa: number }[];
}

export interface IngredientDto {
  readonly id: string;
  readonly name: string;
  readonly unit: 'g' | 'ml' | 'each';
  readonly onHandMilli: number;
  readonly lowStockMilli: number;
  readonly version: number;
  readonly isActive: boolean;
  readonly lowStock: boolean;
}
export interface StockMovementDto {
  readonly id: string;
  readonly ingredientId: string;
  readonly ingredient: { readonly name: string; readonly unit: string };
  readonly staff: { readonly id: string; readonly name: string };
  readonly kind: string;
  readonly deltaMilli: number;
  readonly balanceAfterMilli: number;
  readonly supplier: string | null;
  readonly costPaisa: number | null;
  readonly expenseId: string | null;
  readonly reason: string;
  readonly createdAt: string;
}
export interface AvailabilityItemDto {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly isAvailable: boolean;
  readonly stockAvailable: boolean;
  readonly recipeVersion: number;
}
export interface AvailabilityResponse {
  readonly items: readonly AvailabilityItemDto[];
}
export interface InventoryResponse {
  readonly recipeChanges: readonly {
    readonly id: string;
    readonly menuItem: { readonly name: string };
    readonly staff: { readonly name: string };
    readonly reason: string;
    readonly beforeJson: string;
    readonly afterJson: string;
    readonly createdAt: string;
  }[];
  readonly availabilityChanges: readonly {
    readonly id: string;
    readonly menuItem: { readonly name: string };
    readonly staff: { readonly name: string };
    readonly reason: string;
    readonly isAvailable: boolean;
    readonly createdAt: string;
  }[];
  readonly ingredients: readonly IngredientDto[];
  readonly movements: readonly StockMovementDto[];
  readonly moreMovements: boolean;
  readonly recipes: readonly {
    readonly menuItemId: string;
    readonly ingredientId: string;
    readonly quantityMilli: number;
  }[];
  readonly menu: readonly AvailabilityItemDto[];
}
