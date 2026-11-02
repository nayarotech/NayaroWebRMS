import { useCallback, useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'nayaro.theme';

function readStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === 'dark' || stored === 'light' ? stored : 'light';
  } catch {
    return 'light';
  }
}

/**
 * Light/dark preference.
 *
 * localStorage is right here and wrong for the session token. A theme has no
 * security value, and the Phase 3 settings split put screen-only preferences
 * on the device rather than in the restaurant's database - two terminals may
 * legitimately differ, and neither choice changes a printed bill.
 */
export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      // Private mode or blocked storage: the theme still applies this session.
    }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  return { theme, toggleTheme };
}

/** Applies the saved theme before the first render, so pages never flash the wrong one. */
export function applyStoredTheme(): void {
  document.documentElement.setAttribute('data-theme', readStoredTheme());
}
