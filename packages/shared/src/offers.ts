export interface PromotionSummary {
  readonly name: string;
  readonly rateBp: number;
  readonly regularUnitPricePaisa: number;
}
export type OfferScope = 'ALL' | 'ITEMS' | 'CATEGORIES';
export interface OfferDefinition {
  readonly name: string;
  readonly rateBp: number;
  readonly scope: OfferScope;
  readonly targetIds: readonly string[];
  readonly startsAt: string;
  readonly endsAt: string;
  readonly isActive: boolean;
}
export interface ManagedOffer extends OfferDefinition {
  readonly id: string;
  readonly version: number;
  readonly updatedAt: string;
  readonly updatedBy: string;
}
export interface OffersResponse {
  readonly offers: readonly ManagedOffer[];
}
export type CreateOfferRequest = OfferDefinition;
export type UpdateOfferRequest = Partial<OfferDefinition> & { readonly expectedVersion: number };
