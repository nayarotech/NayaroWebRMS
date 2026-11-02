import { Suspense, useCallback, useState, type JSX } from 'react';
import { Outlet } from 'react-router';
import { useKeyboardShortcut } from '@/hooks/useKeyboardShortcut';
import { useRealtimeRecovery } from '@/hooks/useRealtimeRecovery';
import { readStorage, writeStorage } from '@/lib/storage';
import { LoadingState } from '@/components/ui/States';
import { Sidebar } from './Sidebar';
import { Header } from './Header';

const COLLAPSED_KEY = 'nayaro.sidebar.collapsed';

/**
 * The authenticated shell: navy sidebar, header, and one scrolling content
 * area. Below the large breakpoint the sidebar becomes a slide-over menu.
 */
export function AppShell(): JSX.Element {
  const [collapsed, setCollapsed] = useState(() => readStorage(COLLAPSED_KEY) === 'true');
  const [mobileOpen, setMobileOpen] = useState(false);
  useRealtimeRecovery();

  const toggleSidebar = useCallback(() => {
    setCollapsed((value) => {
      writeStorage(COLLAPSED_KEY, String(!value));
      return !value;
    });
  }, []);
  useKeyboardShortcut('b', toggleSidebar, { ctrl: true });

  return (
    <div className="flex h-dvh overflow-hidden">
      <Sidebar collapsed={collapsed} onToggle={toggleSidebar} className="hidden lg:flex" />

      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => {
              setMobileOpen(false);
            }}
            className="animate-fade absolute inset-0 bg-[var(--ny-overlay)]"
          />
          <Sidebar
            collapsed={false}
            onToggle={toggleSidebar}
            onNavigate={() => {
              setMobileOpen(false);
            }}
            className="relative z-10 shadow-overlay"
          />
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <Header
          onOpenMenu={() => {
            setMobileOpen(true);
          }}
        />
        <main id="main" className="min-w-0 flex-1 overflow-y-auto">
          <Suspense fallback={<LoadingState />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
