import { Suspense, useEffect, type JSX } from 'react';
import { RouterProvider } from 'react-router';
import { router } from '@/app/router';
import { startSiteAnalytics } from '@/services/siteAnalytics';

/** Deliberately minimal: routing configuration lives in app/router.tsx. */
export function App(): JSX.Element {
  useEffect(
    () =>
      startSiteAnalytics((listener) =>
        router.subscribe((state) => {
          listener(state.location.pathname);
        }),
      ),
    [],
  );
  return (
    <Suspense fallback={null}>
      <RouterProvider router={router} />
    </Suspense>
  );
}
