import { useEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { BILL_PAPER_SPECS, type BillPaperSize, type InvoiceDto } from '@nayaro/shared';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/utils';
import { ApiRequestError, apiClient } from '@/services/apiClient';
import { ReceiptDocument } from './ReceiptDocument';
import { paperSpec, readPaperPreference, writePaperPreference } from './paperPreference';
import type { RecordInvoicePrintResponse } from '@nayaro/shared';

/**
 * Choose the paper, see the bill, print it.
 *
 * The preview is the same component that goes to the printer, at the same
 * width, which is the only way a preview is worth anything. A cashier who has
 * loaded a 58mm roll sees a 58mm bill and finds out here - not from a customer
 * holding a receipt with the totals cut off.
 *
 * THE ORDER OF OPERATIONS MATTERS. The copy number is allocated by the server
 * BEFORE the paper moves, because the document has to carry it. That means a
 * failed print still consumed a copy number, and it should: the row records
 * that somebody tried, which is the honest account of an empty roll. The
 * alternative - print first, record after - loses the record exactly when the
 * printer is misbehaving and the record matters most.
 */
export function PrintBillDialog({
  invoice,
  footerText,
  onClose,
}: {
  invoice: InvoiceDto;
  footerText: string | null;
  onClose: () => void;
}): JSX.Element {
  const [size, setSize] = useState<BillPaperSize>(readPaperPreference);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  /** Set once the server has allocated a copy number; triggers the print. */
  const [printing, setPrinting] = useState<{ copySequence: number } | null>(null);

  const spec = paperSpec(size);
  const unpaid = invoice.settlement.remainingPaisa > 0;

  const printTarget = document.getElementById('print-root');

  /*
   * `@page` cannot be set from a style attribute - it is not a property of any
   * element - so the page box is driven by a real stylesheet swapped in for
   * the chosen paper. Removed on unmount so the QR studio's own printing is
   * not left with a bill-shaped page.
   */
  useEffect(() => {
    const style = document.createElement('style');
    style.setAttribute('data-nayaro-print', 'bill');
    style.textContent = `@page { size: ${spec.pageSize}; margin: ${
      spec.continuous ? '0' : '12mm'
    }; }`;
    document.head.append(style);
    return () => {
      style.remove();
    };
  }, [spec.pageSize, spec.continuous]);

  /*
   * Print once the document carrying the allocated copy number has painted.
   * Two frames, for the same reason as the QR printout: the first fires after
   * React commits, the second after the browser has actually drawn it, and
   * printing before that produces a blank sheet.
   */
  /*
   * The latest `onClose`, held in a ref so the print effect does not depend on
   * it. The caller passes an inline arrow, so its identity changes on every
   * render - and an effect that re-ran on that would fire `window.print()` a
   * second time, which is a real duplicate receipt rather than a stale render.
   *
   * Updated in its own effect rather than during render: a ref written while
   * rendering is not a rule React guarantees anything about. Effects run in
   * declaration order, so this one lands before the print effect below reads
   * it on the same commit.
   */
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (printing === null) return;
    let cancelled = false;
    const frames: number[] = [];

    frames.push(
      requestAnimationFrame(() => {
        frames.push(
          requestAnimationFrame(() => {
            if (cancelled) return;
            window.print();
            // Chromium's print() returns when the dialog closes, whether the
            // user printed or cancelled. Either way this dialog is done.
            setPrinting(null);
            closeRef.current();
          }),
        );
      }),
    );

    return () => {
      cancelled = true;
      for (const frame of frames) cancelAnimationFrame(frame);
    };
  }, [printing]);

  const run = (): void => {
    setWorking(true);
    setError(null);
    writePaperPreference(size);

    apiClient
      .post<RecordInvoicePrintResponse>(`/invoices/${invoice.id}/prints`)
      .then((result) => {
        setPrinting({ copySequence: result.print.copySequence });
      })
      .catch((cause: unknown) => {
        setError(
          cause instanceof ApiRequestError && cause.kind === 'http'
            ? cause.message
            : 'Could not record this print. Check your connection and try again.',
        );
      })
      .finally(() => {
        setWorking(false);
      });
  };

  // The next print's copy number, for the button's own words.
  const nextCopy = invoice.printCount + 1;

  return (
    <>
      <div
        className="bg-overlay fixed inset-0 z-50 flex items-center justify-center p-8"
        role="dialog"
        aria-modal="true"
        aria-label="Print bill"
        onClick={onClose}
      >
        <div
          className="border-border-2 bg-surface flex max-h-full w-full max-w-[860px] gap-6 overflow-hidden rounded-card border p-6"
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          <div className="flex w-[300px] shrink-0 flex-col">
            <h2 className="text-[18px] font-extrabold tracking-tight">Print bill</h2>
            <p className="text-muted mt-0.5 mb-4 text-[12.5px] leading-relaxed">
              Invoice #{invoice.invoiceNumber} · {invoice.fiscalYearLabel}
            </p>

            <p className="text-muted mb-2 font-mono text-[10.5px] font-bold tracking-widest uppercase">
              Paper
            </p>
            <div className="flex flex-col gap-1.5">
              {BILL_PAPER_SPECS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  onClick={() => {
                    setSize(option.id);
                  }}
                  className={cn(
                    'rounded-xl border px-3.5 py-2.5 text-left',
                    option.id === size
                      ? 'border-accent bg-accent/8'
                      : 'border-border-3 hover:border-border-4',
                  )}
                >
                  <span className="block text-[13.5px] font-bold">{option.label}</span>
                  <span className="text-muted-2 block text-[11px] leading-snug">{option.hint}</span>
                </button>
              ))}
            </div>

            {invoice.printCount > 0 && (
              <p className="border-warn/40 bg-warn/8 text-warn mt-4 rounded-lg border px-3 py-2 text-[11.5px] font-semibold">
                Printed {invoice.printCount} {invoice.printCount === 1 ? 'time' : 'times'} already.
                This one prints as &ldquo;copy #{nextCopy}&rdquo;.
              </p>
            )}

            {unpaid && (
              <p className="text-muted-2 mt-3 text-[11px] leading-relaxed">
                Not settled yet, so the bill prints with the amount still due on it.
              </p>
            )}

            {error !== null && (
              <p
                role="alert"
                className="border-danger/40 bg-danger/8 text-danger-fg mt-3 rounded-lg border px-3 py-2 text-[12px] font-semibold"
              >
                {error}
              </p>
            )}

            <div className="mt-auto flex gap-2 pt-5">
              <Button variant="secondary" onClick={onClose} className="flex-1">
                Cancel
              </Button>
              <Button onClick={run} disabled={working || printing !== null} className="flex-1">
                {working ? 'Preparing…' : 'Print'}
              </Button>
            </div>
          </div>

          {/*
            A real preview at the real width, on a white card - thermal paper
            is white regardless of the app's theme, and previewing a receipt on
            a dark surface tells the cashier nothing about what will come out.
          */}
          <div className="border-border-2 bg-neutral-tint min-w-0 flex-1 overflow-auto rounded-xl border p-5">
            <div className="mx-auto w-fit bg-white p-4 shadow-sm">
              <ReceiptDocument
                invoice={invoice}
                paper={spec}
                copySequence={nextCopy}
                unpaid={unpaid}
                footerText={footerText}
              />
            </div>
          </div>
        </div>
      </div>

      {/*
        The document that actually prints, portalled into #print-root - hidden
        on screen, and the only thing visible on paper. Mounted only once the
        server has given us the copy number to put on it.
      */}
      {printing !== null &&
        printTarget !== null &&
        createPortal(
          <ReceiptDocument
            invoice={invoice}
            paper={spec}
            copySequence={printing.copySequence}
            unpaid={unpaid}
            footerText={footerText}
          />,
          printTarget,
        )}
    </>
  );
}
