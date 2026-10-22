import type { Language } from "../i18n/i18n";
import type { Theme } from "../theme/theme";
import { readPreference, writePreference } from "./storage";

/**
 * Language and theme someone chose explicitly in this browser while no account's preferences
 * applied: on the sign-in and setup pages. Kept apart from the values the UI applies (which also
 * come from an account's preferences or the server's default), so signing in adopts only a real
 * choice, never what the previous user of a shared browser had. Tagged with the account it
 * belongs to (none on the sign-in page) and cleared on sign-out.
 */
export interface LocalChoice {
  language?: Language;
  theme?: Theme;
  /** The account that made the choice; absent when it was made before signing in. */
  userId?: string;
}

export const LOCAL_CHOICE_KEY = "kalzit.choice";

function read(): LocalChoice {
  const raw = readPreference(LOCAL_CHOICE_KEY);
  if (raw === null) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as LocalChoice) : {};
  } catch {
    return {};
  }
}

/** Records an explicit choice made on a page without an account (sign-in, setup). */
export function recordChoice(choice: { language?: Language; theme?: Theme }): void {
  const { userId: _, ...before } = read();
  writePreference(LOCAL_CHOICE_KEY, JSON.stringify({ ...before, ...choice }));
}

/** The explicit choice that belongs to `userId`: made by them, or before anyone signed in. */
export function choiceFor(userId: string): LocalChoice {
  const choice = read();
  return choice.userId === undefined || choice.userId === userId ? choice : {};
}

/** Marks the choice as this account's, so no other account adopts it. */
export function claimChoice(userId: string): void {
  const choice = read();
  if (choice.language !== undefined || choice.theme !== undefined) {
    writePreference(LOCAL_CHOICE_KEY, JSON.stringify({ ...choice, userId }));
  }
}

/** Forgets the choice: once it is the account's preference, and on sign-out. */
export function clearChoice(): void {
  writePreference(LOCAL_CHOICE_KEY, "");
}
