import { LANGUAGES, type Language } from "../i18n/i18n";
import { THEMES, type Theme } from "../theme/theme";
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
  if (raw === null || raw === "") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {};
  }
  // Only values this UI knows; anything else in the storage is ignored.
  const value = parsed as Record<string, unknown>;
  const choice: LocalChoice = {};
  const language = LANGUAGES.find((l) => l === value.language);
  if (language !== undefined) choice.language = language;
  const theme = THEMES.find((t) => t === value.theme);
  if (theme !== undefined) choice.theme = theme;
  if (typeof value.userId === "string") choice.userId = value.userId;
  return choice;
}

/**
 * Records an explicit choice made on a page without an account (sign-in, setup). A choice another
 * account has claimed (its saving failed) is replaced, not added to, so no part of it passes to
 * whoever signs in next.
 */
export function recordChoice(choice: { language?: Language; theme?: Theme }): void {
  const before = read();
  const base = before.userId === undefined ? before : {};
  writePreference(LOCAL_CHOICE_KEY, JSON.stringify({ ...base, ...choice }));
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
