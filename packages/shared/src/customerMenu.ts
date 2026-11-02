import type { PromotionSummary } from './offers';
/** Public guest contract. No staff, stock quantities, recipes, tables or sales data. */
export interface CustomerMenuItem {
  readonly promotion?: PromotionSummary | null;
  readonly id: string;
  readonly name: string;
  readonly nameNp: string | null;
  readonly pricePaisa: number;
  readonly isAvailable: boolean;
  readonly components: readonly {
    readonly name: string;
    readonly nameNp: string | null;
    readonly quantity: number;
  }[];
}

export interface CustomerMenuResponse {
  readonly restaurant: { readonly name: string; readonly address: string; readonly phone: string };
  readonly charges: {
    readonly vatRateBp: number;
    readonly serviceChargeRateBp: number;
  };
  readonly categories: readonly {
    readonly id: string;
    readonly name: string;
    readonly nameNp: string | null;
    readonly items: readonly CustomerMenuItem[];
  }[];
}
