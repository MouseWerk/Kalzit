import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { type KeyboardEvent, useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "../components/Icon";
import { ORG_SECTIONS, SERVER_SECTIONS } from "../features/admin/sections";
import { NAV_ITEMS } from "../features/nav";
import { LANGUAGES, type MessageKey, useI18n } from "../i18n/i18n";
import { useEscapeLayer } from "../lib/layers";
import { showErrorToast } from "../lib/toasts";
import { useCurrentOrg, useOrgPermissions } from "../org/useOrg";
import { usePreferenceChange } from "../preferences/preferences";
import { THEMES, useTheme } from "../theme/theme";
import { fuzzyScore } from "./fuzzy";
import { recentsQuery, type SearchHit, search } from "./homeApi";
import { apiErrorText } from "./shellErrors";
import "./shellUx.css";

const appRoute = getRouteApi("/_app");

/** Pause in typing before the server is asked. */
export const SEARCH_DELAY_MS = 150;
const PAGE_SIZE = 20;
const RECENT_LIMIT = 5;

type Group = "recent" | "results" | "actions" | "pages";

interface PaletteItem {
  key: string;
  label: string;
  /** Where it lives or what it is, read after the label. */
  detail?: string | undefined;
  icon: IconName;
  group: Group;
  score: number;
  run: () => void;
}

const GROUP_LABEL: Record<Group, MessageKey> = {
  recent: "shell.palette.group.recent",
  results: "shell.palette.group.results",
  actions: "shell.palette.group.actions",
  pages: "shell.palette.group.pages",
};

const KIND_ICON: Record<SearchHit["kind"], IconName> = {
  dashboard: "dashboards",
  folder: "dashboards",
  datasource: "dataSources",
};

const KIND_LABEL: Record<SearchHit["kind"], MessageKey> = {
  dashboard: "shell.palette.kind.dashboard",
  folder: "shell.palette.kind.folder",
  datasource: "shell.palette.kind.datasource",
};

/**
 * The command palette (Ctrl+K, Cmd+K on macOS): one text field that finds dashboards, folders and
 * data sources on the server (only what the user may open), the pages of the navigation and
 * administration the user may see, recently opened dashboards and actions. A combobox with a
 * listbox after the WAI-ARIA pattern: focus stays in the field, the arrow keys move the active
 * option, Enter runs it and Escape closes.
 */
export function CommandPalette({
  onClose,
  onShowShortcuts,
}: {
  onClose: () => void;
  onShowShortcuts: () => void;
}) {
  const { t } = useI18n();
  const org = useCurrentOrg();
  const permissions = useOrgPermissions();
  const navigate = useNavigate();
  const theme = useTheme();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const listId = useId();
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const { me } = appRoute.useRouteContext();
  const change = usePreferenceChange(me.id, {
    onFailed: (error) => showErrorToast(apiErrorText(t, error)),
  });
  useEscapeLayer(true, onClose);

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(text.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [text]);

  const focusOnOpen = useEffectEvent(() => inputRef.current?.focus());
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    focusOnOpen();
    return () => {
      if (opener?.isConnected === true) {
        opener.focus();
      }
    };
  }, []);

  const orgId = org?.id ?? "";
  const recents = useQuery({ ...recentsQuery(orgId), enabled: org !== undefined });
  const results = useInfiniteQuery({
    queryKey: ["palette", orgId, query],
    queryFn: ({ pageParam, signal }) =>
      search(orgId, { q: query, cursor: pageParam, limit: PAGE_SIZE }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: org !== undefined && query !== "",
  });

  function go(run: () => void) {
    onClose();
    run();
  }

  const goTo = (to: string) => () => {
    void navigate({ to });
  };

  // Pages the user may open: the navigation and the administration's sections.
  const pages: PaletteItem[] = [];
  for (const item of NAV_ITEMS) {
    if (item.visible?.(permissions) ?? true) {
      pages.push({
        key: `page:${item.to}`,
        label: t(item.label),
        icon: item.icon,
        group: "pages",
        score: 0,
        run: goTo(item.to),
      });
    }
  }
  for (const section of [...ORG_SECTIONS, ...SERVER_SECTIONS]) {
    if (section.visible(permissions) && (permissions.isServerAdmin || org !== undefined)) {
      pages.push({
        key: `page:${section.to}`,
        label: t(section.label),
        detail: t("admin.nav"),
        icon: "admin",
        group: "pages",
        score: 0,
        run: goTo(section.to),
      });
    }
  }
  pages.push({
    key: "page:/settings/profile",
    label: t("admin.account.title"),
    icon: "home",
    group: "pages",
    score: 0,
    run: goTo("/settings/profile"),
  });

  const actions: PaletteItem[] = [];
  if (org !== undefined && permissions.has("dashboards:write")) {
    actions.push({
      key: "action:new-dashboard",
      label: t("shell.palette.action.newDashboard"),
      icon: "plus",
      group: "actions",
      score: 0,
      run: () => void navigate({ to: "/dashboards", search: { create: "dashboard" } }),
    });
  }
  if (org !== undefined && permissions.has("datasources:query")) {
    actions.push({
      key: "action:explore",
      label: t("shell.palette.action.explore"),
      icon: "explore",
      group: "actions",
      score: 0,
      run: goTo("/explore"),
    });
  }
  if (org !== undefined && permissions.has("datasources:write")) {
    actions.push({
      key: "action:new-datasource",
      label: t("shell.palette.action.newDatasource"),
      icon: "plus",
      group: "actions",
      score: 0,
      run: () => void navigate({ to: "/data-sources/new", search: {} }),
    });
  }
  for (const option of THEMES) {
    if (option !== theme) {
      actions.push({
        key: `action:theme:${option}`,
        label: t("shell.palette.action.theme", { theme: t(`theme.${option}`) }),
        icon: "sidebar",
        group: "actions",
        score: 0,
        run: () => change.mutate({ theme: option }),
      });
    }
  }
  for (const option of LANGUAGES) {
    actions.push({
      key: `action:language:${option}`,
      label: t("shell.palette.action.language", { language: t(`language.${option}`) }),
      icon: "explore",
      group: "actions",
      score: 0,
      run: () => change.mutate({ language: option }),
    });
  }
  actions.push({
    key: "action:shortcuts",
    label: t("shell.palette.action.shortcuts"),
    icon: "keyboard",
    group: "actions",
    score: 0,
    run: onShowShortcuts,
  });

  const recentItems: PaletteItem[] = (recents.data?.items ?? []).map((entry) => ({
    key: `dashboard:${entry.id}`,
    label: entry.title,
    detail: entry.path.join(" / ") || undefined,
    icon: "dashboards",
    group: "recent",
    score: 0,
    run: () => void navigate({ to: "/dashboards/$dashboardId", params: { dashboardId: entry.id } }),
  }));

  let items: PaletteItem[];
  if (query === "") {
    items = [...recentItems.slice(0, RECENT_LIMIT), ...actions, ...pages];
  } else {
    const hits: PaletteItem[] = (results.data?.pages ?? []).flatMap((page) =>
      page.items.map((hit) => ({
        key: `${hit.kind}:${hit.id}`,
        label: hit.title,
        detail: [t(KIND_LABEL[hit.kind]), ...hit.path].join(" · "),
        icon: KIND_ICON[hit.kind],
        group: "results" as const,
        score: hit.score,
        run: hitTarget(hit),
      })),
    );
    const seen = new Set(hits.map((hit) => hit.key));
    const local = [...recentItems.filter((item) => !seen.has(item.key)), ...actions, ...pages]
      .map((item) => ({ ...item, score: fuzzyScore(query, item.label) ?? -1 }))
      .filter((item) => item.score >= 0);
    // Best match first; equal scores keep the server's order, then the local one.
    items = [...hits, ...local]
      .map((item, index) => ({ item, index }))
      .sort((a, b) => b.item.score - a.item.score || a.index - b.index)
      .map(({ item }) => item);
  }

  function hitTarget(hit: SearchHit): () => void {
    switch (hit.kind) {
      case "dashboard":
        return () =>
          void navigate({ to: "/dashboards/$dashboardId", params: { dashboardId: hit.id } });
      case "folder":
        return () => void navigate({ to: "/dashboards", search: { folder: hit.id } });
      case "datasource":
        return () =>
          void navigate({ to: "/data-sources/$datasourceId", params: { datasourceId: hit.id } });
    }
  }

  const more = query !== "" && results.hasNextPage;
  const count = items.length + (more ? 1 : 0);
  const current = count === 0 ? -1 : Math.min(active, count - 1);
  const optionId = (index: number) => `${listId}-${index}`;

  useEffect(() => {
    if (current < 0) {
      return;
    }
    const option = document.getElementById(`${listId}-${current}`);
    option?.scrollIntoView?.({ block: "nearest" });
  }, [current, listId]);

  function runAt(index: number) {
    if (index === items.length && more) {
      void results.fetchNextPage();
      return;
    }
    const item = items[index];
    if (item !== undefined) {
      go(item.run);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setActive(count === 0 ? 0 : (current + 1) % count);
        break;
      case "ArrowUp":
        event.preventDefault();
        setActive(count === 0 ? 0 : (current - 1 + count) % count);
        break;
      case "PageDown":
        event.preventDefault();
        setActive(Math.min(count - 1, current + 8));
        break;
      case "PageUp":
        event.preventDefault();
        setActive(Math.max(0, current - 8));
        break;
      case "Enter":
        if (!event.nativeEvent.isComposing && current >= 0) {
          event.preventDefault();
          runAt(current);
        }
        break;
      case "Tab":
        // The field is the only stop; the options are reached with the arrow keys.
        event.preventDefault();
        break;
      default:
    }
  }

  const searching = query !== "" && results.isFetching && results.data === undefined;
  let status = "";
  if (text.trim() !== "" && text.trim() !== query) {
    status = "";
  } else if (searching) {
    status = t("shell.palette.searching");
  } else if (results.isError && query !== "") {
    status = apiErrorText(t, results.error);
  } else if (query !== "") {
    status =
      items.length === 0
        ? t("shell.palette.noResults")
        : t("shell.palette.resultCount", { count: items.length });
  }

  // Without a query the options are grouped (recent, actions, pages); results are one ranked list.
  const sections: { group: Group | null; entries: { item: PaletteItem; index: number }[] }[] = [];
  items.forEach((item, index) => {
    const group = query === "" ? item.group : null;
    const last = sections.at(-1);
    if (last !== undefined && last.group === group) {
      last.entries.push({ item, index });
    } else {
      sections.push({ group, entries: [{ item, index }] });
    }
  });

  // Options are reached from the field with the arrow keys (aria-activedescendant), so they are
  // not focusable themselves; a click runs one as Enter does.
  function option(item: PaletteItem, index: number) {
    return (
      // biome-ignore lint/a11y/useFocusableInteractive: the combobox keeps focus; see above.
      // biome-ignore lint/a11y/useKeyWithClickEvents: Enter in the field runs the active option.
      <div
        key={item.key}
        id={optionId(index)}
        role="option"
        aria-selected={index === current}
        className="palette__option"
        onPointerMove={() => setActive(index)}
        onClick={() => runAt(index)}
      >
        <Icon name={item.icon} />
        <span className="palette__label truncate">{item.label}</span>
        {item.detail === undefined ? null : (
          <span className="palette__detail truncate">{item.detail}</span>
        )}
      </div>
    );
  }

  // A press on the backdrop closes, as Escape does.
  return createPortal(
    <div
      className="palette__backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="palette" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className="visually-hidden">
          {t("shell.palette.title")}
        </h2>
        <div className="palette__field">
          <Icon name="search" />
          <input
            ref={inputRef}
            className="palette__input"
            type="text"
            role="combobox"
            aria-label={t("shell.palette.label")}
            aria-expanded={count > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={current >= 0 ? optionId(current) : undefined}
            autoComplete="off"
            spellCheck={false}
            placeholder={t("shell.palette.placeholder")}
            value={text}
            onChange={(event) => {
              setText(event.currentTarget.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
        </div>
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={t("shell.palette.results")}
          className="palette__list"
        >
          {sections.map((section) =>
            section.group === null ? (
              section.entries.map(({ item, index }) => option(item, index))
            ) : (
              // biome-ignore lint/a11y/useSemanticElements: a listbox groups its options with role="group"; a fieldset is not allowed there.
              <div
                key={section.group}
                role="group"
                aria-labelledby={`${listId}-${section.group}`}
                className="palette__group"
              >
                <div id={`${listId}-${section.group}`} className="palette__heading">
                  {t(GROUP_LABEL[section.group])}
                </div>
                {section.entries.map(({ item, index }) => option(item, index))}
              </div>
            ),
          )}
          {more ? (
            // biome-ignore lint/a11y/useFocusableInteractive: the combobox keeps focus.
            // biome-ignore lint/a11y/useKeyWithClickEvents: Enter in the field loads more.
            <div
              id={optionId(items.length)}
              role="option"
              aria-selected={current === items.length}
              className="palette__option palette__option--more"
              onPointerMove={() => setActive(items.length)}
              onClick={() => runAt(items.length)}
            >
              <span className="palette__label">
                {results.isFetchingNextPage ? t("common.loading") : t("shell.palette.more")}
              </span>
            </div>
          ) : null}
        </div>
        <p className="palette__status" role="status" aria-live="polite">
          {status}
        </p>
        <p className="palette__hint" aria-hidden="true">
          {t("shell.palette.hint")}
        </p>
      </div>
    </div>,
    document.body,
  );
}
