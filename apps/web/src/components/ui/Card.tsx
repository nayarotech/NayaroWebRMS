import type { HTMLAttributes, JSX, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Card({ className, ...rest }: HTMLAttributes<HTMLElement>): JSX.Element {
  return (
    <section
      {...rest}
      className={cn('border-border bg-surface shadow-card rounded-card border', className)}
    />
  );
}

export interface CardHeaderProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
}

export function CardHeader({ title, description, actions, className }: CardHeaderProps): JSX.Element {
  return (
    <header className={cn('flex flex-wrap items-start gap-3 px-5 pt-5 pb-3', className)}>
      <div className="min-w-0 flex-1">
        <h2 className="text-heading font-extrabold tracking-tight">{title}</h2>
        {description !== undefined && (
          <p className="text-muted mt-0.5 text-caption">{description}</p>
        )}
      </div>
      {actions !== undefined && <div className="flex items-center gap-2">{actions}</div>}
    </header>
  );
}

export function CardBody({ className, ...rest }: HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div {...rest} className={cn('px-5 pb-5', className)} />;
}
