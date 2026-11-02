/**
 * localStorage access that never throws. Private windows and blocked site data
 * make storage unavailable; the app must still work, just without persistence.
 */
export function readStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the session lasts for this page only.
  }
}

export function removeStorage(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing stored, nothing to remove.
  }
}
