import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type KeyboardEvent, useEffect, useId, useState } from "react";
import { FormAlert } from "../../components/FormAlert";
import { useI18n } from "../../i18n/i18n";
import { isComposingKey } from "../../lib/ime";
import { relativeTime } from "../../shell/startData";
import { Dialog } from "../dashboards/ui/Dialog";
import { errorMessage } from "../dashboards/ui/errors";
import { ANALYSES_KEY, type Analysis, fetchAnalyses } from "./api";
import "./analyses.css";

const SEARCH_DELAY_MS = 150;
const OPEN_LIMIT = 20;

/**
 * Explore's "Open" (Ctrl+O): the saved analyses as a quick picker, newest change first. Typing
 * filters, Up and Down move, Enter opens. Analyses whose data source the user may not query are
 * listed but cannot be opened here, as in the list.
 */
export function OpenDialog({
  orgId,
  onOpen,
  onClose,
}: {
  orgId: string;
  onOpen: (analysis: Analysis) => void;
  onClose: () => void;
}) {
  const { t, language } = useI18n();
  const ids = useId();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(text.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [text]);
  const list = useQuery({
    queryKey: [ANALYSES_KEY, orgId, "open", q],
    queryFn: ({ signal }) =>
      fetchAnalyses(orgId, { q, sort: "updated", limit: OPEN_LIMIT }, signal),
    placeholderData: keepPreviousData,
  });
  const items = list.data?.items ?? [];
  const current = Math.min(active, Math.max(items.length - 1, 0));
  const relative = new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "short" });
  const now = Date.now();

  function open(item: Analysis | undefined) {
    if (item?.mayQuery === true) {
      onOpen(item);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (isComposingKey(event)) {
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive(Math.min(current + 1, items.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive(Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      open(items[current]);
    }
  }

  return (
    <Dialog
      title={t("analyses.open.title")}
      onClose={onClose}
      actions={
        <>
          <Link to="/explore/saved" search={{}} className="button button--ghost" onClick={onClose}>
            {t("analyses.open.all")}
          </Link>
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("analyses.dialog.cancel")}
          </button>
        </>
      }
    >
      <div className="analysis-open">
        <label className="visually-hidden" htmlFor={`${ids}-search`}>
          {t("analyses.list.search")}
        </label>
        <input
          id={`${ids}-search`}
          type="search"
          className="input"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${ids}-list`}
          aria-activedescendant={items.length === 0 ? undefined : `${ids}-${current}`}
          placeholder={t("analyses.list.search")}
          value={text}
          onChange={(event) => {
            setText(event.currentTarget.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          autoComplete="off"
          data-autofocus
        />
        {list.isError ? <FormAlert>{errorMessage(t, list.error)}</FormAlert> : null}
        <div
          id={`${ids}-list`}
          className="analysis-picker__options analysis-open__list"
          role="listbox"
          aria-label={t("analyses.open.options")}
        >
          {items.map((item, index) => (
            // biome-ignore lint/a11y/useFocusableInteractive: the search field keeps focus (aria-activedescendant).
            // biome-ignore lint/a11y/useKeyWithClickEvents: Enter in the search field opens the active option.
            <div
              key={item.id}
              id={`${ids}-${index}`}
              role="option"
              className="analysis-picker__option"
              aria-selected={index === current}
              aria-disabled={item.mayQuery ? undefined : true}
              onClick={() => open(item)}
            >
              <span className="analysis-row__title">
                <span className="truncate" title={item.title}>
                  {item.title}
                </span>
                <span className="analysis-row__detail">
                  {item.mayQuery
                    ? relativeTime(relative, item.updatedAt, now, t("analyses.justNow"))
                    : t("analyses.picker.noQueryRight")}
                </span>
              </span>
            </div>
          ))}
        </div>
        {list.isPending || items.length > 0 ? null : (
          <p className="field__hint">
            {q === "" ? t("analyses.open.empty") : t("analyses.empty.search", { q })}
          </p>
        )}
      </div>
    </Dialog>
  );
}
