import { isNewTicketOverdue, ticketElapsedSeconds } from '@nayaro/shared';
import type { JSX } from 'react';
import type { KitchenTicket } from '@nayaro/shared';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { NEXT_STEP, type KotTransitions } from '../hooks/useKitchen';

export interface TicketCardProps {
  readonly ticket: KitchenTicket;
  /** Shared clock, so the whole board ticks together in one render. */
  readonly now: number;
  readonly fetchedAt: number;
  readonly alertMinutes: number;
  /** Omitted for roles that may watch the board but not move tickets. */
  readonly transitions?: KotTransitions;
}

/**
 * A ticket, as a cook reads it: across a hot room, at a glance, while holding
 * a pan.
 *
 * Quantity is the largest thing on the card because it is the number that gets
 * a dish wrong. There is at most ONE action, and it is named after what the
 * cook just did - "Start preparing", "Mark ready", "Mark served". No dropdown
 * of statuses to choose from: the button IS the state machine, so an illegal
 * move is not something the screen can express.
 */
export function TicketCard({
  ticket,
  now,
  fetchedAt,
  alertMinutes,
  transitions,
}: TicketCardProps): JSX.Element {
  const elapsed = ticketElapsedSeconds(ticket.elapsedSeconds, fetchedAt, now);
  const urgent = isNewTicketOverdue(ticket.status, elapsed, alertMinutes);

  const step = NEXT_STEP[ticket.status];
  const moving = transitions?.isMoving(ticket.id) ?? false;

  return (
    <article
      aria-label={`KOT ${String(ticket.kotNumber)}, ${ticket.tableName ?? 'Takeaway'}, ${ticket.status.toLowerCase()}, ${formatElapsed(elapsed)}${urgent ? ', overdue' : ''}`}
      className={cn(
        'rounded-card border p-4 transition-colors',
        urgent ? 'border-danger/60 bg-danger/8' : 'border-border-2 bg-surface',
        ticket.status === 'SERVED' && 'opacity-70',
      )}
    >
      <header className="border-border/70 mb-3 flex items-start justify-between gap-3 border-b pb-2.5">
        <div className="min-w-0">
          <p className="truncate text-[16px] leading-tight font-extrabold tracking-tight">
            {ticket.tableName ?? 'Takeaway'}
          </p>
          <p className="text-muted-2 font-mono text-[11px] font-semibold">
            KOT #{ticket.kotNumber} · Order #{ticket.orderNumber}
          </p>
        </div>
        <span
          // Colour alone never carries it: an overdue ticket also says so.
          className={cn(
            'shrink-0 rounded-lg px-2 py-1 font-mono text-[13px] font-bold tabular-nums',
            urgent ? 'bg-danger text-white' : 'bg-neutral-tint text-muted',
          )}
          title={
            urgent
              ? `Waiting to start for ${alertMinutes} minutes or more`
              : 'Time since this ticket was sent'
          }
        >
          {formatElapsed(elapsed)}
        </span>
      </header>

      <ul className="flex flex-col gap-2">
        {ticket.items.map((item) => (
          <li key={item.id} className="flex items-start gap-3">
            <span className="bg-neutral-tint grid size-8 shrink-0 place-items-center rounded-lg font-mono text-[15px] font-extrabold tabular-nums">
              {item.quantity}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[14.5px] leading-tight font-bold">{item.name}</p>
              {item.nameNp !== null && (
                <p className="text-muted-2 truncate text-[12px] leading-tight">{item.nameNp}</p>
              )}
              {item.note !== null && (
                <p className="text-warn-fg bg-warn/12 mt-1 inline-block rounded-md px-1.5 py-0.5 text-[12px] font-bold">
                  {item.note}
                </p>
              )}
            </div>
          </li>
        ))}
      </ul>

      {urgent && (
        <p className="text-danger-fg mt-3 text-[11.5px] font-bold">
          Waiting to start for {alertMinutes}+ minutes — check with the kitchen
        </p>
      )}

      {step !== undefined && transitions !== undefined && (
        <Button
          size="lg"
          variant={ticket.status === 'READY' ? 'secondary' : 'primary'}
          className="mt-3 w-full"
          loading={moving}
          // Disabled only for THIS ticket while it moves. Marking #12 ready
          // must not stop anyone starting #13.
          disabled={moving}
          onClick={() => void transitions.move(ticket.id, step.target)}
        >
          {moving ? 'Saving…' : step.label}
        </Button>
      )}

      {ticket.status === 'SERVED' && (
        <p className="text-muted-3 mt-3 text-center text-[11.5px] font-semibold">
          Served{ticket.servedAt === null ? '' : ` at ${formatClock(ticket.servedAt)}`}
        </p>
      )}
    </article>
  );
}

/** mm:ss up to an hour, then h:mm:ss. A ticket past an hour is its own alarm. */
function formatElapsed(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  return hours > 0 ? `${String(hours)}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
