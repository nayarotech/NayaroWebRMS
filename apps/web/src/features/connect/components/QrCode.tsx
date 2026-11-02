import { useEffect, useState, type JSX } from 'react';
import QRCode from 'qrcode';
import { cn } from '@/lib/utils';

/**
 * Draws a QR code, offline, from a string.
 *
 * Rendered locally rather than through one of the QR image services, and that
 * is a deliberate refusal rather than an oversight. Those services take the
 * payload as a URL parameter, which would mean sending a restaurant's wifi
 * password to a third party to have a picture drawn of it - and the machine
 * this runs on is frequently not on the internet at all.
 *
 * SVG rather than a canvas: it prints at whatever resolution the printer has,
 * which matters because most of these end up taped to a wall, and it scales
 * without the blur a bitmap gets when somebody enlarges it.
 */
export function QrCode({
  value,
  size = 200,
  className,
  label,
}: {
  value: string;
  size?: number;
  className?: string;
  /** Read out instead of the payload, which is rarely meaningful spoken aloud. */
  label: string;
}): JSX.Element {
  /**
   * The encoder's output, TAGGED WITH THE INPUT IT CAME FROM.
   *
   * Carrying `source` is what makes the async safe. Encoding is a promise, so
   * while one is in flight the caller can change `value` - every keystroke in
   * the QR studio does exactly that. Without the tag, the component would
   * render the previous string's code until the new one resolved, which on a
   * wifi code means briefly showing a QR for a half-typed password.
   *
   * It also means the effect never has to clear state on the way in, which is
   * what kept this honest: state is written only when an encode finishes.
   */
  const [result, setResult] = useState<{
    readonly source: string;
    readonly svg: string | null;
  } | null>(null);

  useEffect(() => {
    // Nothing to encode. Deliberately no setState here - the render below
    // already treats "no result for this value" as the placeholder case.
    if (value.length === 0) return;

    let current = true;

    QRCode.toString(value, {
      type: 'svg',
      /*
       * Error correction level M: recovers from about 15% of the code being
       * damaged. These get taped to walls near kitchens and get greasy, wet
       * and torn at the corner. L would make a slightly smaller code and lose
       * the first time somebody splashed it.
       */
      errorCorrectionLevel: 'M',
      margin: 1,
      width: size,
      // Pure black on pure white. Brand colours here would look better and
      // scan worse, and a code that needs three attempts is not worth it.
      color: { dark: '#000000', light: '#FFFFFF' },
    })
      .then((svg) => {
        if (current) setResult({ source: value, svg });
      })
      .catch(() => {
        // The realistic cause is a payload too long to encode at this size.
        if (current) setResult({ source: value, svg: null });
      });

    return () => {
      current = false;
    };
  }, [value, size]);

  // Only a result produced for the string being rendered right now counts.
  const settled = result !== null && result.source === value ? result : null;

  if (settled === null) {
    return (
      <div
        style={{ width: size, height: size }}
        className={cn('border-border-3 rounded-xl border border-dashed', className)}
      />
    );
  }

  if (settled.svg === null) {
    return (
      <div
        style={{ width: size, height: size }}
        className={cn(
          'border-border-3 text-muted-2 flex items-center justify-center rounded-xl border border-dashed p-4 text-center text-[11.5px] font-semibold',
          className,
        )}
      >
        That is too long to fit in a QR code. Try shortening it.
      </div>
    );
  }

  return (
    // An <img> rather than inline markup: an SVG loaded as an image can never
    // run script, whatever ends up encoded in it.
    <img
      alt={label}
      width={size}
      height={size}
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(settled.svg)}`}
      className={cn('rounded-xl bg-white p-2', className)}
    />
  );
}
