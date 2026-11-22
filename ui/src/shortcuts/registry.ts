import { getLanguage, type Language, type MessageKey, translate } from "../i18n/i18n";
import { BUILTIN_AREAS, BUILTIN_SHORTCUTS } from "./builtins";
import {
  ariaKeyshortcuts,
  type Binding,
  type Joiners,
  matchesBindings,
  type Platform,
  spokenBinding,
  writtenBindings,
} from "./keyNames";
import { isMac } from "./platform";

/**
 * The shortcut registry: every shortcut of the app is defined here once, with its area, its keys
 * and its text. The help, the settings page, tooltips, menus, the palette and
 * `aria-keyshortcuts` read the same definition, so the list never drifts from the code.
 *
 * A feature defines its shortcuts with `defineShortcut` (the built-in ones are in
 * `builtins.ts`) and matches key presses with `matchesShortcut`; the interface shows them with
 * `<Keys id="..."/>` or `shortcutProps(id)`. A feature that brings its own keys later (the graph
 * canvas, app plugins) registers them the same way, in an area of its own or an existing one.
 */

export interface AreaDef {
  id: string;
  title: MessageKey;
  /** A quiet word after the title: where the keys work ("focus on the chart"). */
  detail?: MessageKey | undefined;
  /** The keys are pressed one after the other; the help says so at the title. */
  sequence?: boolean | undefined;
  /**
   * Where the area counts as "here" for the help: `focus` while the focus was inside a match,
   * `page` while the page shows one. Neither: never first (menus, the palette, everywhere).
   */
  focus?: string | undefined;
  page?: string | undefined;
}

interface ShortcutBase {
  id: string;
  area: string;
  /** The keys; alternatives are separate bindings, the platform's own first. */
  keys: readonly Binding[] | ((platform: Platform) => readonly Binding[]);
  /** A quiet note at the row: a condition ("in wide windows") or what else it does. */
  note?: MessageKey | undefined;
  /**
   * Where inside the area the keys work, when two rows of one area share keys (Ctrl+Enter in the
   * query editor and in the AI field). Rows with different contexts do not collide.
   */
  context?: string | undefined;
  /** A shortcut of "Everywhere" this one takes over on its page ("/" in a list's search). */
  overrides?: string | undefined;
}

/**
 * A shortcut is a row of the help with its text, or one key of such a row (`partOf`): a menu
 * entry that names only its own key ("Move up", Alt+Up) where the help explains Alt+Up and Down
 * in one row.
 */
export type ShortcutDef =
  | (ShortcutBase & { label: MessageKey; partOf?: undefined })
  | (ShortcutBase & { partOf: string; label?: undefined; note?: undefined });

/** A row of the help. */
export type ListedShortcut = Extract<ShortcutDef, { label: MessageKey }>;

const areas = new Map<string, AreaDef>(BUILTIN_AREAS.map((area) => [area.id, area]));
const shortcuts = new Map<string, ShortcutDef>(BUILTIN_SHORTCUTS.map((s) => [s.id, s]));

export function defineArea(area: AreaDef): void {
  if (areas.has(area.id)) {
    throw new Error(`Shortcut area defined twice: ${area.id}`);
  }
  areas.set(area.id, area);
}

export function defineShortcut(shortcut: ShortcutDef): void {
  if (shortcuts.has(shortcut.id)) {
    throw new Error(`Shortcut defined twice: ${shortcut.id}`);
  }
  shortcuts.set(shortcut.id, shortcut);
}

/** Every area, in the order they were defined (the help's fixed order). */
export function allAreas(): readonly AreaDef[] {
  return [...areas.values()];
}

/** Every shortcut, in the order they were defined. */
export function allShortcuts(): readonly ShortcutDef[] {
  return [...shortcuts.values()];
}

/** The help's rows of an area (the keys `partOf` a row are shown with it). */
export function shortcutsOf(areaId: string): readonly ListedShortcut[] {
  return allShortcuts().filter(
    (shortcut): shortcut is ListedShortcut =>
      shortcut.area === areaId && shortcut.partOf === undefined,
  );
}

export function getShortcut(id: string): ShortcutDef {
  const shortcut = shortcuts.get(id);
  if (shortcut === undefined) {
    throw new Error(`Unknown shortcut: ${id}`);
  }
  return shortcut;
}

export function currentPlatform(): Platform {
  return isMac() ? "mac" : "other";
}

/** A shortcut's keys on a platform (the current one by default). */
export function bindingsOf(id: string, platform: Platform = currentPlatform()): readonly Binding[] {
  const keys = getShortcut(id).keys;
  return typeof keys === "function" ? keys(platform) : keys;
}

/** The modifier-free press state the matcher reads; a keyboard event of React or the DOM. */
interface KeyPress {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
  keyCode?: number;
}

/**
 * Whether a key press is the shortcut: exactly its modifiers (Cmd for Mod on a Mac, Ctrl
 * elsewhere) and its key. Never while an input method composes. Sequences are matched by their
 * own listener (the time range keys).
 */
export function matchesShortcut(
  id: string,
  event: KeyPress,
  platform: Platform = currentPlatform(),
): boolean {
  // The combination matcher refuses presses that belong to a composition (isComposingKey).
  return matchesBindings(event, bindingsOf(id, platform), platform);
}

function joiners(language: Language): Joiners {
  return {
    plus: translate(language, "shortcuts.plus"),
    after: translate(language, "shortcuts.then"),
    or: translate(language, "shortcuts.or"),
  };
}

/** The keys as plain text in the current language: "Strg+K oder /", "⇧⌘S", "T dann Z". */
export function shortcutText(id: string, language: Language = getLanguage()): string {
  return writtenBindings(bindingsOf(id), language, currentPlatform(), joiners(language));
}

/** The keys written out for a screen reader: "Steuerung plus K, oder Schrägstrich". */
export function shortcutSpoken(id: string, language: Language = getLanguage()): string {
  const words = joiners(language);
  return bindingsOf(id)
    .map((binding) => spokenBinding(binding, language, currentPlatform(), words))
    .join(`, ${words.or} `);
}

/** `aria-keyshortcuts` for the shortcut's combinations; sequences are left out (see keys.ts). */
export function shortcutAria(id: string): string | undefined {
  return ariaKeyshortcuts(bindingsOf(id), currentPlatform());
}

/** Whether the shortcut is only keys pressed one after the other. */
export function isSequenceShortcut(id: string): boolean {
  return bindingsOf(id).every((binding) => binding.kind === "sequence");
}

/**
 * The accessible name of a control with a shortcut: its name, and for a sequence the keys
 * written out ("Zeitraum zurück, T, dann Pfeil links"), since `aria-keyshortcuts` cannot hold a
 * sequence.
 */
export function nameWithShortcut(name: string, id: string, language: Language = getLanguage()) {
  return isSequenceShortcut(id) ? `${name}, ${shortcutSpoken(id, language)}` : name;
}

/** The props a control that runs a shortcut carries: `aria-keyshortcuts` where it can hold it. */
export function shortcutProps(id: string): { "aria-keyshortcuts"?: string } {
  const aria = shortcutAria(id);
  return aria === undefined ? {} : { "aria-keyshortcuts": aria };
}

/**
 * The areas that count as "here" for an element that had the focus: the ones whose `focus`
 * holds it first (the innermost before the outer ones), then those the page shows.
 */
export function areasHere(focused: Element | null, root: ParentNode = document): string[] {
  const here: string[] = [];
  const byFocus = allAreas()
    .filter((area) => area.focus !== undefined && focused?.closest(area.focus) != null)
    .map((area) => ({ area, depth: depthOf(focused?.closest(area.focus ?? "") ?? null) }))
    .sort((a, b) => b.depth - a.depth);
  for (const { area } of byFocus) {
    here.push(area.id);
  }
  for (const area of allAreas()) {
    if (area.page !== undefined && !here.includes(area.id) && root.querySelector(area.page)) {
      here.push(area.id);
    }
  }
  return here;
}

function depthOf(element: Element | null): number {
  let depth = 0;
  for (let at = element; at !== null; at = at.parentElement) {
    depth++;
  }
  return depth;
}
