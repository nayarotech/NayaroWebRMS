import { useState, type ReactNode, type JSX } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ApiRequestError } from '@/services/apiClient';

/**
 * TanStack Query defaults for a hosted API.
 *
 * retry: a 4xx is never retried - the server will reject the same request the
 *   same way. Network failures and 5xx get two retries with backoff, enough to
 *   ride out a dropped connection on restaurant Wi-Fi.
 *
 * refetchOnWindowFocus: off. A cashier switches windows constantly; freshness
 *   comes from Socket.IO invalidations, and the shell refetches everything on
 *   screen after the live connection recovers.
 *
 * Mutations are never retried automatically: a retried "take payment" could
 *   double up. Receipt-backed writes have their own safe retry in the API client.
 */
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => {
          if (error instanceof ApiRequestError && error.kind === 'http' && error.status !== null) {
            if (error.status < 500) return false;
          }
          return failureCount < 2;
        },
        retryDelay: (attempt) => Math.min(4000, 500 * 2 ** attempt),
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

export function AppProviders({ children }: { children: ReactNode }): JSX.Element {
  const [queryClient] = useState(createQueryClient);
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
