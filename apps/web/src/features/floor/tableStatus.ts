import type { TableStatus } from '@nayaro/shared';

/**
 * The single place a table status becomes something a person can see.
 *
 * One map, used by the badge, the card and the legend, so those three can never
 * disagree about what "READY" looks like or is called.
 *
 * The class names are written out in full rather than composed from a token
 * name. Tailwind generates CSS by scanning source text for literal class
 * strings, so `bg-${status.color}` would compile to nothing at all - a bug that
 * shows up only in the built app. Spelled out, they are also greppable.
 */
export interface TableStatusPresentation {
  readonly label: string;
  /** What a person should do about it. Read out by assistive tech. */
  readonly action: string;
  /** The status dot. */
  readonly dot: string;
  /** Label text colour. */
  readonly text: string;
  /** The card's tinted body: soft fill plus a coloured edge. */
  readonly card: string;
}

export const TABLE_STATUS_PRESENTATION: Readonly<Record<TableStatus, TableStatusPresentation>> = {
  AWAITING_PAYMENT: {
    label: 'Awaiting payment',
    action: 'Bill issued — collect payment',
    dot: 'bg-status-payment',
    text: 'text-status-payment',
    card: 'border-status-payment/45 bg-status-payment/8',
  },
  READY: {
    label: 'Ready',
    action: 'Food is ready — serve it',
    dot: 'bg-status-ready',
    text: 'text-status-ready',
    card: 'border-status-ready/45 bg-status-ready/8',
  },
  PREPARING: {
    label: 'Preparing',
    action: 'With the kitchen',
    dot: 'bg-status-preparing',
    text: 'text-status-preparing',
    card: 'border-status-preparing/45 bg-status-preparing/8',
  },
  OCCUPIED: {
    label: 'Occupied',
    action: 'Seated',
    dot: 'bg-status-occupied',
    text: 'text-status-occupied',
    card: 'border-status-occupied/45 bg-status-occupied/8',
  },
  AVAILABLE: {
    label: 'Available',
    action: 'Free to seat',
    dot: 'bg-status-available',
    text: 'text-status-available',
    card: 'border-border-2 bg-surface',
  },
};

/**
 * Precedence order, most urgent first - the same order the server resolves
 * statuses in. The legend and the summary counts render in this order, so the
 * screen itself teaches the hierarchy.
 */
export const TABLE_STATUS_ORDER: readonly TableStatus[] = [
  'AWAITING_PAYMENT',
  'READY',
  'PREPARING',
  'OCCUPIED',
  'AVAILABLE',
];
