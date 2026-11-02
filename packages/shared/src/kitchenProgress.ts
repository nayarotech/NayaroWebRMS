import type { KotStatus } from './api';

export const DEFAULT_NEW_TICKET_ALERT_MINUTES = 5;

export function kitchenProgressLabel(status: KotStatus): string {
  switch (status) {
    case 'NEW':
      return 'Sent to kitchen — waiting to start';
    case 'PREPARING':
      return 'Kitchen started preparing';
    case 'READY':
      return 'Ready to serve';
    case 'SERVED':
      return 'Served';
    case 'VOID':
      return 'Cancelled';
  }
}

export function isNewTicketOverdue(
  status: KotStatus,
  elapsedSeconds: number,
  alertMinutes: number,
): boolean {
  return status === 'NEW' && elapsedSeconds >= alertMinutes * 60;
}

/** Use the server age and only measure time since this response arrived locally. */
export function ticketElapsedSeconds(
  serverSeconds: number,
  fetchedAt: number,
  now: number,
): number {
  return Math.max(0, serverSeconds) + Math.max(0, Math.floor((now - fetchedAt) / 1000));
}
