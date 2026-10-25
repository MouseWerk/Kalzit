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

/** Prefixes of preferences earlier versions stored and nothing reads any more. */
const RETIRED_PREFIXES = [
  // Whether the dashboard rail was folded away; the rail no longer folds.
  "kalzit.dashboardRail.",
];

/** Removes retired preferences once at app start, so they do not linger in the browser. */
export function removeRetiredPreferences(): void {
  try {
    const storage = window.localStorage;
    const retired: string[] = [];
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key !== null && RETIRED_PREFIXES.some((prefix) => key.startsWith(prefix))) {
        retired.push(key);
      }
    }
    for (const key of retired) {
      storage.removeItem(key);
    }
  } catch {
    // Blocked storage holds nothing to clean up that matters.
  }
}
