import type { JSX } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Activity } from 'lucide-react';
import { Page, PageHeader } from '@/components/layout/Page';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/States';
import { platformApi } from '@/features/platform/platformApi';
import { ActivityRow } from '@/features/platform/parts';

/** Everything that happened across every restaurant, newest first. */
export function PlatformActivityScreen(): JSX.Element {
  const feed = useInfiniteQuery({
    queryKey: ['platform', 'activity'],
    queryFn: ({ pageParam }) => platformApi.activity(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    refetchInterval: 30_000,
  });
  const entries = feed.data?.pages.flatMap((page) => page.entries) ?? [];

  return (
    <Page>
      <PageHeader
        title="Activity"
        description="Sign-ups, sign-ins, failed sign-ins, staff and settings changes, and Nayaro account actions."
      />
      <Card>
        {feed.isPending ? (
          <LoadingState />
        ) : feed.isError && entries.length === 0 ? (
          <ErrorState error={feed.error} onRetry={() => void feed.refetch()} />
        ) : entries.length === 0 ? (
          <EmptyState icon={Activity} title="Nothing yet" />
        ) : (
          <>
            <ul className="divide-border divide-y">
              {entries.map((entry) => (
                <ActivityRow key={entry.id} entry={entry} />
              ))}
            </ul>
            {feed.hasNextPage && (
              <div className="border-border border-t p-4 text-center">
                <Button variant="secondary" loading={feed.isFetchingNextPage} onClick={() => void feed.fetchNextPage()}>
                  Load older
                </Button>
              </div>
            )}
          </>
        )}
      </Card>
    </Page>
  );
}
