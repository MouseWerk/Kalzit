import { Link } from "@tanstack/react-router";
import {
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "../components/Icon";
import { type Language, useI18n } from "../i18n/i18n";
import { useEscapeLayer } from "../lib/layers";
import { Keys } from "../shortcuts/Keys";
import { keyName } from "../shortcuts/keyNames";
import {
  type AreaDef,
  allAreas,
  areasHere,
  bindingsOf,
  currentPlatform,
  type ListedShortcut,
  matchesShortcut,
  shortcutAria,
  shortcutsOf,
  shortcutText,
} from "../shortcuts/registry";
import { setOverlay } from "./overlay";
import "../components/iconButton.css";
import "./shellUx.css";

type Translate = ReturnType<typeof useI18n>["t"];

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])';

/** The words a row is found by: its text, its area and the names of its keys. */
function haystack(
  shortcut: ListedShortcut,
  area: AreaDef,
  t: Translate,
  language: Language,
): string {
  const platform = currentPlatform();
  const names = bindingsOf(shortcut.id, platform).flatMap((binding) => {
    const keys =
      binding.kind === "sequence"
        ? binding.steps
        : binding.kind === "set"
          ? [...binding.mods, ...binding.keys]
          : binding.keys;
    return keys.flatMap((key) => {
      const name = keyName(key, language, platform);
      return [name.text ?? "", name.spoken, key];
    });
  });
  return [
    t(shortcut.label),
    shortcut.note === undefined ? "" : t(shortcut.note),
    t(area.title),
    shortcutText(shortcut.id, language),
    ...names,
  ]
    .join(" ")
    .toLowerCase();
}

function tokensOf(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s+]+/)
    .filter((token) => token !== "");
}

/** The text with each search word in full weight, without color. */
function highlighted(text: string, tokens: readonly string[]): ReactNode {
  if (tokens.length === 0) {
    return text;
  }
  const lower = text.toLowerCase();
  const marks: boolean[] = new Array(text.length).fill(false);
  for (const token of tokens) {
    for (let at = lower.indexOf(token); at !== -1; at = lower.indexOf(token, at + 1)) {
      marks.fill(true, at, at + token.length);
    }
  }
  const parts: ReactNode[] = [];
  let start = 0;
  for (let i = 1; i <= text.length; i++) {
    if (i === text.length || marks[i] !== marks[start]) {
      const part = text.slice(start, i);
      parts.push(marks[start] === true ? <mark key={start}>{part}</mark> : part);
      start = i;
    }
  }
  return parts;
}

interface Group {
  area: AreaDef;
  rows: readonly ListedShortcut[];
  here: boolean;
}

/**
 * The areas in the help's order: those that apply where the focus was (marked "here"), then
 * "Everywhere", then the rest in the fixed order. Without `here` the fixed order alone.
 */
function groupsOf(here: readonly string[]): Group[] {
  const areas = allAreas();
  const byId = new Map(areas.map((area) => [area.id, area]));
  const first = [...here, ...(here.includes("everywhere") ? [] : ["everywhere"])];
  const ordered = [
    ...first.flatMap((id) => {
      const area = byId.get(id);
      return area === undefined ? [] : [area];
    }),
    ...areas.filter((area) => !first.includes(area.id)),
  ];
  return ordered
    .map((area) => ({ area, rows: shortcutsOf(area.id), here: here.includes(area.id) }))
    .filter((group) => group.rows.length > 0);
}

function AreaHeading({
  group,
  id,
  focusable = false,
}: {
  group: Group;
  id: string;
  focusable?: boolean | undefined;
}) {
  const { t } = useI18n();
  const { area } = group;
  return (
    <h3 id={id} className="shortcuts__title" tabIndex={focusable ? -1 : undefined}>
      <span>{t(area.title)}</span>
      {area.detail === undefined ? null : (
        <span className="shortcuts__detail">{t(area.detail)}</span>
      )}
      {area.sequence === true ? (
        <span className="shortcuts__detail">{t("shortcuts.oneAfterOther")}</span>
      ) : null}
      {group.here ? <span className="shortcuts__here">{t("shortcuts.here")}</span> : null}
    </h3>
  );
}

function Row({ shortcut, tokens }: { shortcut: ListedShortcut; tokens: readonly string[] }) {
  const { t } = useI18n();
  return (
    <div className="shortcuts__row">
      <dt className="shortcuts__label">
        {highlighted(t(shortcut.label), tokens)}
        {shortcut.note === undefined ? null : (
          <span className="shortcuts__note">{highlighted(t(shortcut.note), tokens)}</span>
        )}
      </dt>
      <dd className="shortcuts__keys">
        <Keys id={shortcut.id} announce />
      </dd>
    </div>
  );
}

function Section({
  group,
  headingId,
  tokens,
  focusable,
}: {
  group: Group;
  headingId: string;
  tokens: readonly string[];
  focusable?: boolean;
}) {
  return (
    <section className="shortcuts__area" aria-labelledby={headingId} data-area={group.area.id}>
      <AreaHeading group={group} id={headingId} focusable={focusable} />
      <dl className="shortcuts__list">
        {group.rows.map((shortcut) => (
          <Row key={shortcut.id} shortcut={shortcut} tokens={tokens} />
        ))}
      </dl>
    </section>
  );
}

/** Every shortcut by area in the fixed order: the settings page. */
export function ShortcutsList() {
  const baseId = useId();
  return (
    <div className="shortcuts">
      {groupsOf([]).map((group) => (
        <Section
          key={group.area.id}
          group={group}
          headingId={`${baseId}-${group.area.id}`}
          tokens={[]}
        />
      ))}
    </div>
  );
}

/**
 * The keyboard shortcuts help (board Shortcuts, frames 2 to 10): a dialog with a fixed head
 * (title, search, Close) and foot; only the list scrolls. On the left the areas, the ones that
 * apply where the focus was first; on the right the rows, meaning left and keys right. The
 * search filters by meaning, area and key names; Escape clears it first, then closes. ? opens
 * and closes it (the shell's listener; in the search field it is typed). Focus starts in the
 * search and returns to where it was.
 */
export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const { t, language } = useI18n();
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const summaryId = `${baseId}-summary`;
  // Where the focus was before the help took it: which areas are "here", and where it returns.
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const [here] = useState(() => areasHere(opener));
  const [query, setQuery] = useState("");
  const [current, setCurrent] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLElement>(null);
  const navRef = useRef<HTMLUListElement>(null);

  useEscapeLayer(true, () => {
    if (query !== "") {
      setQuery("");
      searchRef.current?.focus();
    } else {
      onClose();
    }
  });

  const restore = useEffectEvent(() => {
    if (opener?.isConnected === true) {
      opener.focus();
    }
  });
  useEffect(() => {
    searchRef.current?.focus();
    return () => restore();
  }, []);

  const tokens = tokensOf(query);
  const groups = groupsOf(here)
    .map((group) => ({
      ...group,
      rows:
        tokens.length === 0
          ? group.rows
          : group.rows.filter((row) => {
              const words = haystack(row, group.area, t, language);
              return tokens.every((token) => words.includes(token));
            }),
    }))
    .filter((group) => group.rows.length > 0);
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
  const shownCurrent = groups.some((g) => g.area.id === current) ? current : groups[0]?.area.id;
  const countText = total === 1 ? t("shortcuts.countOne") : t("shortcuts.count", { count: total });

  // The count is announced politely, a moment after the typing stops.
  const [announced, setAnnounced] = useState("");
  useEffect(() => {
    if (query === "") {
      setAnnounced("");
      return;
    }
    const timer = window.setTimeout(
      () => setAnnounced(total === 0 ? t("shortcuts.none", { query }) : countText),
      500,
    );
    return () => window.clearTimeout(timer);
  }, [query, total, countText, t]);

  const firstHere = groups.find((group) => group.here);
  const summary =
    firstHere === undefined
      ? t("shortcuts.summaryAll", { count: total, areas: groups.length })
      : t("shortcuts.summary", {
          count: total,
          areas: groups.length,
          first: t(firstHere.area.title),
        });

  function jumpTo(areaId: string) {
    setCurrent(areaId);
    const heading = listRef.current?.querySelector<HTMLElement>(
      `[data-area="${areaId}"] .shortcuts__title`,
    );
    heading?.scrollIntoView({ block: "start" });
    heading?.focus();
  }

  function onNavKey(event: KeyboardEvent<HTMLUListElement>) {
    const buttons = [...(navRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const to =
      event.key === "ArrowDown"
        ? at + 1
        : event.key === "ArrowUp"
          ? at - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? buttons.length - 1
              : null;
    if (to === null) {
      return;
    }
    event.preventDefault();
    const next = buttons[Math.max(0, Math.min(to, buttons.length - 1))];
    if (next !== undefined) {
      setCurrent(next.dataset.area ?? null);
      next.focus();
    }
  }

  function onDialogKey(event: KeyboardEvent<HTMLDivElement>) {
    const dialog = dialogRef.current;
    if (dialog === null || event.key !== "Tab") {
      return;
    }
    const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
      (element) => element.offsetParent !== null || element === document.activeElement,
    );
    const first = items[0];
    const last = items.at(-1);
    if (first === undefined || last === undefined) {
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  const navEntry = (group: Group, index: number) => (
    <li key={group.area.id}>
      <button
        type="button"
        className="shortcuts-help__area"
        data-area={group.area.id}
        aria-current={group.area.id === shownCurrent ? "true" : undefined}
        tabIndex={group.area.id === shownCurrent ? 0 : -1}
        onClick={() => jumpTo(group.area.id)}
      >
        <span className="truncate" title={t(group.area.title)}>
          {group.here && index === 0
            ? t("shortcuts.herePrefix", { area: t(group.area.title) })
            : t(group.area.title)}
        </span>
        <span className="shortcuts-help__area-count">{group.rows.length}</span>
      </button>
    </li>
  );
  // After "Everywhere" (when nothing is searched) a thin line sets the rest apart.
  const everywhereAt = groups.findIndex((group) => group.area.id === "everywhere");

  return createPortal(
    <div
      className="shortcuts-help__backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={summaryId}
        className="shortcuts-help"
        onKeyDown={onDialogKey}
      >
        <header className="shortcuts-help__head">
          <div className="shortcuts-help__top">
            <h2 id={titleId} className="shortcuts-help__title">
              {t("shortcuts.title")}
            </h2>
            <button
              type="button"
              className="button button--ghost icon-button"
              aria-label={t("shortcuts.close")}
              title={t("shortcuts.close")}
              onClick={onClose}
            >
              <Icon name="close" />
            </button>
          </div>
          <div className="shortcuts-help__search">
            <Icon name="search" />
            <input
              ref={searchRef}
              type="search"
              className="shortcuts-help__input"
              aria-label={t("shortcuts.search")}
              placeholder={t("shortcuts.search")}
              autoComplete="off"
              spellCheck={false}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  listRef.current?.focus();
                }
              }}
            />
            {query === "" ? null : (
              <span className="shortcuts-help__count" aria-hidden="true">
                {countText}
              </span>
            )}
          </div>
          <p id={summaryId} className="visually-hidden">
            {summary}
          </p>
          <span className="visually-hidden" role="status">
            {announced}
          </span>
        </header>
        <div className="shortcuts-help__body">
          <nav className="shortcuts-help__nav" aria-label={t("shortcuts.areas")}>
            <ul ref={navRef} className="shortcuts-help__areas" onKeyDown={onNavKey}>
              {tokens.length === 0 ? null : (
                <li className="shortcuts-help__all">
                  <span>{t("shortcuts.allMatches")}</span>
                  <span className="shortcuts-help__area-count">{total}</span>
                </li>
              )}
              {groups.map((group, index) => (
                <Fragment key={group.area.id}>
                  {navEntry(group, index)}
                  {tokens.length === 0 && index === everywhereAt && index < groups.length - 1 ? (
                    <li className="shortcuts-help__divider" aria-hidden="true" />
                  ) : null}
                </Fragment>
              ))}
            </ul>
            <label className="shortcuts-help__pick">
              <span className="visually-hidden">{t("shortcuts.area")}</span>
              <select
                className="select"
                value={shownCurrent ?? ""}
                onChange={(event) => jumpTo(event.currentTarget.value)}
              >
                {groups.map((group, index) => (
                  <option key={group.area.id} value={group.area.id}>
                    {group.here && index === 0
                      ? t("shortcuts.herePrefix", { area: t(group.area.title) })
                      : t(group.area.title)}
                  </option>
                ))}
              </select>
            </label>
          </nav>
          <section
            ref={listRef}
            className="shortcuts-help__list"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the list scrolls with the arrow keys
            tabIndex={0}
            aria-label={t("shortcuts.title")}
          >
            {total === 0 ? (
              <div className="shortcuts-help__empty">
                <p className="shortcuts-help__empty-title">{t("shortcuts.none", { query })}</p>
                <p>{t("shortcuts.noneText")}</p>
                <div className="shortcuts-help__empty-actions">
                  <button
                    type="button"
                    className="button button--secondary"
                    onClick={() => {
                      setQuery("");
                      searchRef.current?.focus();
                    }}
                  >
                    {t("shortcuts.clearSearch")}
                  </button>
                  <button
                    type="button"
                    className="button button--ghost"
                    aria-keyshortcuts={shortcutAria("palette.open")}
                    onClick={() => setOverlay("palette")}
                  >
                    {t("shortcuts.searchPalette")}
                    <Keys id="palette.open" />
                  </button>
                </div>
              </div>
            ) : (
              groups.map((group) => (
                <Section
                  key={group.area.id}
                  group={group}
                  headingId={`${baseId}-${group.area.id}`}
                  tokens={tokens}
                  focusable
                />
              ))
            )}
          </section>
        </div>
        <footer className="shortcuts-help__foot">
          <span className="shortcuts-help__hint">
            <Keys id="help.toggle" />
            {t("shortcuts.footToggle")}
          </span>
          <span className="shortcuts-help__hint">
            <Keys id="layer.close" />
            {t("shortcuts.footEscape")}
          </span>
          <Link
            to="/settings/$section"
            params={{ section: "shortcuts" }}
            className="shortcuts-help__settings"
            onClick={onClose}
          >
            {t("shortcuts.settings")}
          </Link>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Whether a key press asks for the shortcuts help: "?" on any layout (Shift+ß on German ones),
 * never held down.
 */
export function isHelpShortcut(event: globalThis.KeyboardEvent): boolean {
  return matchesShortcut("help.toggle", event);
}

/**
 * Whether a key press asks to search: "/" on any layout (Shift+7 on German ones); it opens the
 * command palette.
 */
export function isSearchShortcut(event: globalThis.KeyboardEvent): boolean {
  return event.key === "/" && matchesShortcut("palette.open", event);
}

/** Whether a key press asks for the command palette: Ctrl+K, or Cmd+K on macOS. */
export function isPaletteShortcut(event: globalThis.KeyboardEvent): boolean {
  return event.key !== "/" && matchesShortcut("palette.open", event);
}
