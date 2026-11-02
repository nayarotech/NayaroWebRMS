import type { JSX } from 'react';
import { cn } from '@/lib/utils';
import { useConnectionStatus, type ConnectionState } from '@/hooks/useConnectionStatus';

const TONE: Record<ConnectionState, { dot: string; text: string }> = {
  online: { dot: 'bg-ok', text: 'text-muted' },
  connecting: { dot: 'bg-warn animate-pulse', text: 'text-muted' },
  degraded: { dot: 'bg-warn animate-pulse', text: 'text-warn-fg' },
  offline: { dot: 'bg-danger animate-pulse', text: 'text-danger-fg' },
};

/**
 * Compact connection indicator for the header.
 *
 * Replaces the Phase 1 diagnostic card. Staff need to know whether the till
 * is working, not which Chromium build it runs on - so this shows one dot and
 * one word, and reveals nothing about ports, versions or addresses. When it
 * says "Offline" the till is not going to take an order, which is the only
 * thing the person reading it can act on.
 */
export function ConnectionBadge(): JSX.Element {
  const { state, label } = useConnectionStatus();
  const tone = TONE[state];

  return (
    <div
      className="border-border-2 bg-surface flex items-center gap-2 rounded-xl border px-2.5 py-1.5"
      title={state === 'online' ? 'Connected to the local Nayaro RMS server' : label}
    >
      <span className={cn('size-2 rounded-full', tone.dot)} aria-hidden />
      <span className={cn('text-xs font-semibold', tone.text)}>{label}</span>
    </div>
  );
}
