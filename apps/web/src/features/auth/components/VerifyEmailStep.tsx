import { useEffect, useRef, useState, type ClipboardEvent, type JSX, type KeyboardEvent } from 'react';
import { ArrowLeft, MailCheck } from 'lucide-react';
import type { LoginResponse, PendingRegistrationResponse } from '@nayaro/shared';
import { Button } from '@/components/ui/Button';
import { InlineAlert } from '@/components/ui/States';
import { ApiRequestError } from '@/services/apiClient';
import { cn } from '@/lib/utils';
import { resendRegistrationCode, verifyRegistration } from '../api/auth.api';

const LENGTH = 6;

/**
 * Sign-up step 2: the six digits from the email.
 *
 * Six boxes rather than one field, because that is what people expect from a
 * code, but it behaves like one field: typing moves forward, Backspace moves
 * back, and pasting the whole code (or the phone's one-tap autofill, via
 * autocomplete="one-time-code") fills every box and submits.
 */
export function VerifyEmailStep({
  pending,
  onVerified,
  onChangeEmail,
}: {
  readonly pending: PendingRegistrationResponse;
  readonly onVerified: (result: LoginResponse) => void | Promise<void>;
  readonly onChangeEmail: () => void;
}): JSX.Element {
  const [digits, setDigits] = useState<string[]>(() => Array.from({ length: LENGTH }, () => ''));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [resending, setResending] = useState(false);
  const [waitUntil, setWaitUntil] = useState(() => Date.now() + pending.resendAfterSeconds * 1000);
  const [now, setNow] = useState(() => Date.now());
  const boxes = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  const secondsLeft = Math.max(0, Math.ceil((waitUntil - now) / 1000));

  const submit = async (code: string): Promise<void> => {
    if (code.length !== LENGTH || verifying) return;
    setVerifying(true);
    setError(null);
    setNotice(null);
    try {
      await onVerified(await verifyRegistration({ email: pending.email, code }));
    } catch (cause: unknown) {
      setError(cause instanceof ApiRequestError ? cause.message : 'Could not check the code. Try again.');
      setDigits(Array.from({ length: LENGTH }, () => ''));
      boxes.current[0]?.focus();
    } finally {
      setVerifying(false);
    }
  };

  const fill = (start: number, text: string): void => {
    const incoming = text.replace(/\D/g, '').slice(0, LENGTH - start).split('');
    if (incoming.length === 0) return;
    const next = [...digits];
    incoming.forEach((digit, offset) => {
      next[start + offset] = digit;
    });
    setDigits(next);
    setError(null);
    const code = next.join('');
    if (code.length === LENGTH && !next.includes('')) {
      void submit(code);
    } else {
      boxes.current[Math.min(start + incoming.length, LENGTH - 1)]?.focus();
    }
  };

  const onKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Backspace' && digits[index] === '' && index > 0) {
      boxes.current[index - 1]?.focus();
    } else if (event.key === 'ArrowLeft' && index > 0) {
      boxes.current[index - 1]?.focus();
    } else if (event.key === 'ArrowRight' && index < LENGTH - 1) {
      boxes.current[index + 1]?.focus();
    }
  };

  const onPaste = (index: number, event: ClipboardEvent<HTMLInputElement>): void => {
    event.preventDefault();
    fill(index, event.clipboardData.getData('text'));
  };

  const resend = async (): Promise<void> => {
    setResending(true);
    setError(null);
    try {
      const result = await resendRegistrationCode(pending.email);
      setWaitUntil(Date.now() + result.resendAfterSeconds * 1000);
      setDigits(Array.from({ length: LENGTH }, () => ''));
      setNotice('A new code is on its way. The old one no longer works.');
      boxes.current[0]?.focus();
    } catch (cause: unknown) {
      setError(cause instanceof ApiRequestError ? cause.message : 'Could not send a new code. Try again.');
    } finally {
      setResending(false);
    }
  };

  return (
    <div>
      <span className="bg-accent-soft text-accent-hover grid size-12 place-items-center rounded-card">
        <MailCheck size={22} aria-hidden />
      </span>
      <h1 className="text-display mt-5 font-extrabold tracking-tight">Check your email</h1>
      <p className="text-muted mt-1 text-body">
        We sent a 6-digit code to <strong className="text-text">{pending.email}</strong>. Enter it below to
        create your restaurant. It expires in 15 minutes.
      </p>

      <form
        className="mt-7"
        onSubmit={(event) => {
          event.preventDefault();
          void submit(digits.join(''));
        }}
      >
        <fieldset disabled={verifying}>
          <legend className="sr-only">Verification code</legend>
          <div className="flex gap-2 sm:gap-3">
            {digits.map((digit, index) => (
              <input
                key={index}
                ref={(element) => {
                  boxes.current[index] = element;
                }}
                aria-label={`Digit ${String(index + 1)} of ${String(LENGTH)}`}
                inputMode="numeric"
                autoComplete={index === 0 ? 'one-time-code' : 'off'}
                autoFocus={index === 0}
                maxLength={LENGTH}
                value={digit}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === '') {
                    const next = [...digits];
                    next[index] = '';
                    setDigits(next);
                  } else {
                    fill(index, value.slice(-LENGTH));
                  }
                }}
                onKeyDown={(event) => {
                  onKeyDown(index, event);
                }}
                onPaste={(event) => {
                  onPaste(index, event);
                }}
                onFocus={(event) => {
                  event.target.select();
                }}
                className={cn(
                  'bg-field text-text h-14 w-full min-w-0 rounded-control border text-center font-mono text-2xl font-bold outline-none',
                  'focus:border-accent-hover focus:ring-accent-hover/20 transition-colors focus:ring-3',
                  error === null ? 'border-border-3' : 'border-danger',
                )}
              />
            ))}
          </div>
        </fieldset>

        {error !== null && <InlineAlert className="mt-4">{error}</InlineAlert>}
        {notice !== null && error === null && (
          <InlineAlert tone="success" className="mt-4">
            {notice}
          </InlineAlert>
        )}

        <Button
          type="submit"
          size="lg"
          className="mt-6 w-full"
          loading={verifying}
          disabled={digits.includes('')}
        >
          {verifying ? 'Creating your restaurant…' : 'Verify and create restaurant'}
        </Button>
      </form>

      <div className="text-muted mt-6 flex flex-wrap items-center justify-between gap-3 text-body">
        <button
          type="button"
          onClick={onChangeEmail}
          className="hover:text-text-2 inline-flex items-center gap-1.5 font-semibold"
        >
          <ArrowLeft size={15} aria-hidden />
          Use a different email
        </button>
        {secondsLeft > 0 ? (
          <span>Resend code in {secondsLeft}s</span>
        ) : (
          <button
            type="button"
            disabled={resending}
            onClick={() => void resend()}
            className="text-accent-hover font-bold hover:underline disabled:opacity-60"
          >
            {resending ? 'Sending…' : 'Resend code'}
          </button>
        )}
      </div>
      <p className="text-muted-2 mt-4 text-caption">
        Not in your inbox? Check spam or promotions for a message from noreply@nayaro.tech.
      </p>
    </div>
  );
}
