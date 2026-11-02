import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type JSX,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '@/lib/utils';

/** Shared control styling: every input, select and textarea looks the same. */
export const controlClass = cn(
  'bg-field text-text border-border-3 w-full rounded-control border px-3 text-body outline-none',
  'transition-colors placeholder:text-placeholder',
  'focus:border-accent-hover focus:ring-3 focus:ring-accent-hover/20',
  'disabled:bg-surface-3 disabled:text-muted disabled:cursor-not-allowed',
  'aria-[invalid=true]:border-danger',
);

export interface FieldProps {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly error?: string;
  readonly className?: string;
  readonly children: (props: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}

/** Label, control, then hint or error - in that order, everywhere. */
export function Field({ label, hint, error, className, children }: FieldProps): JSX.Element {
  const id = useId();
  const describedBy = error !== undefined || hint !== undefined ? `${id}-desc` : undefined;
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-text-3 text-caption font-bold">
        {label}
      </label>
      {children({ id, describedBy, invalid: error !== undefined })}
      {(error ?? hint) !== undefined && (
        <p id={describedBy} className={cn('text-caption', error === undefined ? 'text-muted-2' : 'text-danger')}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className, ...rest }, ref) {
    return <input ref={ref} {...rest} className={cn(controlClass, 'h-10', className)} />;
  },
);

export function Select({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>): JSX.Element {
  return <select {...rest} className={cn(controlClass, 'h-10 pr-8', className)} />;
}

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>): JSX.Element {
  return <textarea {...rest} className={cn(controlClass, 'min-h-20 py-2', className)} />;
}
