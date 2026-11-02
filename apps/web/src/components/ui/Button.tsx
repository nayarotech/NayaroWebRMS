import type { ButtonHTMLAttributes, JSX, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The one button. Variants carry meaning, not decoration:
 *   primary    the single main action on a surface
 *   secondary  every other action
 *   subtle     low-emphasis actions inside cards and toolbars
 *   ghost      icon buttons and quiet navigation
 *   danger     irreversible or money-reversing actions
 */
export type ButtonVariant = 'primary' | 'secondary' | 'subtle' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly loading?: boolean;
  readonly icon?: LucideIcon;
  /** Square button showing only the icon; `aria-label` is then required. */
  readonly iconOnly?: boolean;
  readonly children?: ReactNode;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-white hover:bg-accent-hover shadow-card',
  secondary: 'bg-surface text-text-2 border border-border-2 hover:border-border-4 hover:bg-surface-2',
  subtle: 'bg-accent-soft text-accent-hover hover:bg-accent/15',
  ghost: 'bg-transparent text-muted hover:bg-neutral-tint hover:text-text-2',
  danger: 'bg-surface text-danger border border-danger/30 hover:bg-danger/8',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-caption gap-1.5',
  md: 'h-10 px-4 text-body gap-2',
  lg: 'h-12 px-5 text-[0.9375rem] gap-2',
};

const ICON_ONLY: Record<ButtonSize, string> = {
  sm: 'size-8',
  md: 'size-10',
  lg: 'size-12',
};

const ICON_SIZE: Record<ButtonSize, number> = { sm: 15, md: 17, lg: 18 };

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  icon: Icon,
  iconOnly = false,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-control font-bold whitespace-nowrap',
        'transition-colors outline-none',
        'focus-visible:ring-accent-hover/40 focus-visible:ring-2',
        'disabled:cursor-not-allowed disabled:opacity-55',
        VARIANTS[variant],
        iconOnly ? ICON_ONLY[size] : SIZES[size],
        className,
      )}
    >
      {loading ? (
        <span
          aria-hidden
          className="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
        />
      ) : (
        Icon !== undefined && <Icon aria-hidden size={ICON_SIZE[size]} strokeWidth={2.2} />
      )}
      {!iconOnly && children}
    </button>
  );
}
