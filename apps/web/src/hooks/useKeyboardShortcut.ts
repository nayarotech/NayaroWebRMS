import { useEffect } from 'react';

export interface ShortcutOptions {
  readonly ctrl?: boolean;
  readonly shift?: boolean;
  readonly alt?: boolean;
  /** Set false to suspend the binding without unmounting the component. */
  readonly enabled?: boolean;
}

/**
 * Window-level keyboard shortcut.
 *
 * Established now because Nayaro RMS is meant to be driven from the keyboard
 * during service - F2 new order, F4 search, F6 send KOT, F8 billing. Those are
 * deliberately NOT bound yet: a shortcut wired to a feature that does not exist
 * silently does nothing, which is worse than having no shortcut at all. They
 * arrive with the screens they belong to.
 *
 * Keystrokes are ignored while the user is typing, unless the binding uses a
 * function key - no text field consumes those.
 */
export function useKeyboardShortcut(
  key: string,
  handler: () => void,
  options: ShortcutOptions = {},
): void {
  const { ctrl = false, shift = false, alt = false, enabled = true } = options;

  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== key.toLowerCase()) return;
      if (event.ctrlKey !== ctrl || event.shiftKey !== shift || event.altKey !== alt) return;

      const target = event.target;
      const isTyping =
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLElement && target.isContentEditable);
      if (isTyping && !/^F\d/i.test(key)) return;

      event.preventDefault();
      handler();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [key, handler, ctrl, shift, alt, enabled]);
}
