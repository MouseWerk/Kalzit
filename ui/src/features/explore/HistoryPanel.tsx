import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { useI18n } from "../../i18n/i18n";
import { relativeTime } from "../../shell/startData";
import { ConfirmDialog } from "../admin/components/Dialog";
import { errorMessage } from "../dashboards/ui/errors";
import type { DatasourceSummary } from "../datasources/api";
import { KindMark } from "../datasources/kindMarks";
import {
  clearHistory,
  deleteHistoryEntry,
  HISTORY_KEY,
  type HistoryEntry,
  historyQuery,
} from "./history";
import "./explore.css";

/** How long typing pauses before the search goes to the server. */
const SEARCH_DELAY_MS = 250;

/** The query as one line of text for the list: the SQL or expression, else its JSON. */
export function queryPreview(query: unknown): string {
  const flat = (text: string) => text.replace(/\s+/g, " ").trim();
  if (typeof query === "string") {
    return flat(query);
  }
  if (typeof query === "object" && query !== null) {
    const q = query as Record<string, unknown>;
    for (const key of ["sql", "expr", "cypher", "query"]) {
      const value = q[key];
      if (typeof value === "string") {
        return flat(value);
      }
    }
  }
  return JSON.stringify(query) ?? "";
}

/** `value`, a moment after it stopped changing. */
function useDebounced(value: string, delay: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/**
 * The caller's own Explore history in a side panel: search, filter by data source, load an entry
 * into the editor, run it again, delete one or all. Only the caller sees it, for 30 days.
 */
export function HistoryPanel({
  orgId,
  sources,
  onLoad,
  onRun,
  onClose,
}: {
  orgId: string;
  /** The sources the caller may query, for the filter. */
  sources: readonly DatasourceSummary[];
  onLoad: (entry: HistoryEntry) => void;
  onRun: (entry: HistoryEntry) => void;
  onClose: () => void;
}) {
  const { t, language } = useI18n();
  const client = useQueryClient();
  const titleId = useId();
  const searchId = useId();
  const sourceId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [text, setText] = useState("");
  const [datasourceId, setDatasourceId] = useState("");
  const [confirming, setConfirming] = useState(false);
  // Where focus goes once a deleted entry is gone from the list: the entry that took its place.
  const [focusAfter, setFocusAfter] = useState<{ removed: string; next: string | null } | null>(
    null,
  );
  const search = useDebounced(text.trim(), SEARCH_DELAY_MS);
  const history = useInfiniteQuery(historyQuery(orgId, { datasourceId, text: search }));
  const refresh = () => client.invalidateQueries({ queryKey: [HISTORY_KEY, orgId] });
  const removeOne = useMutation({
    mutationFn: (id: string) => deleteHistoryEntry(orgId, id),
    onSettled: refresh,
  });
  const removeAll = useMutation({
    mutationFn: () => clearHistory(orgId),
    onSuccess: () => {
      setConfirming(false);
      searchRef.current?.focus();
    },
    onSettled: refresh,
  });
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "short" });
  const now = Date.now();
  const entries = history.data?.pages.flatMap((page) => page.items) ?? [];
  const filtered = text.trim() !== "" || datasourceId !== "";

  // The panel opens with its heading focused, so a screen reader starts at its name.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    if (focusAfter === null || entries.some((entry) => entry.id === focusAfter.removed)) {
      return;
    }
    const target =
      focusAfter.next === null
        ? null
        : listRef.current?.querySelector<HTMLElement>(
            `[data-entry="${CSS.escape(focusAfter.next)}"]`,
          );
    (target ?? searchRef.current)?.focus();
    setFocusAfter(null);
  }, [entries, focusAfter]);

  function remove(entry: HistoryEntry) {
    const index = entries.findIndex((e) => e.id === entry.id);
    const neighbour = entries[index + 1] ?? entries[index - 1];
    setFocusAfter({ removed: entry.id, next: neighbour?.id ?? null });
    removeOne.mutate(entry.id);
  }

  const failedId = removeOne.isError ? removeOne.variables : undefined;

  return (
    <aside className="explore-history" aria-labelledby={titleId}>
      <div className="explore-history__head">
        <h2 id={titleId} ref={headingRef} tabIndex={-1}>
          {t("explore.history.title")}
        </h2>
        <IconButton icon="close" label={t("explore.history.close")} onClick={onClose} />
      </div>
      <p className="explore-history__note">{t("explore.history.note")}</p>
      <p className="explore-history__note">{t("explore.history.noteText")}</p>
      <div className="explore-history__filters">
        <div className="preference">
          <label htmlFor={searchId}>{t("explore.history.search")}</label>
          <input
            id={searchId}
            ref={searchRef}
            className="input"
            type="search"
            value={text}
            maxLength={100}
            onChange={(event) => setText(event.currentTarget.value)}
          />
        </div>
        <div className="preference">
          <label htmlFor={sourceId}>{t("explore.history.source")}</label>
          <select
            id={sourceId}
            className="select"
            value={datasourceId}
            onChange={(event) => setDatasourceId(event.currentTarget.value)}
          >
            <option value="">{t("explore.history.allSources")}</option>
            {sources.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
          </select>
        </div>
      </div>
      {history.isPending ? (
        <p className="loading">{t("common.loading")}</p>
      ) : history.isError ? (
        <p className="field__error" role="alert">
          {errorMessage(t, history.error)}
        </p>
      ) : entries.length === 0 ? (
        <p className="explore-history__empty">
          {filtered ? t("explore.history.noMatch") : t("explore.history.empty")}
        </p>
      ) : (
        <ul className="explore-history__list" ref={listRef} aria-label={t("explore.history.title")}>
          {entries.map((entry) => {
            const preview = queryPreview(entry.query);
            const errorId = `${titleId}-error-${entry.id}`;
            return (
              <li key={entry.id} className="explore-history__item">
                <button
                  type="button"
                  className="explore-history__load"
                  data-entry={entry.id}
                  onClick={() => onLoad(entry)}
                  aria-label={t("explore.history.load", { query: preview })}
                >
                  <span className="explore-history__source">
                    <KindMark kind={entry.datasourceKind} small />
                    <span>{entry.datasourceName}</span>
                  </span>
                  <code className="explore-history__query">{preview}</code>
                  <span className="explore-history__meta">
                    <span>
                      {relativeTime(format, entry.createdAt, now, t("explore.history.justNow"))}
                    </span>
                    {entry.rowCount === null ? null : (
                      <span>{t("explore.history.rows", { count: entry.rowCount })}</span>
                    )}
                  </span>
                </button>
                <div className="explore-history__actions">
                  <IconButton
                    icon="refresh"
                    label={t("explore.history.run", { query: preview })}
                    onClick={() => onRun(entry)}
                  />
                  <IconButton
                    icon="trash"
                    label={t("explore.history.delete", { query: preview })}
                    onClick={() => remove(entry)}
                    aria-describedby={failedId === entry.id ? errorId : undefined}
                  />
                </div>
                {failedId === entry.id ? (
                  <p className="field__error explore-history__error" id={errorId} role="alert">
                    {errorMessage(t, removeOne.error)}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {history.hasNextPage ? (
        <button
          type="button"
          className="button button--secondary button--small"
          disabled={history.isFetchingNextPage}
          onClick={() => void history.fetchNextPage()}
        >
          {history.isFetchingNextPage ? t("common.loading") : t("explore.history.more")}
        </button>
      ) : null}
      <div className="explore-history__foot">
        <button
          type="button"
          className="button button--secondary button--small"
          disabled={entries.length === 0 && !filtered}
          onClick={() => setConfirming(true)}
        >
          <Icon name="trash" />
          {t("explore.history.clear")}
        </button>
      </div>
      <ConfirmDialog
        open={confirming}
        title={t("explore.history.clear")}
        confirmLabel={t("explore.history.clearConfirm")}
        busy={removeAll.isPending}
        error={removeAll.isError ? errorMessage(t, removeAll.error) : undefined}
        onConfirm={() => removeAll.mutate()}
        onClose={() => setConfirming(false)}
      >
        {t("explore.history.clearText")}
      </ConfirmDialog>
    </aside>
  );
}
