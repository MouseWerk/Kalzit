import { Fragment, useId } from "react";
import { Dialog } from "../features/admin/components/Dialog";
import { type MessageKey, useI18n } from "../i18n/i18n";
import { isMac } from "./sidebarState";
import "./shellUx.css";

interface Shortcut {
  /** Keys pressed together; "Mod" is Ctrl, or Cmd on macOS. Alternatives are separate entries. */
  keys: readonly (readonly string[])[];
  label: MessageKey;
}

interface Area {
  title: MessageKey;
  shortcuts: readonly Shortcut[];
}

/** Every shortcut of the app, by area. A new shortcut is added here as well. */
export const SHORTCUT_AREAS: readonly Area[] = [
  {
    title: "shell.shortcuts.area.general",
    shortcuts: [
      { keys: [["Mod", "K"]], label: "shell.shortcuts.palette" },
      { keys: [["?"]], label: "shell.shortcuts.help" },
      { keys: [["F6"], ["Shift", "F6"]], label: "shell.shortcuts.regions" },
      { keys: [["Esc"]], label: "shell.shortcuts.close" },
    ],
  },
  {
    title: "shell.shortcuts.area.sidebar",
    shortcuts: [
      { keys: [["Mod", "B"]], label: "shell.shortcuts.sidebar" },
      { keys: [["↑"], ["↓"]], label: "shell.shortcuts.menu" },
    ],
  },
  {
    title: "shell.shortcuts.area.palette",
    shortcuts: [
      { keys: [["↑"], ["↓"]], label: "shell.shortcuts.paletteMove" },
      { keys: [["PgUp"], ["PgDn"]], label: "shell.shortcuts.palettePage" },
      { keys: [["Enter"]], label: "shell.shortcuts.paletteRun" },
    ],
  },
  {
    title: "shell.shortcuts.area.dashboards",
    shortcuts: [
      { keys: [["↑"], ["↓"], ["Home"], ["End"]], label: "shell.shortcuts.folders" },
      { keys: [["←"], ["→"], ["↑"], ["↓"]], label: "shell.shortcuts.panelMove" },
      {
        keys: [
          ["Shift", "←"],
          ["Shift", "→"],
        ],
        label: "shell.shortcuts.panelResize",
      },
    ],
  },
  {
    title: "shell.shortcuts.area.explore",
    shortcuts: [
      { keys: [["Mod", "Enter"]], label: "shell.shortcuts.run" },
      { keys: [["←"], ["→"]], label: "shell.shortcuts.tabs" },
    ],
  },
  {
    title: "shell.shortcuts.area.editors",
    shortcuts: [
      { keys: [["Ctrl", "Space"]], label: "shell.shortcuts.suggest" },
      { keys: [["Mod", "Z"]], label: "shell.shortcuts.undo" },
      { keys: [["Mod", "Shift", "Z"]], label: "shell.shortcuts.redo" },
      { keys: [["Esc"]], label: "shell.shortcuts.suggestClose" },
    ],
  },
];

/** A key as the platform names it. */
function keyName(key: string): string {
  if (key === "Mod") {
    return isMac() ? "⌘" : "Ctrl";
  }
  return key;
}

/** The keyboard shortcuts help, opened with ? or from the command palette. */
export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const baseId = useId();
  return (
    <Dialog
      open
      wide
      title={t("shell.shortcuts.title")}
      onClose={onClose}
      footer={
        <button type="button" className="button button--secondary" onClick={onClose}>
          {t("shell.shortcuts.done")}
        </button>
      }
    >
      <div className="shortcuts">
        {SHORTCUT_AREAS.map((area, index) => (
          <section
            key={area.title}
            className="shortcuts__area"
            aria-labelledby={`${baseId}-${index}`}
          >
            <h3 id={`${baseId}-${index}`} className="shortcuts__title">
              {t(area.title)}
            </h3>
            <dl className="shortcuts__list">
              {area.shortcuts.map((shortcut) => (
                <div key={shortcut.label} className="shortcuts__row">
                  <dt className="shortcuts__keys">
                    {shortcut.keys.map((combo, comboIndex) => (
                      <Fragment key={combo.join("+")}>
                        {comboIndex === 0 ? null : (
                          <span className="shortcuts__or">{t("shell.shortcuts.or")}</span>
                        )}
                        <span className="shortcuts__combo">
                          {combo.map((key) => (
                            <kbd key={key} className="kbd">
                              {keyName(key)}
                            </kbd>
                          ))}
                        </span>
                      </Fragment>
                    ))}
                  </dt>
                  <dd className="shortcuts__label">{t(shortcut.label)}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}

/**
 * Whether a key press asks for the shortcuts help: "?" on any layout (Shift+ß on German ones),
 * never while typing.
 */
export function isHelpShortcut(event: KeyboardEvent): boolean {
  return (
    event.key === "?" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing
  );
}

/** Whether a key press asks for the command palette: Ctrl+K, or Cmd+K on macOS. */
export function isPaletteShortcut(event: KeyboardEvent): boolean {
  const isK = event.key.toLowerCase() === "k" || event.code === "KeyK";
  if (!isK || event.altKey || event.shiftKey || event.isComposing) {
    return false;
  }
  return isMac() ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** The palette shortcut as shown in the sidebar and as `aria-keyshortcuts`. */
export function paletteShortcut(): { label: string; aria: string } {
  return isMac() ? { label: "⌘K", aria: "Meta+K" } : { label: "Ctrl+K", aria: "Control+K" };
}
