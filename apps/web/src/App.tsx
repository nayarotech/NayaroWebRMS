import { Suspense, type JSX } from 'react';
import { RouterProvider } from 'react-router';
import { router } from '@/app/router';

/** Deliberately minimal: routing configuration lives in app/router.tsx. */
export function App(): JSX.Element {
  return (
    <Suspense fallback={null}>
      <RouterProvider router={router} />
    </Suspense>
  );
}
