import type { StaffDuties } from './permissions';
/**
 * Management contracts: menu, staff, settings and backup.
 *
 * These are the screens a restaurant uses to configure itself. They are kept
 * in their own module rather than piled into api.ts because they change for
 * different reasons than the service-floor contracts do - a menu edit and a
 * kitchen ticket have nothing to do with each other.
 */
import type { StaffRole } from './api';

// --- menu management ---------------------------------------------------------

export interface ComboComponent {
  readonly menuItemId: string;
  readonly quantity: number;
}

export interface ManagedMenuItem {
  readonly components: readonly ComboComponent[];
  readonly id: string;
  readonly name: string;
  readonly nameNp: string | null;
  readonly categoryId: string;
  readonly pricePaisa: number;
  /** Sold out today. Hidden from the POS, kept on the menu. */
  readonly isAvailable: boolean;
  /** Catalogue membership. Retired items stay so history resolves. */
  readonly isActive: boolean;
  readonly sortOrder: number;
}

export interface ManagedMenuCategory {
  readonly id: string;
  readonly name: string;
  readonly nameNp: string | null;
  readonly sortOrder: number;
  readonly isActive: boolean;
  readonly items: readonly ManagedMenuItem[];
}

/**
 * The whole catalogue, including everything the POS hides. A manager needs to
 * see the sold-out and retired items precisely because those are the ones they
 * have come here to change.
 */
export interface ManagedMenuResponse {
  readonly categories: readonly ManagedMenuCategory[];
}

export interface CreateMenuCategoryRequest {
  readonly name: string;
  readonly nameNp?: string;
}

export interface UpdateMenuCategoryRequest {
  readonly name?: string;
  readonly nameNp?: string | null;
  readonly sortOrder?: number;
  readonly isActive?: boolean;
}

export interface CreateMenuItemRequest {
  readonly components?: readonly ComboComponent[];
  readonly categoryId: string;
  readonly name: string;
  readonly nameNp?: string;
  readonly pricePaisa: number;
}

export interface UpdateMenuItemRequest {
  readonly components?: readonly ComboComponent[];
  readonly name?: string;
  readonly nameNp?: string | null;
  readonly categoryId?: string;
  readonly pricePaisa?: number;
  readonly isAvailable?: boolean;
  readonly isActive?: boolean;
  readonly sortOrder?: number;
}

// --- staff management --------------------------------------------------------

export interface ManagedStaff extends StaffDuties {
  readonly id: string;
  readonly name: string;
  readonly username: string;
  readonly role: StaffRole;
  readonly isActive: boolean;
  readonly lastLoginAt: string | null;
  /** True for the signed-in user, so the UI can label "you". */
  readonly isSelf: boolean;
}

export interface StaffListResponse {
  readonly staff: readonly ManagedStaff[];
}

export interface CreateStaffRequest extends StaffDuties {
  readonly name: string;
  readonly username: string;
  readonly password: string;
  readonly role: StaffRole;
}

export interface UpdateStaffRequest extends StaffDuties {
  readonly name?: string;
  readonly role?: StaffRole;
  readonly isActive?: boolean;
}

export interface ChangeOwnPasswordRequest {
  readonly currentPassword: string;
  readonly newPassword: string;
}

export interface ResetStaffPasswordRequest {
  readonly newPassword: string;
}

// --- settings ----------------------------------------------------------------

export interface RestaurantDetails {
  readonly name: string;
  readonly address: string;
  readonly phone: string;
  readonly panNumber: string;
}

export interface FinancialSettings {
  readonly vatEnabled: boolean;
  readonly vatRateBp: number;
  readonly serviceChargeEnabled: boolean;
  readonly serviceChargeRateBp: number;
  readonly serviceChargeAppliesToTakeaway: boolean;
  readonly roundGrandTotalToRupee: boolean;
  readonly defaultInvoiceType: 'STANDARD' | 'ABBREVIATED';
  readonly abbreviatedInvoiceAuthorized: boolean;
  readonly abbreviatedInvoiceCeilingPaisa: number;
}

export interface OperationalSettings {
  readonly customerMenuEnabled: boolean;
  readonly kitchenNewTicketAlertMinutes: number;
  /** Minutes after local midnight at which a new business day starts. */
  readonly businessDayStartsAtMinutes: number;
  readonly printPanOnBill: boolean;
  readonly showBsDateOnBill: boolean;
  readonly billFooterText: string | null;
}

export interface SettingsResponse {
  readonly restaurant: RestaurantDetails;
  readonly financial: FinancialSettings;
  readonly operational: OperationalSettings;
  /** Who last changed any of this, and when. */
  readonly updatedAt: string;
  readonly updatedBy: string | null;
}

export interface UpdateRestaurantRequest {
  readonly name?: string;
  readonly address?: string;
  readonly phone?: string;
  readonly panNumber?: string;
}

export type UpdateFinancialSettingsRequest = Partial<FinancialSettings>;
export type UpdateOperationalSettingsRequest = Partial<{
  readonly customerMenuEnabled: boolean;
  readonly kitchenNewTicketAlertMinutes: number;
  readonly businessDayStartsAtMinutes: number;
  readonly printPanOnBill: boolean;
  readonly showBsDateOnBill: boolean;
  readonly billFooterText: string | null;
}>;
