import type { Language } from "../i18n/i18n";
import { isComposingKey } from "../lib/ime";

/**
 * The keys of a shortcut, as data: what the registry defines, what a key press is matched
 * against, and what the key caps, `aria-keyshortcuts` and spoken names are made from.
 *
 * Key names: "Mod" is the platform's command key (Ctrl, Cmd on a Mac); "Ctrl", "Alt" and
 * "Shift" are the modifiers themselves. Named keys: Enter, Space, Esc, Tab, Del, PgUp, PgDn,
 * Home, End, ArrowLeft, ArrowRight, ArrowUp, ArrowDown, Menu, Click, F1 to F12. Anything else
 * is the character on the key ("K", "/", "?", "+"); letters are written in capitals, as on the
 * key.
 */
export type Platform = "mac" | "other";

/** Keys pressed together: the modifiers, then the key. */
export interface Combo {
  readonly kind: "combo";
  readonly keys: readonly string[];
}

/** Keys pressed one after the other: "T", then "ArrowLeft". */
export interface Sequence {
  readonly kind: "sequence";
  readonly steps: readonly string[];
}

/**
 * Several keys with one meaning, drawn close together without "or": the arrow keys of a handle,
 * the tools V R L. `mods` are held with any of them.
 */
export interface KeySet {
  readonly kind: "set";
  readonly mods: readonly string[];
  readonly keys: readonly string[];
}

export type Binding = Combo | Sequence | KeySet;

export const combo = (...keys: string[]): Combo => ({ kind: "combo", keys });
export const sequence = (...steps: string[]): Sequence => ({ kind: "sequence", steps });
export const keySet = (mods: readonly string[], ...keys: string[]): KeySet => ({
  kind: "set",
  mods,
  keys,
});

const MODIFIERS = ["Ctrl", "Alt", "Shift", "Mod"] as const;
type Modifier = (typeof MODIFIERS)[number];

export function isModifier(key: string): key is Modifier {
  return (MODIFIERS as readonly string[]).includes(key);
}

/**
 * The modifiers in the order the platform writes them: Strg, Alt, Umschalt on Windows and
 * Linux; ⌃ ⌥ ⇧ ⌘ on a Mac, as its menus do.
 */
export function orderKeys(keys: readonly string[], platform: Platform): string[] {
  const rank: Record<Modifier, number> =
    platform === "mac"
      ? { Ctrl: 0, Alt: 1, Shift: 2, Mod: 3 }
      : { Mod: 0, Ctrl: 0, Alt: 1, Shift: 2 };
  const mods = keys.filter(isModifier).sort((a, b) => rank[a] - rank[b]);
  return [...mods, ...keys.filter((key) => !isModifier(key))];
}

/** How a key is written on its cap, and how it is spoken. */
export interface KeyName {
  /** The text on the cap, or null for the arrows, which are drawn as icons. */
  text: string | null;
  /** The name a screen reader reads, never a raw sign. */
  spoken: string;
}

type Names = Record<Language, Record<Platform, string>>;

const same = (de: string, en: string): Names => ({
  de: { other: de, mac: de },
  en: { other: en, mac: en },
});

/** What the caps show, per language and platform (board Shortcuts, frame 5). */
const SHOWN: Record<string, Names> = {
  Mod: { de: { other: "Strg", mac: "⌘" }, en: { other: "Ctrl", mac: "⌘" } },
  Ctrl: { de: { other: "Strg", mac: "⌃" }, en: { other: "Ctrl", mac: "⌃" } },
  Shift: { de: { other: "Umschalt", mac: "⇧" }, en: { other: "Shift", mac: "⇧" } },
  Alt: { de: { other: "Alt", mac: "⌥" }, en: { other: "Alt", mac: "⌥" } },
  Enter: { de: { other: "Eingabe", mac: "\u21a9" }, en: { other: "Enter", mac: "\u21a9" } },
  Space: same("Leertaste", "Space"),
  Esc: same("Esc", "Esc"),
  Tab: same("Tab", "Tab"),
  Del: { de: { other: "Entf", mac: "⌫" }, en: { other: "Del", mac: "⌫" } },
  PgUp: { de: { other: "Bild auf", mac: "⇞" }, en: { other: "PgUp", mac: "⇞" } },
  PgDn: { de: { other: "Bild ab", mac: "⇟" }, en: { other: "PgDn", mac: "⇟" } },
  Home: { de: { other: "Pos1", mac: "\u2196" }, en: { other: "Home", mac: "\u2196" } },
  End: { de: { other: "Ende", mac: "\u2198" }, en: { other: "End", mac: "\u2198" } },
  Menu: { de: { other: "Menütaste", mac: "⌃ Klick" }, en: { other: "Menu key", mac: "⌃ click" } },
  Click: same("Klick", "Click"),
};

/** What a screen reader reads for each key: the written-out name, never the sign. */
const SPOKEN: Record<string, Names> = {
  Mod: { de: { other: "Steuerung", mac: "Befehl" }, en: { other: "Control", mac: "Command" } },
  Ctrl: same("Steuerung", "Control"),
  Shift: same("Umschalt", "Shift"),
  Alt: { de: { other: "Alt", mac: "Wahltaste" }, en: { other: "Alt", mac: "Option" } },
  Enter: { de: { other: "Eingabe", mac: "Eingabe" }, en: { other: "Enter", mac: "Return" } },
  Space: same("Leertaste", "Space"),
  Esc: same("Escape", "Escape"),
  Tab: same("Tabulator", "Tab"),
  Del: { de: { other: "Entfernen", mac: "Rückschritt" }, en: { other: "Delete", mac: "Delete" } },
  PgUp: same("Bild auf", "Page up"),
  PgDn: same("Bild ab", "Page down"),
  Home: { de: { other: "Pos1", mac: "Anfang" }, en: { other: "Home", mac: "Home" } },
  End: same("Ende", "End"),
  Menu: {
    de: { other: "Menütaste", mac: "Control-Klick" },
    en: { other: "Menu key", mac: "Control-click" },
  },
  Click: same("Klick", "Click"),
  ArrowLeft: same("Pfeil links", "Left arrow"),
  ArrowRight: same("Pfeil rechts", "Right arrow"),
  ArrowUp: same("Pfeil auf", "Up arrow"),
  ArrowDown: same("Pfeil ab", "Down arrow"),
  "/": same("Schrägstrich", "Slash"),
  "?": same("Fragezeichen", "Question mark"),
  "+": same("Plus", "Plus"),
  "-": same("Minus", "Minus"),
  "=": same("Gleich", "Equals"),
};

export const ARROWS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"] as const;
export type Arrow = (typeof ARROWS)[number];

export function isArrow(key: string): key is Arrow {
  return (ARROWS as readonly string[]).includes(key);
}

/** A key's cap text and spoken name in a language on a platform. */
export function keyName(key: string, language: Language, platform: Platform): KeyName {
  const spoken = SPOKEN[key]?.[language][platform] ?? key;
  if (isArrow(key)) {
    return { text: null, spoken };
  }
  // The minus sign, not the hyphen, on the cap.
  const text = SHOWN[key]?.[language][platform] ?? (key === "-" ? "−" : key);
  return { text, spoken };
}

/** The name `aria-keyshortcuts` uses for a key (UI Events key values). */
function ariaKey(key: string, platform: Platform): string[] {
  switch (key) {
    case "Mod":
      return [platform === "mac" ? "Meta" : "Control"];
    case "Ctrl":
      return ["Control"];
    case "Esc":
      return ["Escape"];
    case "Del":
      // A Mac's keyboard deletes with Backspace; the Delete key counts too where there is one.
      return platform === "mac" ? ["Backspace", "Delete"] : ["Delete"];
    case "PgUp":
      return ["PageUp"];
    case "PgDn":
      return ["PageDown"];
    case "Menu":
      return ["ContextMenu"];
    default:
      return [key];
  }
}

/**
 * The `aria-keyshortcuts` value for some bindings: each combination with the platform's keys,
 * separated by spaces. Sequences and pointer gestures are left out: there the space would mean
 * "or", so a screen reader would hear two shortcuts; a sequence goes into the control's name
 * instead (`spokenBinding`). Undefined when nothing is left.
 */
export function ariaKeyshortcuts(
  bindings: readonly Binding[],
  platform: Platform,
): string | undefined {
  const parts: string[] = [];
  for (const binding of bindings) {
    const combos =
      binding.kind === "combo"
        ? [binding.keys]
        : binding.kind === "set"
          ? binding.keys.map((key) => [...binding.mods, key])
          : [];
    for (const keys of combos) {
      if (keys.includes("Click")) {
        continue;
      }
      const ordered = orderKeys(keys, platform);
      const mods = ordered.filter(isModifier).flatMap((key) => ariaKey(key, platform));
      const last = ordered.at(-1) ?? "";
      for (const main of isModifier(last) ? [""] : ariaKey(last, platform)) {
        parts.push([...mods, ...(main === "" ? [] : [main])].join("+"));
      }
    }
  }
  return parts.length === 0 ? undefined : parts.join(" ");
}

/** Words used between keys when a binding is read or written out. */
export interface Joiners {
  plus: string;
  after: string;
  or: string;
}

/** A binding written out for a screen reader: "Steuerung plus K", "T, dann Pfeil links". */
export function spokenBinding(
  binding: Binding,
  language: Language,
  platform: Platform,
  words: Joiners,
): string {
  const name = (key: string) => keyName(key, language, platform).spoken;
  if (binding.kind === "sequence") {
    return binding.steps.map(name).join(`, ${words.after} `);
  }
  if (binding.kind === "set") {
    const mods = orderKeys(binding.mods, platform).map(name);
    const keys = binding.keys.map(name).join(", ");
    return [...mods, keys].join(` ${words.plus} `);
  }
  return orderKeys(binding.keys, platform).map(name).join(` ${words.plus} `);
}

/** Bindings written as plain text, for a title attribute or a placeholder in a sentence. */
export function writtenBindings(
  bindings: readonly Binding[],
  language: Language,
  platform: Platform,
  words: Joiners,
): string {
  const text = (key: string) => keyName(key, language, platform).text ?? arrowText(key);
  return bindings
    .map((binding) => {
      if (binding.kind === "sequence") {
        return binding.steps.map(text).join(` ${words.after} `);
      }
      const mods = orderKeys(binding.kind === "set" ? binding.mods : binding.keys, platform)
        .filter(isModifier)
        .map(text);
      const main =
        binding.kind === "set"
          ? binding.keys.map(text).join(binding.keys.every(isArrow) ? "" : " ")
          : binding.keys
              .filter((key) => !isModifier(key))
              .map(text)
              .join("");
      if (platform !== "mac") {
        return [...mods, main].join("+");
      }
      // On a Mac the signs stand right before the key; a word ("Klick") keeps a space.
      const signs = mods.join("");
      return signs === "" ? main : main.length > 1 ? `${signs} ${main}` : `${signs}${main}`;
    })
    .join(` ${words.or} `);
}

/** The arrows as characters, only for plain text where no icon can be drawn (a title). */
function arrowText(key: string): string {
  // glyph-ok: arrow keys written into plain text, where no icon can be drawn
  const arrows: Record<string, string> = {
    ArrowLeft: "←",
    ArrowRight: "→",
    // glyph-ok: arrow keys written into plain text
    ArrowUp: "↑",
    // glyph-ok: arrow keys written into plain text
    ArrowDown: "↓",
  };
  return arrows[key] ?? key;
}

/** What a key press is, in the registry's key names. */
interface Press {
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

/** The key of a press in the registry's names: "Esc", "Del", "Space", letters in capitals. */
function pressedKey(event: Press): string {
  switch (event.key) {
    case "Escape":
      return "Esc";
    case "Delete":
      return "Del";
    case " ":
      return "Space";
    case "PageUp":
      return "PgUp";
    case "PageDown":
      return "PgDn";
    case "ContextMenu":
      return "Menu";
    default:
      return event.key.length === 1 ? event.key.toUpperCase() : event.key;
  }
}

/** Characters whose key needs Shift on some layouts ("?" is Shift+ß in German): Shift is free. */
function shiftFree(key: string): boolean {
  return key.length === 1 && !/[A-Za-z0-9]/.test(key);
}

/**
 * Whether a press is one combination: exactly its modifiers, and its key. Never while an input
 * method composes (Enter confirming a candidate, Escape cancelling one).
 */
export function matchesCombo(event: Press, keys: readonly string[], platform: Platform): boolean {
  if (isComposingKey(event)) {
    return false;
  }
  const main = keys.find((key) => !isModifier(key));
  if (main === undefined) {
    return false;
  }
  const wants = (mod: Modifier) => keys.includes(mod);
  const command = platform === "mac" ? "metaKey" : "ctrlKey";
  const control = wants("Ctrl") || (wants("Mod") && command === "ctrlKey");
  const meta = wants("Mod") && command === "metaKey";
  if (event.ctrlKey !== control || event.metaKey !== meta || event.altKey !== wants("Alt")) {
    return false;
  }
  if (!shiftFree(main) && event.shiftKey !== wants("Shift")) {
    return false;
  }
  const pressed = pressedKey(event);
  if (pressed === main) {
    return true;
  }
  // A Mac deletes with Backspace (most of its keyboards have no Delete key).
  if (main === "Del" && platform === "mac" && event.key === "Backspace") {
    return true;
  }
  // The physical key counts for letters, so layouts without Latin letters (Cyrillic, Greek)
  // reach the shortcut too.
  return /^[A-Z]$/.test(main) && event.code === `Key${main}`;
}

/** Whether a press is any combination of the bindings (sequences are matched elsewhere). */
export function matchesBindings(
  event: Press,
  bindings: readonly Binding[],
  platform: Platform,
): boolean {
  return bindings.some((binding) => {
    if (binding.kind === "combo") {
      return matchesCombo(event, binding.keys, platform);
    }
    if (binding.kind === "set") {
      return binding.keys.some((key) => matchesCombo(event, [...binding.mods, key], platform));
    }
    return false;
  });
}

/**
 * A combination as CodeMirror names it ("Mod-Shift-z"), so the query editors' key map is built
 * from the same definitions as the help.
 */
export function codeMirrorKey(binding: Combo): string {
  return binding.keys
    .map((key) => {
      switch (key) {
        case "Mod":
          return "Mod";
        case "Ctrl":
          return "Ctrl";
        case "Alt":
          return "Alt";
        case "Shift":
          return "Shift";
        case "Esc":
          return "Escape";
        case "Del":
          return "Delete";
        case "Space":
          return "Space";
        default:
          return key.length === 1 ? key.toLowerCase() : key;
      }
    })
    .join("-");
}
