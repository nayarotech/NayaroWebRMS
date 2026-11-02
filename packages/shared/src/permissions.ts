import type { StaffRole } from './api';

/** Extra operational duties; billing and management remain controlled by role. */
export interface StaffDuties {
  readonly canTakeOrders?: boolean;
  readonly canManageKitchen?: boolean;
}

type StaffAccess = StaffDuties & { readonly role: StaffRole };
export type ServicePermission = 'TAKE_ORDERS' | 'MANAGE_KITCHEN';

export function hasServicePermission(staff: StaffAccess, permission: ServicePermission): boolean {
  if (permission === 'TAKE_ORDERS') {
    return (
      ['OWNER', 'MANAGER', 'CASHIER', 'WAITER'].includes(staff.role) || staff.canTakeOrders === true
    );
  }
  return ['OWNER', 'MANAGER', 'KITCHEN'].includes(staff.role) || staff.canManageKitchen === true;
}
