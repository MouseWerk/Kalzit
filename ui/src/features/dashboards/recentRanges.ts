import { readPreference, writePreference } from "../../lib/storage";
import { presetOf, type TextRange } from "./timeRange";

/** How many ranges the picker remembers. */
export const RECENT_RANGES = 5;

/** Kept in this browser per account; nothing of it goes to the server. */
function keyOf(userId: string): string {
  return `kalzit.recentRanges.${userId}`;
}

/** The ranges this account applied last in this browser, newest first. */
export function readRecentRanges(userId: string): TextRange[] {
  const raw = readPreference(keyOf(userId));
  if (raw === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter(
        (entry): entry is TextRange =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as { from?: unknown }).from === "string" &&
          typeof (entry as { to?: unknown }).to === "string",
      )
      .map(({ from, to }) => ({ from, to }))
      .slice(0, RECENT_RANGES);
  } catch {
    return [];
  }
}

/**
 * Remembers a range the account applied. Quick ranges are always in the list, so only other
 * ranges are kept; one used again moves to the top.
 */
export function rememberRange(userId: string, range: TextRange): void {
  if (presetOf(range) !== undefined) {
    return;
  }
  const same = (r: TextRange) => r.from === range.from && r.to === range.to;
  const next = [range, ...readRecentRanges(userId).filter((r) => !same(r))].slice(0, RECENT_RANGES);
  writePreference(keyOf(userId), JSON.stringify(next));
}
