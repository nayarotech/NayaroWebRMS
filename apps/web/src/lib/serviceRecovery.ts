import type { QueryClient } from '@tanstack/react-query';

/** Socket reconnection is a signal to read authoritative state, never replay writes. */
export function watchServiceConnection(
  queryClient: QueryClient,
  subscribe: (listener: () => void) => () => void,
  getSnapshot: () => { state: string; connectCount: number },
): () => void {
  let connectCount = 0;
  const refresh = (): void => {
    const current = getSnapshot();
    if (current.state === 'connected' && current.connectCount !== connectCount) {
      connectCount = current.connectCount;
      void queryClient.invalidateQueries();
    }
  };
  const unsubscribe = subscribe(refresh);
  refresh();
  return unsubscribe;
}

/** Only the service data currently on screen contributes to its sync status. */
export function serviceSyncSnapshot(queryClient: QueryClient): string {
  const queries = queryClient.getQueryCache().findAll({
    predicate: (query) =>
      query.isActive() &&
      ['floor', 'tables', 'orders', 'kitchen'].includes(String(query.queryKey[0])),
  });
  const lastSuccessAt =
    queries.length === 0 ? 0 : Math.min(...queries.map((query) => query.state.dataUpdatedAt));
  const failed = queries.some((query) => query.state.status === 'error');
  return JSON.stringify({ lastSuccessAt, failed });
}

/** An order can move between tables; refresh identity, both table views and kitchen labels. */
export async function refreshOrderViews(queryClient: QueryClient): Promise<void> {
  await Promise.all(
    ['floor', 'tables', 'orders', 'kitchen'].map((key) =>
      queryClient.invalidateQueries({ queryKey: [key] }),
    ),
  );
}
