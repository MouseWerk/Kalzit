import { useEffect, useId, useRef } from "react";
import { Icon } from "../../../components/Icon";
import { IconButton } from "../../../components/IconButton";
import { useI18n } from "../../../i18n/i18n";
import { isComposingKey } from "../../../lib/ime";
import { SEARCH_LIST, type SearchHit, type SearchScope, snippet } from "./search";
import "./canvas.css";

export interface SearchBoxProps {
  query: string;
  onQuery: (query: string) => void;
  scope: SearchScope;
  onScope: (scope: SearchScope) => void;
  hits: readonly SearchHit[];
  /** The hit jumped to last; -1 before the first jump. */
  current: number;
  /** Jumps to a hit: selects it and moves the canvas there. */
  onJump: (index: number) => void;
  onClose: () => void;
  /** What a hit needs before it can be shown: it is hidden, or inside a closed group. */
  noteOf: (hit: SearchHit) => string | null;
  /** How many nodes the panel has loaded: what the search looks through. */
  nodes: number;
  /** In the table view the field filters the rows; there is no jumping and no list. */
  filterOnly?: boolean;
}

/**
 * The search on the canvas (Graph 0.8.1 board, frame 5): a field with the count and the two
 * arrows, the hits with the place they matched underlined (not colored), and three switches for
 * what is searched. Enter jumps to the next hit, Shift+Enter to the one before, Escape closes and
 * leaves the selection. It sees only what the panel has loaded.
 */
export function SearchBox({
  query,
  onQuery,
  scope,
  onScope,
  hits,
  current,
  onJump,
  onClose,
  noteOf,
  nodes,
  filterOnly = false,
}: SearchBoxProps) {
  const { t, language } = useI18n();
  const number = new Intl.NumberFormat(language);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();
  const listId = useId();
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  const searched = query.trim() !== "";
  const step = (by: 1 | -1) => {
    if (hits.length === 0) return;
    onJump(
      ((((current < 0 && by < 0 ? 0 : current) + by) % hits.length) + hits.length) % hits.length,
    );
  };
  const countText = !searched
    ? ""
    : hits.length === 0
      ? t("graphCanvas.search.none")
      : filterOnly || current < 0
        ? t("graphCanvas.search.hits", { count: number.format(hits.length) })
        : t("graphCanvas.search.position", {
            at: number.format(current + 1),
            count: number.format(hits.length),
          });
  const toggle = (name: keyof SearchScope) => onScope({ ...scope, [name]: !scope[name] });
  return (
    <search className="graph-search" aria-label={t("graphCanvas.search.label")}>
      <div className="graph-search__field">
        <Icon name="search" />
        <label className="visually-hidden" htmlFor={inputId}>
          {t(filterOnly ? "graphCanvas.search.inTable" : "graphCanvas.search.label")}
        </label>
        <input
          ref={inputRef}
          id={inputId}
          className="graph-search__input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={query}
          placeholder={t(
            filterOnly ? "graphCanvas.search.inTable" : "graphCanvas.search.placeholder",
          )}
          aria-controls={filterOnly ? undefined : listId}
          onChange={(event) => onQuery(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (isComposingKey(event)) return;
            // The field's keys stay in the field: no letter reaches the canvas shortcuts.
            event.stopPropagation();
            if (event.key === "Enter" && !filterOnly) {
              event.preventDefault();
              step(event.shiftKey ? -1 : 1);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <output className="graph-search__count" htmlFor={inputId}>
          {countText}
        </output>
        {filterOnly ? null : (
          <>
            <IconButton
              icon="chevronUp"
              label={t("graphCanvas.search.previous")}
              shortcut={["Shift", "Enter"]}
              disabled={hits.length === 0}
              onClick={() => step(-1)}
            />
            <IconButton
              icon="chevronDown"
              label={t("graphCanvas.search.next")}
              shortcut={["Enter"]}
              disabled={hits.length === 0}
              onClick={() => step(1)}
            />
          </>
        )}
        <IconButton icon="close" label={t("graphCanvas.search.close")} onClick={onClose} />
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: three toggle buttons, not a field set */}
      <div className="graph-search__scope" role="group" aria-label={t("graphCanvas.search.scope")}>
        {(["captions", "properties", "edges"] as const).map((name) => (
          <button
            key={name}
            type="button"
            className="graph-search__chip"
            aria-pressed={scope[name]}
            onClick={() => toggle(name)}
          >
            {t(`graphCanvas.search.scope.${name}`)}
          </button>
        ))}
      </div>
      {filterOnly || !searched ? null : hits.length === 0 ? (
        <p className="graph-search__note">
          {t("graphCanvas.search.nothing", { count: number.format(nodes) })}
        </p>
      ) : (
        <>
          <ul className="graph-search__hits" id={listId}>
            {hits.slice(0, SEARCH_LIST).map((hit, index) => {
              const part = snippet(hit);
              const note = noteOf(hit);
              return (
                <li key={`${hit.kind}:${hit.index}`}>
                  <button
                    type="button"
                    className="graph-search__hit"
                    aria-current={index === current ? "true" : undefined}
                    onClick={() => onJump(index)}
                  >
                    <span className="graph-search__name">
                      {hit.property === null ? <Marked part={part} /> : hit.caption}
                    </span>
                    <span className="graph-search__where">
                      {hit.label === "" ? t("graph.cluster.unlabelled") : hit.label}
                      {hit.property === null ? null : (
                        <>
                          {" · "}
                          {hit.property}
                          {": "}
                          <Marked part={part} />
                        </>
                      )}
                      {note === null ? null : ` · ${note}`}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          {hits.length > SEARCH_LIST ? (
            <p className="graph-search__note">
              {t("graphCanvas.search.listed", {
                shown: number.format(SEARCH_LIST),
                count: number.format(hits.length),
              })}
            </p>
          ) : null}
        </>
      )}
    </search>
  );
}

/** A hit's text with the place it matched underlined. */
function Marked({ part }: { part: ReturnType<typeof snippet> }) {
  return (
    <>
      {part.cutBefore ? "… " : ""}
      {part.before}
      <mark className="graph-search__mark">{part.match}</mark>
      {part.after}
      {part.cutAfter ? " …" : ""}
    </>
  );
}
