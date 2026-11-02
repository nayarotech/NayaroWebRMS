import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiClient, ApiRequestError } from '@/services/apiClient';

export function useOperation() {
  const cache = useQueryClient();
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run<T>(path: string, body: unknown): Promise<T | null> {
    if (locked.current) return null;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      return await apiClient.postWithReceipt<T>(path, body);
    } catch (cause: unknown) {
      setError(
        cause instanceof ApiRequestError && cause.kind === 'http'
          ? cause.message
          : 'Could not confirm the action. Refresh and check the history before trying again.',
      );
      return null;
    } finally {
      await cache.invalidateQueries();
      locked.current = false;
      setBusy(false);
    }
  }
  return { run, busy, error };
}
