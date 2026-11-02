import { useEffect, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { QrCode } from './QrCode';

/**
 * A QR code on a sheet of paper, ready to be cut out and taped to a wall.
 *
 * Rendered through a portal into #print-root, which is hidden on screen and is
 * the only visible element when printing (see the @media print block in
 * globals.css). Mounting it means "print this"; the component fires the print
 * dialog itself and calls back when the dialog closes.
 *
 * Deliberately plain: big code, a caption, and a small line of what it does.
 * Whatever this ends up next to on the wall - a menu board, a till, a door -
 * it should not be competing with it.
 */
export function PrintableQr({
  value,
  caption,
  footnote,
  onDone,
}: {
  value: string;
  caption: string;
  footnote?: string;
  onDone: () => void;
}): JSX.Element | null {
  const target = document.getElementById('print-root');

  useEffect(() => {
    if (target === null) return;

    /*
     * One frame's delay before printing. The QR encoder is asynchronous, and
     * calling print() in the same tick reliably produces a sheet of paper with
     * an empty box where the code should be.
     *
     * requestAnimationFrame twice, not setTimeout: the first fires after React
     * commits, the second after the browser has actually painted the SVG.
     */
    let cancelled = false;
    const outer = requestAnimationFrame(() => {
      const inner = requestAnimationFrame(() => {
        if (cancelled) return;
        window.print();
        // Chromium's print() is synchronous - it returns when the dialog is
        // dismissed, whether the user printed or cancelled. Either way this
        // component's work is finished.
        onDone();
      });
      frames.push(inner);
    });

    const frames: number[] = [outer];
    return () => {
      cancelled = true;
      for (const frame of frames) cancelAnimationFrame(frame);
    };
  }, [target, onDone, value]);

  if (target === null) return null;

  return createPortal(
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '18px',
        padding: '48px 32px',
        fontFamily: 'Manrope, system-ui, sans-serif',
        textAlign: 'center',
      }}
    >
      <QrCode value={value} size={320} label={caption} />
      <p style={{ margin: 0, fontSize: '22px', fontWeight: 800, letterSpacing: '-0.01em' }}>
        {caption}
      </p>
      {footnote !== undefined && footnote.length > 0 && (
        <p style={{ margin: 0, fontSize: '13px', opacity: 0.75, maxWidth: '380px' }}>{footnote}</p>
      )}
    </div>,
    target,
  );
}
