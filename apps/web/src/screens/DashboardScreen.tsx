import type { JSX } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import {
  BarChart3,
  Bell,
  ClipboardList,
  LayoutDashboard,
  Package,
  Plus,
  ShoppingBag,
} from 'lucide-react';
import { Page, PageBody, PageHeader } from '@/components/layout/Page';
import { Button } from '@/components/ui/Button';
import { Tabs, type TabItem } from '@/components/ui/Tabs';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { useDashboardRealtime, useSalesOverview } from '@/features/dashboard/useDashboard';
import { useLowStockAlerts } from '@/features/operations/LowStockAlert';
import { OverviewView } from '@/features/dashboard/OverviewView';
import { ReportsView } from '@/features/dashboard/ReportsView';
import { OrdersView } from '@/features/dashboard/OrdersView';
import { InventoryView } from '@/features/dashboard/InventoryView';
import { NotificationsView, useNotifications } from '@/features/dashboard/NotificationsView';

type DashboardView = 'overview' | 'reports' | 'orders' | 'inventory' | 'notifications';

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

/**
 * The owner's and manager's home. Sections switch in place below a tab bar
 * that stays visible, and the active section lives in the URL so a view can
 * be bookmarked or shared.
 */
export function DashboardScreen(): JSX.Element {
  const { staff, tenant } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const overview = useSalesOverview(14);
  const lowStock = useLowStockAlerts();
  const notifications = useNotifications();
  useDashboardRealtime();

  const live = overview.data?.live;
  const tabs: readonly TabItem<DashboardView>[] = [
    { value: 'overview', label: 'Overview', icon: LayoutDashboard },
    { value: 'reports', label: 'Reports', icon: BarChart3 },
    { value: 'orders', label: 'Orders', icon: ClipboardList, count: live?.openOrders },
    {
      value: 'inventory',
      label: 'Inventory',
      icon: Package,
      count: lowStock.data?.ingredients.length,
    },
    { value: 'notifications', label: 'Notifications', icon: Bell, count: notifications.length },
  ];
  const view = (tabs.find((tab) => tab.value === params.get('view'))?.value ??
    'overview') as DashboardView;

  return (
    <Page>
      <PageHeader
        title={`${greeting()}, ${staff?.name.split(' ')[0] ?? ''}`}
        description={tenant === null ? undefined : `Here is how ${tenant.name} is doing today.`}
        actions={
          <>
            <Button
              variant="secondary"
              icon={ShoppingBag}
              onClick={() => void navigate('/orders/takeaway')}
            >
              Takeaway
            </Button>
            <Button icon={Plus} onClick={() => void navigate('/tables')}>
              New order
            </Button>
          </>
        }
      >
        <Tabs
          label="Dashboard sections"
          items={tabs}
          value={view}
          onChange={(value) => {
            setParams(value === 'overview' ? {} : { view: value }, { replace: true });
          }}
        />
      </PageHeader>

      <PageBody>
        {view === 'overview' && <OverviewView overview={overview} />}
        {view === 'reports' && <ReportsView />}
        {view === 'orders' && <OrdersView />}
        {view === 'inventory' && <InventoryView />}
        {view === 'notifications' && <NotificationsView items={notifications} />}
      </PageBody>
    </Page>
  );
}
