import { useState, type InputHTMLAttributes, type JSX } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Field, controlClass } from './Field';

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  /** Password input with a show/hide toggle. */
  readonly secret?: boolean;
}

/** A labelled single-line input, used by sign-in, registration and settings forms. */
export function TextField({
  label,
  hint,
  error,
  secret = false,
  className,
  ...rest
}: TextFieldProps): JSX.Element {
  const [revealed, setRevealed] = useState(false);
  return (
    <Field
      label={label}
      className={cn('mb-4', className)}
      {...(hint === undefined ? {} : { hint })}
      {...(error === undefined ? {} : { error })}
    >
      {({ id, describedBy, invalid }) => (
        <div className="relative">
          <input
            {...rest}
            id={id}
            type={secret && !revealed ? 'password' : (rest.type ?? 'text')}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            className={cn(controlClass, 'h-11', secret && 'pr-11')}
          />
          {secret && (
            <button
              type="button"
              onClick={() => {
                setRevealed((value) => !value);
              }}
              aria-label={revealed ? 'Hide password' : 'Show password'}
              className="text-muted hover:text-text-2 absolute top-1/2 right-2 grid size-8 -translate-y-1/2 place-items-center rounded-md"
            >
              {revealed ? <EyeOff size={17} aria-hidden /> : <Eye size={17} aria-hidden />}
            </button>
          )}
        </div>
      )}
    </Field>
  );
}
