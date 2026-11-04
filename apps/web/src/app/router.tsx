import { lazy, type JSX, type ReactNode } from 'react';
import { createBrowserRouter, Navigate } from 'react-router';
import type { AuthenticatedStaff, StaffRole } from '@nayaro/shared';
import { hasServicePermission } from '@nayaro/shared';
import { AppShell } from '@/components/layout/AppShell';
import { AuthenticatedRoute, PublicRoute, RoleRoute } from './routeGuards';
import { LoginScreen } from '@/screens/LoginScreen';

/** Screens load on first visit, so signing in does not download the whole back office. */
const DashboardScreen = lazy(() =>
  import('@/screens/DashboardScreen').then((module) => ({ default: module.DashboardScreen })),
);
const TablesScreen = lazy(() =>
  import('@/screens/TablesScreen').then((module) => ({ default: module.TablesScreen })),
);
const OrdersScreen = lazy(() =>
  import('@/screens/OrdersScreen').then((module) => ({ default: module.OrdersScreen })),
);
const OrderScreen = lazy(() =>
  import('@/screens/OrderScreen').then((module) => ({ default: module.OrderScreen })),
);
const KitchenScreen = lazy(() =>
  import('@/screens/KitchenScreen').then((module) => ({ default: module.KitchenScreen })),
);
const BillingScreen = lazy(() =>
  import('@/screens/BillingScreen').then((module) => ({ default: module.BillingScreen })),
);
const MenuScreen = lazy(() =>
  import('@/screens/MenuScreen').then((module) => ({ default: module.MenuScreen })),
);
const BillsScreen = lazy(() =>
  import('@/screens/BillsScreen').then((module) => ({ default: module.BillsScreen })),
);
const DrawerScreen = lazy(() =>
  import('@/screens/DrawerScreen').then((module) => ({ default: module.DrawerScreen })),
);
const ReportsScreen = lazy(() =>
  import('@/screens/ReportsScreen').then((module) => ({ default: module.ReportsScreen })),
);
const CustomersScreen = lazy(() =>
  import('@/screens/CustomersScreen').then((module) => ({ default: module.CustomersScreen })),
);
const StaffScreen = lazy(() =>
  import('@/screens/StaffScreen').then((module) => ({ default: module.StaffScreen })),
);
const SettingsScreen = lazy(() =>
  import('@/screens/SettingsScreen').then((module) => ({ default: module.SettingsScreen })),
);
const ExpensesScreen = lazy(() =>
  import('@/screens/ExpensesScreen').then((module) => ({ default: module.ExpensesScreen })),
);
const InventoryScreen = lazy(() =>
  import('@/screens/InventoryScreen').then((module) => ({ default: module.InventoryScreen })),
);
const AvailabilityScreen = lazy(() =>
  import('@/screens/AvailabilityScreen').then((module) => ({ default: module.AvailabilityScreen })),
);
const PayrollScreen = lazy(() =>
  import('@/screens/PayrollScreen').then((module) => ({ default: module.PayrollScreen })),
);
const PlatformShell = lazy(() =>
  import('@/features/platform/PlatformShell').then((module) => ({ default: module.PlatformShell })),
);
const PlatformLoginScreen = lazy(() =>
  import('@/screens/platform/PlatformLoginScreen').then((module) => ({ default: module.PlatformLoginScreen })),
);
const PlatformOverviewScreen = lazy(() =>
  import('@/screens/platform/PlatformOverviewScreen').then((module) => ({ default: module.PlatformOverviewScreen })),
);
const PlatformTenantsScreen = lazy(() =>
  import('@/screens/platform/PlatformTenantsScreen').then((module) => ({ default: module.PlatformTenantsScreen })),
);
const PlatformTenantScreen = lazy(() =>
  import('@/screens/platform/PlatformTenantScreen').then((module) => ({ default: module.PlatformTenantScreen })),
);
const PlatformSignupsScreen = lazy(() =>
  import('@/screens/platform/PlatformSignupsScreen').then((module) => ({ default: module.PlatformSignupsScreen })),
);
const PlatformActivityScreen = lazy(() =>
  import('@/screens/platform/PlatformActivityScreen').then((module) => ({ default: module.PlatformActivityScreen })),
);
const LandingScreen = lazy(() =>
  import('@/screens/LandingScreen').then((module) => ({ default: module.LandingScreen })),
);
const RegisterScreen = lazy(() =>
  import('@/screens/RegisterScreen').then((module) => ({ default: module.RegisterScreen })),
);
const GuestMenuScreen = lazy(() =>
  import('@/screens/GuestMenuScreen').then((module) => ({ default: module.GuestMenuScreen })),
);
const TableBillRoute = lazy(() =>
  import('@/features/billing/components/TableBillRoute').then((module) => ({
    default: module.TableBillRoute,
  })),
);

const roles =
  (...allowed: readonly StaffRole[]) =>
  (staff: AuthenticatedStaff): boolean =>
    allowed.includes(staff.role);
const MANAGEMENT = roles('OWNER', 'MANAGER');
const BILLING = roles('OWNER', 'MANAGER', 'CASHIER');
const TAKES_ORDERS = (staff: AuthenticatedStaff): boolean =>
  hasServicePermission(staff, 'TAKE_ORDERS');

function guard(allow: (staff: AuthenticatedStaff) => boolean, element: ReactNode): JSX.Element {
  return <RoleRoute allow={allow}>{element}</RoleRoute>;
}

/**
 * Browser history routing: the web server rewrites unknown paths to
 * index.html, so every screen has a real, shareable URL.
 */
export const router = createBrowserRouter([
  { path: '/m/:workspace', element: <GuestMenuScreen /> },
  // The Nayaro console: its own accounts and guard, outside the restaurant app.
  { path: '/admin/login', element: <PlatformLoginScreen /> },
  {
    path: '/admin',
    element: <PlatformShell />,
    children: [
      { index: true, element: <PlatformOverviewScreen /> },
      { path: 'restaurants', element: <PlatformTenantsScreen /> },
      { path: 'restaurants/:id', element: <PlatformTenantScreen /> },
      { path: 'signups', element: <PlatformSignupsScreen /> },
      { path: 'activity', element: <PlatformActivityScreen /> },
    ],
  },
  {
    element: <PublicRoute />,
    children: [
      // Visitors get the landing page; signed-in staff are sent to work by PublicRoute.
      { path: '/', element: <LandingScreen /> },
      { path: '/login', element: <LoginScreen /> },
      { path: '/register', element: <RegisterScreen /> },
    ],
  },
  {
    element: <AuthenticatedRoute />,
    children: [
      {
        element: <AppShell />,
        children: [
          { path: '/dashboard', element: guard(MANAGEMENT, <DashboardScreen />) },
          { path: '/tables', element: guard(TAKES_ORDERS, <TablesScreen />) },
          { path: '/kitchen', element: <KitchenScreen /> },
          { path: '/billing/table/:tableId', element: guard(BILLING, <TableBillRoute />) },
          { path: '/billing/:orderId', element: guard(BILLING, <BillingScreen />) },
          { path: '/customers', element: guard(BILLING, <CustomersScreen />) },
          { path: '/customers/:customerId', element: guard(BILLING, <CustomersScreen />) },
          { path: '/bills', element: guard(BILLING, <BillsScreen />) },
          { path: '/drawer', element: guard(BILLING, <DrawerScreen />) },
          { path: '/reports', element: guard(MANAGEMENT, <ReportsScreen />) },
          { path: '/expenses', element: guard(MANAGEMENT, <ExpensesScreen />) },
          { path: '/inventory', element: guard(MANAGEMENT, <InventoryScreen />) },
          { path: '/availability', element: <AvailabilityScreen /> },
          { path: '/menu', element: guard(MANAGEMENT, <MenuScreen />) },
          { path: '/staff', element: guard(MANAGEMENT, <StaffScreen />) },
          { path: '/payroll', element: guard(roles('OWNER'), <PayrollScreen />) },
          { path: '/orders', element: guard(TAKES_ORDERS, <OrdersScreen />) },
          {
            path: '/orders/table/:tableId',
            element: guard(TAKES_ORDERS, <OrderScreen mode="table" />),
          },
          {
            path: '/orders/takeaway',
            element: guard(TAKES_ORDERS, <OrderScreen mode="takeaway" />),
          },
          { path: '/orders/:orderId', element: guard(TAKES_ORDERS, <OrderScreen mode="order" />) },
          { path: '/settings', element: guard(MANAGEMENT, <SettingsScreen />) },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);
