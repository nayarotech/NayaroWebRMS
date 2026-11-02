import { useEffect, useRef, type JSX, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from './Button';

export interface ModalProps {
  readonly open: boolean;
  readonly title: string;
  readonly description?: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly footer?: ReactNode;
  readonly className?: string;
}

/**
 * A modal built on the native `<dialog>` element.
 *
 * `showModal()` gives us the things hand-rolled overlays get wrong: the rest of
 * the page becomes inert, focus is trapped and restored on close, Escape works,
 * and it renders in the top layer so no z-index can cover it. A div-based
 * dialog would be more code and less correct.
 *
 * The one thing to get right is that `<dialog>` has its own idea of open-ness,
 * so React state is pushed into it rather than the element being rendered
 * conditionally - otherwise the two disagree and it closes without telling us.
 */
export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  className,
}: ModalProps): JSX.Element {
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
      // Fires for Escape and for form[method=dialog] alike, so the parent's
      // state follows the element however it was dismissed.
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      aria-label={title}
      className={cn(
        'bg-surface text-text border-border m-auto w-[min(920px,94vw)] rounded-panel border p-0',
        'shadow-overlay animate-rise backdrop:bg-[var(--ny-overlay)]',
        className,
      )}
    >
      <div className="border-border flex items-start gap-4 border-b px-6 py-5">
        <div className="min-w-0">
          <h2 className="text-heading font-extrabold tracking-tight">{title}</h2>
          {description !== undefined && <p className="text-muted mt-0.5 text-caption">{description}</p>}
        </div>
        <Button variant="ghost" iconOnly icon={X} aria-label="Close" onClick={onClose} className="ml-auto" />
      </div>

      <div className="max-h-[68vh] overflow-y-auto px-6 py-5">{children}</div>

      {footer !== undefined && (
        <div className="border-border bg-surface-2 flex flex-wrap items-center justify-end gap-2.5 rounded-b-panel border-t px-6 py-4">
          {footer}
        </div>
      )}
    </dialog>
  );
}
