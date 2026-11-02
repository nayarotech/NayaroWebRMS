import { useEffect, useRef, useState } from 'react';
import type { KitchenTicket } from '@nayaro/shared';
import { isAlertSoundReady, playNewTicketAlert, unlockAlertSound } from '@/lib/alertSound';

/**
 * Tells the counter when food is ready to go out.
 *
 * The till's alarm, and deliberately a different event from the kitchen's. A
 * cashier does not need to hear that an order was placed - they usually placed
 * it - but "table 6 is plated and sitting under the lamp" is the thing that
 * goes unnoticed and gets food sent out cold.
 *
 * Tracked by TICKET ID rather than by a count of READY tickets, for the same
 * reason as the kitchen's: one ticket being served while another is plated
 * leaves the count unchanged at exactly the moment somebody needs telling.
 */
export interface ReadyAlertState {
  readonly soundReady: boolean;
  readonly enableSound: () => void;
}

export function useReadyAlert(
  tickets: readonly KitchenTicket[],
  enabled: boolean,
): ReadyAlertState {
  /** `null` until the board has been seen once, which keeps the first load silent. */
  const announced = useRef<Set<string> | null>(null);
  const [soundReady, setSoundReady] = useState(() => isAlertSoundReady());

  useEffect(() => {
    if (!enabled) return;

    const ready = tickets.filter((ticket) => ticket.status === 'READY');

    if (announced.current === null) {
      announced.current = new Set(ready.map((ticket) => ticket.id));
      return;
    }

    const known = announced.current;
    const fresh = ready.filter((ticket) => !known.has(ticket.id));
    for (const ticket of ready) known.add(ticket.id);

    // Forget anything that has left READY, so the set cannot grow all evening.
    // A ticket cannot return to READY once served, so this can never repeat.
    const stillReady = new Set(ready.map((ticket) => ticket.id));
    for (const id of known) if (!stillReady.has(id)) known.delete(id);

    if (fresh.length > 0) playNewTicketAlert();
  }, [tickets, enabled]);

  useEffect(() => {
    if (!enabled || soundReady) return;
    const timer = setInterval(() => {
      if (isAlertSoundReady()) setSoundReady(true);
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [enabled, soundReady]);

  return {
    soundReady,
    enableSound: () => {
      unlockAlertSound();
      // Proves the speaker rather than leaving it to be discovered at service.
      playNewTicketAlert(2);
      setSoundReady(isAlertSoundReady());
    },
  };
}
