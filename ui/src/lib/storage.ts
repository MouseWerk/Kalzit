/**
 * Small preferences in localStorage. Access can throw (privacy modes, blocked storage, quota), and a
 * preference that cannot be saved must never break the page, so failures fall back silently.
 */

export function readPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writePreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The choice still applies for this page view; it just is not remembered.
  }
}
