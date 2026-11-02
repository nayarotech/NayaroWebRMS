import { useState, type JSX, type ReactNode } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';

export interface CorrectionDialogProps {
  readonly open: boolean;
  readonly title: string;
  /**
   * What will happen if they go through with it, in a sentence, in the words
   * of the restaurant rather than the database. "Its quantities will become
   * available to send again", not "sets Kot.status = VOID".
   */
  readonly consequence: string;
  readonly confirmLabel: string;
  readonly busy: boolean;
  /** The server's refusal, when the last attempt was refused. */
  readonly error: string | null;
  /** Optional extra control, e.g. how many to cancel. */
  readonly children?: ReactNode;
  readonly onConfirm: (reason: string) => void;
  readonly onClose: () => void;
}

/**
 * The one dialog every correction goes through.
 *
 * WHY NOT `window.confirm`. A native confirm cannot state a consequence in the
 * product's own voice, cannot collect the reason, cannot show the server's
 * refusal, and looks like a browser error - which teaches people to dismiss it
 * without reading. Every correction here is irreversible and shows up in the
 * restaurant's history forever, so the moment before it deserves better than
 * an OS beep.
 *
 * THE REASON IS THE POINT. Confirm stays disabled until something is typed,
 * because a correction with no explanation is indistinguishable from a mistake
 * to whoever reads it months later - which is exactly when someone asks.
 */
export function CorrectionDialog({
  open,
  title,
  consequence,
  confirmLabel,
  busy,
  error,
  children,
  onConfirm,
  onClose,
}: CorrectionDialogProps): JSX.Element {
  const [reason, setReason] = useState('');
  const [wasOpen, setWasOpen] = useState(open);

  // A reason belongs to one correction. Carrying "wrong table" over into the
  // next dialog would put someone else's words on this record.
  //
  // Adjusted during render rather than in an effect - React's own answer for
  // "reset state when a prop changes". An effect would render once with the
  // previous reason still in the box before clearing it.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setReason('');
  }

  const ready = reason.trim().length >= 3 && !busy;

  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      className="w-[min(520px,92vw)]"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Keep it
          </Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={!ready}
            onClick={() => {
              onConfirm(reason.trim());
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p className="text-[13.5px] leading-relaxed font-semibold">{consequence}</p>

      {children}

      <label className="mt-4 block">
        <span className="text-muted mb-1.5 block text-[12.5px] font-semibold">Reason</span>
        <textarea
          aria-label="Reason"
          rows={2}
          value={reason}
          autoFocus
          onChange={(event) => {
            setReason(event.target.value);
          }}
          placeholder="Why is this being corrected?"
          className="bg-field text-text border-border-2 focus:ring-accent-hover/25 focus:border-accent-hover w-full resize-none rounded-xl border px-3.5 py-2.5 text-[14px] outline-none focus:ring-3"
        />
        <span className="text-muted-2 mt-1 block text-[11.5px]">
          Kept with this record permanently, along with your name and the time.
        </span>
      </label>

      {error !== null && (
        <p
          role="alert"
          className="border-danger/40 bg-danger/10 text-danger-fg mt-3 rounded-xl border px-3.5 py-2.5 text-[12.5px] font-semibold"
        >
          {error}
        </p>
      )}
    </Modal>
  );
}
