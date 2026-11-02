import { DEFAULT_NEW_TICKET_ALERT_MINUTES, hasServicePermission } from '@nayaro/shared';
import type { JSX } from 'react';
import type { KitchenTicket, KotStatus } from '@nayaro/shared';
import { ApiRequestError } from '@/services/apiClient';
import { useAuth } from '@/features/auth/hooks/useAuth';
import { Button } from '@/components/ui/Button';
import { TicketCard } from '@/features/kitchen/components/TicketCard';
import { useReadyAlert } from '@/features/kitchen/hooks/useReadyAlert';
import {
  useKitchenRealtime,
  useKitchenTickets,
  useKotTransitions,
  useNow,
  type KotTransitions,
} from '@/features/kitchen/hooks/useKitchen';
import { Page, PageHeader } from '@/components/layout/Page';
import { LoadingState } from '@/components/ui/States';

/**
 * The kitchen display.
 *
 * Four columns, in the order work moves through them, and a ticket carries at
 * most one button: the single legal next step. The screen embodies the state
 * machine rather than describing it, so there is no way to express an illegal
 * move - which is why there is no status dropdown anywhere on it.
 *
 * Authorized staff can work this board on the till or on their own phone.
 * This also supports a restaurant with only one computer.
 */
const COLUMNS: ReadonlyArray<{ status: KotStatus; title: string; empty: string }> = [
  { status: 'NEW', title: 'New', empty: 'Nothing waiting.' },
  { status: 'PREPARING', title: 'Preparing', empty: 'Nothing on the stove.' },
  { status: 'READY', title: 'Ready', empty: 'Nothing waiting to go out.' },
  { status: 'SERVED', title: 'Served', empty: 'Nothing served yet.' },
];

export function KitchenScreen(): JSX.Element {
  const { staff } = useAuth();
  const tickets = useKitchenTickets();
  const transitions = useKotTransitions();
  useKitchenRealtime();
  // One clock for the whole board rather than one per card.
  const now = useNow();

  const canCook = staff !== null && hasServicePermission(staff, 'MANAGE_KITCHEN');

  /*
   * The counter's alarm. Anyone who is NOT the kitchen wants to hear that food
   * is plated and waiting; the kitchen already knows, because they plated it.
   * Hooks cannot be conditional, so this sits above the early returns and
   * keeps listening while the board is loading.
   */
  const readyAlert = useReadyAlert(tickets.data?.tickets ?? [], true);

  if (tickets.isPending) {
    return (
      <Page>
        <LoadingState label="Loading the kitchen board…" />
      </Page>
    );
  }

  if (tickets.isError && tickets.data === undefined) {
    const forbidden = tickets.error instanceof ApiRequestError && tickets.error.status === 403;
    return (
      <Page>
        <div className="border-border bg-surface shadow-card rounded-card border px-8 py-12 text-center">
          <h2 className="text-[18px] font-extrabold tracking-tight">
            {forbidden
              ? 'The kitchen board is not part of your role'
              : 'Could not load the kitchen board'}
          </h2>
          <p className="text-muted mt-2 text-[14px] leading-relaxed">
            {tickets.error instanceof ApiRequestError && tickets.error.kind === 'http'
              ? tickets.error.message
              : 'Nayaro RMS could not be reached. Check your internet connection and try again.'}
          </p>
        </div>
      </Page>
    );
  }

  const all = tickets.data?.tickets ?? [];
  // A failed background refetch leaves stale data in place while `isSuccess`
  // stays true. On a kitchen screen that is the dangerous case, so it is said
  // out loud rather than left to look live.
  const isStale = tickets.errorUpdatedAt > tickets.dataUpdatedAt;

  return (
    <Page>
      <PageHeader
        title="Kitchen"
        description={
          <>
            {all.length === 0
              ? 'No tickets right now.'
              : `${String(all.length)} ${all.length === 1 ? 'ticket' : 'tickets'} on the board.`}
            {!canCook && ' The kitchen moves tickets; this screen watches them.'}
          </>
        }
        actions={
          <>
            {/*
             * Unavoidable, not an oversight: Chromium will not play a sound until
             * somebody has interacted with the window, and a till left open all
             * day may not have been clicked since it booted. An alarm that is
             * silently off is worse than no alarm, so it says so until fixed.
             */}
            {!readyAlert.soundReady && (
              <Button
                variant="secondary"
                className="ml-auto h-9 px-3 text-[12.5px]"
                onClick={readyAlert.enableSound}
              >
                🔔 Turn on the &ldquo;food ready&rdquo; sound
              </Button>
            )}
            {transitions.notice !== null && (
              <p
                role="status"
                className="border-warn/40 bg-warn/10 text-warn-fg ml-auto rounded-xl border px-3.5 py-2 text-[12.5px] font-semibold"
              >
                {transitions.notice}
                <button
                  type="button"
                  onClick={transitions.dismissNotice}
                  className="ml-2 underline underline-offset-2"
                >
                  Dismiss
                </button>
              </p>
            )}
            {isStale && (
              <span
                role="status"
                className="text-warn-fg border-warn/40 bg-warn/10 ml-auto rounded-xl border px-3 py-2 text-[12px] font-bold"
              >
                Not live — reconnecting
              </span>
            )}
          </>
        }
      />

      <div className="grid grid-cols-4 gap-4">
        {COLUMNS.map((column) => (
          <Column
            key={column.status}
            title={column.title}
            empty={column.empty}
            tickets={all.filter((ticket) => ticket.status === column.status)}
            now={now}
            fetchedAt={tickets.dataUpdatedAt}
            alertMinutes={tickets.data?.newTicketAlertMinutes ?? DEFAULT_NEW_TICKET_ALERT_MINUTES}
            {...(canCook ? { transitions } : {})}
          />
        ))}
      </div>
    </Page>
  );
}

function Column({
  title,
  empty,
  tickets,
  now,
  fetchedAt,
  alertMinutes,
  transitions,
}: {
  title: string;
  empty: string;
  tickets: readonly KitchenTicket[];
  now: number;
  fetchedAt: number;
  alertMinutes: number;
  transitions?: KotTransitions;
}): JSX.Element {
  return (
    <section aria-label={title} className="min-w-0">
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="text-[13px] font-extrabold tracking-tight">{title}</h2>
        <span className="text-muted-2 font-mono text-[11px] font-semibold">{tickets.length}</span>
      </div>

      {tickets.length === 0 ? (
        <p className="border-border-2 text-muted-2 rounded-card border border-dashed px-3 py-6 text-center text-[12.5px]">
          {empty}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {tickets.map((ticket) => (
            <TicketCard
              key={ticket.id}
              ticket={ticket}
              now={now}
              fetchedAt={fetchedAt}
              alertMinutes={alertMinutes}
              {...(transitions === undefined ? {} : { transitions })}
            />
          ))}
        </div>
      )}
    </section>
  );
}
