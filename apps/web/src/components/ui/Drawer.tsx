import { useEffect, useRef, type JSX, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './Button';

/** A side sheet for detail views and longer forms, built on the native dialog. */
export function Drawer({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  className,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly description?: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly className?: string;
}): JSX.Element {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      aria-label={title}
      className={cn(
        'bg-surface text-text border-border m-0 ml-auto h-dvh max-h-dvh w-[min(560px,100vw)] max-w-none border-l p-0',
        'shadow-overlay animate-slide-in backdrop:bg-[var(--ny-overlay)]',
        className,
      )}
    >
      <div className="flex h-full flex-col">
        <div className="border-border flex items-start gap-4 border-b px-6 py-5">
          <div className="min-w-0 flex-1">
            <h2 className="text-heading font-extrabold tracking-tight">{title}</h2>
            {description !== undefined && <p className="text-muted mt-0.5 text-caption">{description}</p>}
          </div>
          <Button variant="ghost" iconOnly icon={X} aria-label="Close" onClick={onClose} />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
        {footer !== undefined && (
          <div className="border-border bg-surface-2 flex items-center justify-end gap-2.5 border-t px-6 py-4">
            {footer}
          </div>
        )}
      </div>
    </dialog>
  );
}
