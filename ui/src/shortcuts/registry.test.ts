import { afterEach, describe, expect, it, vi } from "vitest";
import { de, en } from "../i18n/catalogs";
import { setLanguage } from "../i18n/i18n";
import {
  ariaKeyshortcuts,
  type Binding,
  combo,
  keySet,
  sequence,
  spokenBinding,
  writtenBindings,
} from "./keyNames";
import {
  allAreas,
  allShortcuts,
  areasHere,
  bindingsOf,
  matchesShortcut,
  nameWithShortcut,
  shortcutAria,
  shortcutSpoken,
  shortcutsOf,
  shortcutText,
} from "./registry";

const WORDS_DE = { plus: "plus", after: "dann", or: "oder" };
const WORDS_EN = { plus: "plus", after: "then", or: "or" };

function press(init: Partial<KeyboardEventInit> & { key: string }): KeyboardEvent {
  return new KeyboardEvent("keydown", init);
}

function onMac() {
  vi.spyOn(window.navigator, "platform", "get").mockReturnValue("MacIntel");
}

afterEach(() => {
  vi.restoreAllMocks();
  setLanguage("en");
});

describe("the shortcut registry", () => {
  it("gives every area a title and every row a text, in German and English", () => {
    for (const area of allAreas()) {
      expect(en[area.title as keyof typeof en], area.id).toBeTruthy();
      expect(de[area.title as keyof typeof de], area.id).toBeTruthy();
    }
    for (const shortcut of allShortcuts()) {
      expect(
        allAreas().some((area) => area.id === shortcut.area),
        shortcut.id,
      ).toBe(true);
      if (shortcut.partOf === undefined) {
        expect(en[shortcut.label as keyof typeof en], shortcut.id).toBeTruthy();
        expect(de[shortcut.label as keyof typeof de], shortcut.id).toBeTruthy();
      } else {
        expect(allShortcuts().some((other) => other.id === shortcut.partOf)).toBe(true);
      }
    }
  });

  it("lists the areas the old help missed (board Shortcuts, finding 6)", () => {
    for (const id of [
      "explore.save",
      "explore.open",
      "graph.next",
      "chart.readout",
      "chart.annotate",
      "panelEditor.back",
      "row.move",
      "trace.move",
      "analyses.search",
      "analyses.rows",
      "policies.move",
      "ask.send",
      "explore.aiDraft",
    ]) {
      expect(allShortcuts().some((shortcut) => shortcut.id === id)).toBe(true);
    }
  });

  it("has no two rows with the same keys in one place, unless one says it takes over", () => {
    for (const platform of ["mac", "other"] as const) {
      const seen = new Map<string, string>();
      for (const shortcut of allShortcuts()) {
        if (shortcut.partOf !== undefined) continue;
        for (const binding of bindingsOf(shortcut.id, platform)) {
          const keys =
            binding.kind === "sequence"
              ? [binding.steps.join(" then ")]
              : binding.kind === "set"
                ? binding.keys.map((key) => [...binding.mods, key].sort().join("+"))
                : [[...binding.keys].sort().join("+")];
          for (const key of keys) {
            const place = `${shortcut.area}/${shortcut.context ?? ""}/${key}`;
            const other = seen.get(place);
            expect(other, `${shortcut.id} and ${other} share ${key}`).toBeUndefined();
            seen.set(place, shortcut.id);
            // A page's key that "Everywhere" has too must say that it takes over.
            const everywhere = seen.get(`everywhere//${key}`);
            if (shortcut.area !== "everywhere" && everywhere !== undefined) {
              expect(shortcut.overrides, `${shortcut.id} shadows ${everywhere}`).toBe(everywhere);
            }
          }
        }
      }
    }
  });

  it("hides the keys that belong to a row and shows only the rows", () => {
    expect(shortcutsOf("policies").map((s) => s.id)).toEqual([
      "policies.open",
      "policies.move",
      "policies.indent",
    ]);
  });
});

describe("key names", () => {
  const save = [combo("Mod", "Shift", "S")];

  it("writes German keys as on a German keyboard", () => {
    expect(writtenBindings(save, "de", "other", WORDS_DE)).toBe("Strg+Umschalt+S");
    expect(writtenBindings([combo("Ctrl", "Space")], "de", "other", WORDS_DE)).toBe(
      "Strg+Leertaste",
    );
    expect(writtenBindings([combo("Mod", "Enter")], "de", "other", WORDS_DE)).toBe("Strg+Eingabe");
    expect(writtenBindings([combo("Del")], "de", "other", WORDS_DE)).toBe("Entf");
    expect(writtenBindings([combo("Mod", "K"), combo("/")], "de", "other", WORDS_DE)).toBe(
      "Strg+K oder /",
    );
  });

  it("writes a Mac's signs in the order ⌃ ⌥ ⇧ ⌘, without a plus, and ⌫ for deleting", () => {
    expect(writtenBindings(save, "en", "mac", WORDS_EN)).toBe("⇧⌘S");
    expect(
      writtenBindings([combo("Shift", "Alt", "Ctrl", "Mod", "X")], "en", "mac", WORDS_EN),
    ).toBe("⌃⌥⇧⌘X");
    expect(writtenBindings([combo("Ctrl", "Space")], "de", "mac", WORDS_DE)).toBe("⌃ Leertaste");
    expect(writtenBindings([combo("Del")], "de", "mac", WORDS_DE)).toBe("⌫");
  });

  it("writes keys one after the other with then, never with a plus", () => {
    expect(writtenBindings([sequence("T", "Z")], "de", "other", WORDS_DE)).toBe("T dann Z");
  });

  it("spells keys out for screen readers, never the signs", () => {
    expect(spokenBinding(combo("Mod", "K"), "de", "other", WORDS_DE)).toBe("Steuerung plus K");
    expect(spokenBinding(save[0] as Binding, "de", "mac", WORDS_DE)).toBe(
      "Umschalt plus Befehl plus S",
    );
    expect(spokenBinding(sequence("T", "ArrowLeft"), "de", "other", WORDS_DE)).toBe(
      "T, dann Pfeil links",
    );
    expect(spokenBinding(combo("/"), "en", "other", WORDS_EN)).toBe("Slash");
  });

  it("puts only combinations into aria-keyshortcuts, with the platform's key", () => {
    expect(ariaKeyshortcuts([combo("Mod", "K"), combo("/")], "other")).toBe("Control+K /");
    expect(ariaKeyshortcuts([combo("Mod", "K")], "mac")).toBe("Meta+K");
    expect(ariaKeyshortcuts([sequence("T", "ArrowLeft")], "other")).toBeUndefined();
    expect(ariaKeyshortcuts([combo("Del")], "mac")).toBe("Backspace Delete");
    expect(ariaKeyshortcuts([keySet(["Alt"], "ArrowUp", "ArrowDown")], "other")).toBe(
      "Alt+ArrowUp Alt+ArrowDown",
    );
    expect(ariaKeyshortcuts([combo("A"), combo("Mod", "Click")], "other")).toBe("A");
  });
});

describe("shortcuts on the page", () => {
  it("say a sequence in the control's name instead of aria-keyshortcuts", () => {
    expect(shortcutAria("time.back")).toBeUndefined();
    expect(nameWithShortcut("Move the time range back", "time.back", "en")).toBe(
      "Move the time range back, T, then Left arrow",
    );
    expect(nameWithShortcut("Zeitraum zurück", "time.back", "de")).toBe(
      "Zeitraum zurück, T, dann Pfeil links",
    );
    expect(shortcutSpoken("palette.open", "de")).toBe("Steuerung plus K, oder Schrägstrich");
  });

  it("show the platform's redo first and take both everywhere", () => {
    expect(shortcutText("editor.redo", "de")).toBe("Strg+Y oder Strg+Umschalt+Z");
    expect(matchesShortcut("editor.redo", press({ key: "y", ctrlKey: true }))).toBe(true);
    expect(matchesShortcut("editor.redo", press({ key: "Z", ctrlKey: true, shiftKey: true }))).toBe(
      true,
    );
    onMac();
    expect(shortcutText("editor.redo", "en")).toBe("⇧⌘Z or ⌘Y");
    expect(matchesShortcut("editor.redo", press({ key: "z", metaKey: true, shiftKey: true }))).toBe(
      true,
    );
    expect(matchesShortcut("editor.redo", press({ key: "y", metaKey: true }))).toBe(true);
    expect(matchesShortcut("editor.redo", press({ key: "y", ctrlKey: true }))).toBe(false);
  });

  it("match exactly the modifiers, the physical key for letters, and any layout for signs", () => {
    expect(matchesShortcut("palette.open", press({ key: "k", ctrlKey: true }))).toBe(true);
    expect(matchesShortcut("palette.open", press({ key: "л", code: "KeyK", ctrlKey: true }))).toBe(
      true,
    );
    expect(
      matchesShortcut("palette.open", press({ key: "k", ctrlKey: true, shiftKey: true })),
    ).toBe(false);
    // "?" is Shift+ß on a German keyboard, "/" is Shift+7.
    expect(matchesShortcut("help.toggle", press({ key: "?", shiftKey: true }))).toBe(true);
    expect(matchesShortcut("palette.open", press({ key: "/", shiftKey: true }))).toBe(true);
    expect(matchesShortcut("help.toggle", press({ key: "?", isComposing: true }))).toBe(false);
  });

  it("put the area of the focused element first, then the page's", () => {
    document.body.innerHTML = `
      <div class="dashboard" data-shortcuts="dashboardEdit">
        <div class="time-controls" data-shortcuts="time"></div>
        <div class="ts__plot"><button id="inside">x</button></div>
      </div>`;
    expect(areasHere(document.getElementById("inside"))).toEqual([
      "charts",
      "time",
      "dashboardEdit",
    ]);
    expect(areasHere(null)).toEqual(["time", "dashboardEdit"]);
    document.body.innerHTML = "";
  });
});
