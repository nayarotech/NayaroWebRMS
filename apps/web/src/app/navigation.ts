import {
  BarChart3,
  BookOpen,
  ChefHat,
  ClipboardList,
  CookingPot,
  HandCoins,
  LayoutDashboard,
  type LucideIcon,
  Package,
  ReceiptText,
  Settings,
  ShoppingBag,
  UsersRound,
  UtensilsCrossed,
  Wallet,
  WalletCards,
  Grid3x3,
  ListChecks,
} from 'lucide-react';
import { hasServicePermission, type AuthenticatedStaff, type StaffRole } from '@nayaro/shared';

export interface NavItem {
  readonly label: string;
  readonly to: string;
  readonly icon: LucideIcon;
  /** Short context shown in the header and in tooltips when collapsed. */
  readonly description: string;
  readonly isAllowed: (staff: AuthenticatedStaff) => boolean;
}

export interface NavGroup {
  readonly label: string | null;
  readonly items: readonly NavItem[];
}

const roles =
  (...allowed: readonly StaffRole[]) =>
  (staff: AuthenticatedStaff): boolean =>
    allowed.includes(staff.role);
const anyone = (): boolean => true;
const takesOrders = (staff: AuthenticatedStaff): boolean => hasServicePermission(staff, 'TAKE_ORDERS');

const MANAGEMENT = roles('OWNER', 'MANAGER');
const BILLING = roles('OWNER', 'MANAGER', 'CASHIER');

/**
 * The application's information architecture, in one place. The sidebar,
 * the mobile menu and the page titles all read from here, and items a role
 * cannot use are hidden rather than shown disabled. The server enforces the
 * same rules regardless; this only avoids offering a dead end.
 */
export const NAVIGATION: readonly NavGroup[] = [
  {
    label: null,
    items: [
      {
        label: 'Dashboard',
        to: '/dashboard',
        icon: LayoutDashboard,
        description: 'Sales, service and alerts at a glance',
        isAllowed: MANAGEMENT,
      },
    ],
  },
  {
    label: 'Service',
    items: [
      {
        label: 'Tables',
        to: '/tables',
        icon: Grid3x3,
        description: 'Floor plan and table status',
        isAllowed: takesOrders,
      },
      {
        label: 'Orders',
        to: '/orders',
        icon: ListChecks,
        description: 'Every order in service: kitchen, ready, awaiting payment',
        isAllowed: takesOrders,
      },
      {
        label: 'Takeaway',
        to: '/orders/takeaway',
        icon: ShoppingBag,
        description: 'Counter and takeaway orders',
        isAllowed: takesOrders,
      },
      {
        label: 'Kitchen',
        to: '/kitchen',
        icon: ChefHat,
        description: 'Tickets sent to the kitchen',
        isAllowed: anyone,
      },
      {
        label: 'Dish availability',
        to: '/availability',
        icon: UtensilsCrossed,
        description: 'What the kitchen can serve today',
        isAllowed: anyone,
      },
    ],
  },
  {
    label: 'Sales',
    items: [
      {
        label: 'Bills',
        to: '/bills',
        icon: ReceiptText,
        description: 'Issued invoices, reprints and refunds',
        isAllowed: BILLING,
      },
      {
        label: 'Cash drawer',
        to: '/drawer',
        icon: Wallet,
        description: 'Float, cash in and out, and counting up',
        isAllowed: BILLING,
      },
      {
        label: 'Customers',
        to: '/customers',
        icon: HandCoins,
        description: 'Credit accounts, statements and loyalty',
        isAllowed: BILLING,
      },
      {
        label: 'End of day',
        to: '/reports',
        icon: BarChart3,
        description: 'Daily sales, payments and Z report',
        isAllowed: MANAGEMENT,
      },
    ],
  },
  {
    label: 'Manage',
    items: [
      {
        label: 'Menu',
        to: '/menu',
        icon: BookOpen,
        description: 'Categories, dishes, set menus and offers',
        isAllowed: MANAGEMENT,
      },
      {
        label: 'Inventory',
        to: '/inventory',
        icon: Package,
        description: 'Ingredients, recipes and stock movements',
        isAllowed: MANAGEMENT,
      },
      {
        label: 'Expenses',
        to: '/expenses',
        icon: WalletCards,
        description: 'Spending, suppliers and receipts',
        isAllowed: MANAGEMENT,
      },
      {
        label: 'Staff',
        to: '/staff',
        icon: UsersRound,
        description: 'Accounts, roles and service duties',
        isAllowed: MANAGEMENT,
      },
      {
        label: 'Payroll',
        to: '/payroll',
        icon: ClipboardList,
        description: 'Monthly salaries, advances and payments',
        isAllowed: roles('OWNER'),
      },
      {
        label: 'Settings',
        to: '/settings',
        icon: Settings,
        description: 'Restaurant, tax, operations and security',
        isAllowed: MANAGEMENT,
      },
    ],
  },
];

/** Screens reached from inside a flow, named for the header. */
const FLOW_TITLES: readonly (readonly [string, { label: string; icon: LucideIcon }])[] = [
  ['/orders', { label: 'Order', icon: CookingPot }],
  ['/billing', { label: 'Billing', icon: ReceiptText }],
  ['/customers', { label: 'Customers', icon: HandCoins }],
];

export function visibleNavigation(staff: AuthenticatedStaff): NavGroup[] {
  return NAVIGATION.map((group) => ({
    ...group,
    items: group.items.filter((item) => item.isAllowed(staff)),
  })).filter((group) => group.items.length > 0);
}

export function currentSection(pathname: string): { label: string; icon: LucideIcon } | null {
  for (const group of NAVIGATION) {
    for (const item of group.items) {
      // /orders is the list; /orders/<id> and /orders/takeaway are other screens.
      const nested = item.to !== '/orders' && pathname.startsWith(`${item.to}/`);
      if (pathname === item.to || nested) {
        return { label: item.label, icon: item.icon };
      }
    }
  }
  return FLOW_TITLES.find(([prefix]) => pathname.startsWith(prefix))?.[1] ?? null;
}

/** Where a role lands after signing in. */
export function homePathFor(staff: AuthenticatedStaff): string {
  if (staff.role === 'OWNER' || staff.role === 'MANAGER') return '/dashboard';
  if (hasServicePermission(staff, 'TAKE_ORDERS')) return '/tables';
  return '/kitchen';
}
