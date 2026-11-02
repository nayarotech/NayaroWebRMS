import type { JSX, ReactNode } from 'react';
import { Link } from 'react-router';
import { ChevronLeft } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * The content grid every authenticated screen sits in.
 *
 * One width, one set of gutters, one vertical rhythm. Screens never set their
 * own max-width or outer padding; that is how every page lines up with the
 * header and with every other page.
 */
export function Page({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}): JSX.Element {
  return (
    <div className={cn('mx-auto w-full max-w-page px-4 py-5 sm:px-6 lg:px-8 lg:py-7', className)}>
      {children}
    </div>
  );
}

export interface PageHeaderProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** Primary and secondary actions, right-aligned on wide screens. */
  readonly actions?: ReactNode;
  /** A link back to the parent screen, for detail pages. */
  readonly back?: { readonly to: string; readonly label: string };
  readonly children?: ReactNode;
}

export function PageHeader({ title, description, actions, back, children }: PageHeaderProps): JSX.Element {
  return (
    <header className="mb-6">
      {back !== undefined && (
        <Link
          to={back.to}
          className="text-muted hover:text-text-2 mb-2 inline-flex items-center gap-1 text-caption font-bold"
        >
          <ChevronLeft size={15} aria-hidden />
          {back.label}
        </Link>
      )}
      <div className="flex flex-col gap-x-6 gap-y-3 sm:flex-row sm:flex-wrap sm:items-end">
        <div className="min-w-0 flex-1">
          <h1 className="text-title font-extrabold tracking-tight sm:text-display">{title}</h1>
          {description !== undefined && <p className="text-muted mt-1 text-body">{description}</p>}
        </div>
        {actions !== undefined && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children !== undefined && <div className="mt-5">{children}</div>}
    </header>
  );
}

/** Vertical stack of page sections with the standard gap. */
export function PageBody({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}): JSX.Element {
  return <div className={cn('flex flex-col gap-5', className)}>{children}</div>;
}
