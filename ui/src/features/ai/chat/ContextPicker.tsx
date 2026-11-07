import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "../../../components/Icon";
import { useI18n } from "../../../i18n/i18n";
import { isComposingKey } from "../../../lib/ime";
import { DASHBOARDS_KEY, fetchDashboards } from "../../dashboards/api";
import "./chat.css";

/** A dashboard a question is asked about. */
export interface ChatContext {
  id: string;
  title: string;
}

/** Pause in typing after which the dashboard search runs. */
const SEARCH_DELAY_MS = 250;
/** Dashboards the picker lists at once. */
const SHOWN = 8;

/**
 * "Dashboard als Kontext" (board DataChat.dc.html): finds a dashboard the person may read by its
 * title and picks it as the context of the next questions. The server checks the right again
 * when the question is sent. The search takes the focus when the picker opens; Escape anywhere in
 * the picker closes it.
 */
export function ContextPicker({
  orgId,
  onPick,
  onClose,
}: {
  orgId: string;
  onPick: (context: ChatContext) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const listId = useId();
  const [search, setSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    searchRef.current?.focus();
  }, []);
  const [q, setQ] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(search.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [search]);
  const found = useQuery({
    queryKey: [DASHBOARDS_KEY, orgId, "ask-context", q],
    queryFn: ({ signal }) => fetchDashboards(orgId, q === "" ? {} : { q }, signal),
    placeholderData: keepPreviousData,
  });
  const items = (found.data?.items ?? []).slice(0, SHOWN);
  return (
    <fieldset
      className="ask-composer__picker"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !isComposingKey(event)) {
          event.preventDefault();
          // Closes the picker only, not the answer that is running.
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <legend className="visually-hidden">{t("ai.chat.contextButton")}</legend>
      <label className="ask-history-page__search">
        <Icon name="search" />
        <span className="visually-hidden">{t("ai.chat.contextSearch")}</span>
        <input
          ref={searchRef}
          type="search"
          className="ask-history-page__input"
          placeholder={t("ai.chat.contextSearch")}
          value={search}
          aria-controls={listId}
          onChange={(event) => setSearch(event.target.value)}
        />
      </label>
      <ul id={listId} className="ask-history" aria-label={t("ai.chat.contextList")}>
        {items.map((dashboard) => (
          <li key={dashboard.id}>
            <button
              type="button"
              className="ask-suggestion"
              onClick={() => onPick({ id: dashboard.id, title: dashboard.title })}
            >
              {dashboard.title}
            </button>
          </li>
        ))}
      </ul>
      {found.isSuccess && items.length === 0 ? (
        <p className="ask-result__note">{t("ai.chat.contextNone")}</p>
      ) : null}
    </fieldset>
  );
}
