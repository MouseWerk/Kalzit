import { type KeyboardEvent, type ReactNode, useEffect, useId, useState } from "react";
import type { Frame } from "../api/generated/shapes";
import { Icon } from "../components/Icon";
import { Dialog } from "../features/dashboards/ui/Dialog";
import { useI18n } from "../i18n/i18n";
import { isComposingKey } from "../lib/ime";
import { readPreference, writePreference } from "../lib/storage";
import { formatValue } from "../panels/frame";
import type { StepType } from "./steps";
import "../features/dashboards/ui/shared.css";
import "../components/iconButton.css";
import "../shell/shellUx.css";
import "./analysis.css";

export type ShapeName = "graph" | "frame" | "documents" | "trace";

/** The shape a step reads, and the one it makes when that is another: "Graph → Table". */
export function ShapeChip({ from, to }: { from: ShapeName; to?: ShapeName | undefined }) {
  const { t } = useI18n();
  const name = (s: ShapeName) => t(`analysis.shape.${s}`);
  return (
    <span className="shape-chip">
      {to === undefined || to === from
        ? name(from)
        : t("analysis.shape.change", { from: name(from), to: name(to) })}
    </span>
  );
}

/** The six groups of table steps, in their fixed order (Parity board, frame 14). */
export const CATALOG_GROUPS = [
  "fields",
  "rows",
  "combine",
  "reshape",
  "calculate",
  "display",
] as const;
export type CatalogGroup = (typeof CATALOG_GROUPS)[number];

/** One kind of step in the catalog. */
export interface CatalogEntry {
  type: StepType;
  label: string;
  about: string;
  /** The longer text the preview shows; `about` when absent. */
  help?: string;
  /** Words that find the step besides its name and description; never shown but as a reason. */
  keywords?: readonly string[];
  from: ShapeName;
  to: ShapeName;
  /** The group of a table step. */
  group?: CatalogGroup;
  /** Marked "new". */
  isNew?: boolean;
  /** Where the step runs, in words. */
  where?: string;
  /** Why the step cannot be added now; such an entry is shown but not added. */
  unavailable?: string;
}

/** What the preview shows of a step on the person's own data. */
export type StepPreview =
  | { kind: "noData" }
  | { kind: "later" }
  | { kind: "frame"; frame: Frame }
  | { kind: "error"; reason: string };

/** Why an entry matches a search; the weight orders the hits. */
interface Hit {
  entry: CatalogEntry;
  weight: number;
  reason: "name" | "about" | { keyword: string };
}

const lower = (s: string) => s.toLocaleLowerCase();

/**
 * Whether `entry` matches `query`, and why: the whole query in the name, then in the
 * description, then a word of it in a keyword (or a keyword in the query). Null when it does not
 * match; every entry matches an empty query.
 */
export function matchEntry(entry: CatalogEntry, query: string): Hit | null {
  const needle = lower(query.trim());
  if (needle === "") return { entry, weight: 0, reason: "name" };
  if (lower(entry.label).includes(needle)) return { entry, weight: 3, reason: "name" };
  if (lower(entry.about).includes(needle) || lower(entry.help ?? "").includes(needle)) {
    return { entry, weight: 2, reason: "about" };
  }
  const words = needle.split(/\s+/).filter((w) => w.length >= 3);
  for (const keyword of entry.keywords ?? []) {
    const k = lower(keyword);
    if (k.includes(needle) || needle.includes(k) || words.some((w) => k.includes(w))) {
      return { entry, weight: 1, reason: { keyword } };
    }
  }
  return null;
}

/** The entries that match, best first, in catalog order among equals. */
export function searchEntries(entries: readonly CatalogEntry[], query: string): Hit[] {
  const hits = entries.map((e) => matchEntry(e, query)).filter((h): h is Hit => h !== null);
  return hits
    .map((h, i) => ({ h, i }))
    .sort((a, b) => b.h.weight - a.h.weight || a.i - b.i)
    .map(({ h }) => h);
}

const RECENT_KEY = "kalzit.steps.recent";
const MAX_RECENT = 5;

/** The step types added last, newest first (this browser only). */
export function recentSteps(): StepType[] {
  try {
    const parsed: unknown = JSON.parse(readPreference(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((v): v is StepType => typeof v === "string").slice(0, MAX_RECENT)
      : [];
  } catch {
    return [];
  }
}

function rememberStep(type: StepType): void {
  const next = [type, ...recentSteps().filter((t) => t !== type)].slice(0, MAX_RECENT);
  writePreference(RECENT_KEY, JSON.stringify(next));
}

/** What the person has before the new step, in words. */
export type BeforeStep =
  | { kind: "frame"; rows: number; fields: number }
  | { kind: "graph"; nodes: number; edges: number }
  | { kind: "trace"; count: number }
  | { kind: "none" };

/**
 * "+ Add step" and its catalog (Parity board, frame 14): a dialog with a search over names,
 * descriptions and keywords, the shapes there are steps for, the steps added last, the table
 * steps in six groups, and on the right a preview of the step under the pointer on the person's
 * own data. Focus starts in the search; Up and Down walk the list, Enter adds, Escape closes.
 */
export function StepCatalog({
  entries,
  shapes,
  before,
  sample,
  previewOf,
  onAdd,
}: {
  entries: readonly CatalogEntry[];
  /** The shapes there are steps for now, in order; the first one is chosen at first. */
  shapes: readonly ShapeName[];
  before: BeforeStep;
  /** The first rows of the result before the step, for the preview. */
  sample: Frame | undefined;
  previewOf: (type: StepType) => StepPreview;
  onAdd: (type: StepType) => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const label = t("analysis.steps.add");
  return (
    <div className="step-catalog">
      <button
        type="button"
        className="button button--ghost icon-button steps__add-button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <Icon name="plus" />
        <span className="icon-button__text">{label}</span>
      </button>
      {open ? (
        <CatalogDialog
          entries={entries}
          shapes={shapes}
          before={before}
          sample={sample}
          previewOf={previewOf}
          onClose={() => setOpen(false)}
          onAdd={(type) => {
            rememberStep(type);
            setOpen(false);
            onAdd(type);
          }}
        />
      ) : null}
    </div>
  );
}

function CatalogDialog({
  entries,
  shapes,
  before,
  sample,
  previewOf,
  onClose,
  onAdd,
}: {
  entries: readonly CatalogEntry[];
  shapes: readonly ShapeName[];
  before: BeforeStep;
  sample: Frame | undefined;
  previewOf: (type: StepType) => StepPreview;
  onClose: () => void;
  onAdd: (type: StepType) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [query, setQuery] = useState("");
  const [shape, setShape] = useState<ShapeName>(shapes[0] ?? "frame");
  const [active, setActive] = useState(0);
  const [recent] = useState(recentSteps);
  const shapeName = (s: ShapeName) => t(`analysis.shape.${s}`);
  const ofShape = entries.filter((e) => e.from === shape);
  const searching = query.trim() !== "";
  const hits = searchEntries(ofShape, query);
  // Without a search the list follows the groups; with one, the best hits come first.
  const grouped = !searching && shape === "frame";
  const ordered: Hit[] = grouped
    ? CATALOG_GROUPS.flatMap((g) => hits.filter((h) => h.entry.group === g))
    : hits;
  const current = ordered[Math.min(active, ordered.length - 1)]?.entry;
  // The previews of all steps on the sample, so the ones that do not fit show dimmed.
  // The previews of all steps on the sample, worked out once when the catalog opens (the data
  // does not change under an open dialog), so the ones that do not fit show dimmed.
  const [previews] = useState(() => new Map(entries.map((e) => [e.type, previewOf(e.type)])));
  const optionId = (type: StepType) => `${id}-${type}`;

  // A new search starts at its best hit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the active entry resets when the list changes
  useEffect(() => setActive(0), [query, shape]);

  function add(entry: CatalogEntry | undefined) {
    if (entry === undefined || entry.unavailable !== undefined) return;
    onAdd(entry.type);
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const n = ordered.length;
      if (n === 0) return;
      setActive((a) => (event.key === "ArrowDown" ? (a + 1) % n : (a - 1 + n) % n));
    } else if (event.key === "Enter" && !isComposingKey(event)) {
      event.preventDefault();
      add(current);
    }
  }

  /** Arrow keys move the choice of shape and the focus with it (one tab stop for the group). */
  function onShapeKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    const by =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (by === 0) return;
    event.preventDefault();
    const next = shapes[(shapes.indexOf(shape) + by + shapes.length) % shapes.length] ?? shape;
    setShape(next);
    const group = event.currentTarget.parentElement;
    const index = shapes.indexOf(next);
    requestAnimationFrame(() =>
      group?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[index]?.focus(),
    );
  }

  // Hits in the other shapes, for a search that finds nothing here.
  const elsewhere = searching
    ? shapes
        .filter((s) => s !== shape)
        .map((s) => ({
          shape: s,
          hits: searchEntries(
            entries.filter((e) => e.from === s),
            query,
          ),
        }))
        .filter((x) => x.hits.length > 0)
    : [];

  const option = (hit: Hit) => {
    const { entry } = hit;
    const index = ordered.indexOf(hit);
    const preview = previews.get(entry.type);
    const dim = entry.unavailable !== undefined || preview?.kind === "error";
    const reason =
      !searching || hit.reason === "name"
        ? null
        : hit.reason === "about"
          ? t("analysis.catalog.reason.about")
          : t("analysis.catalog.reason.keyword", { word: hit.reason.keyword });
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: the search field leads the list by keyboard (aria-activedescendant)
      <div
        key={entry.type}
        id={optionId(entry.type)}
        role="option"
        tabIndex={-1}
        aria-selected={index === active}
        aria-disabled={entry.unavailable !== undefined ? true : undefined}
        aria-describedby={`${optionId(entry.type)}-about`}
        className="step-catalog__option"
        data-dim={dim ? "true" : undefined}
        onPointerEnter={() => setActive(index)}
        onClick={() => add(entry)}
      >
        <span className="step-catalog__name">{entry.label}</span>
        {entry.isNew === true ? (
          <span className="step-catalog__new">{t("analysis.catalog.new")}</span>
        ) : null}
        <span className="step-catalog__about" id={`${optionId(entry.type)}-about`}>
          {entry.unavailable ?? entry.about}
        </span>
        {reason === null ? null : <span className="step-catalog__reason">{reason}</span>}
      </div>
    );
  };

  let list: ReactNode = null;
  const empty =
    ordered.length === 0 ? (
      <div className="step-catalog__empty" role="status">
        <p>
          {t("analysis.catalog.noMatchShape", { shape: shapeName(shape), query: query.trim() })}
        </p>
        {elsewhere.map((x) => (
          <p key={x.shape}>
            {t("analysis.catalog.otherShape", {
              count: x.hits.length,
              shape: shapeName(x.shape),
              names: x.hits.map((h) => h.entry.label).join(", "),
            })}{" "}
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => setShape(x.shape)}
            >
              {t("analysis.catalog.switchShape", { shape: shapeName(x.shape) })}
            </button>
          </p>
        ))}
        <button
          type="button"
          className="button button--ghost button--small"
          onClick={() => setQuery("")}
        >
          {t("analysis.catalog.clear")}
        </button>
      </div>
    ) : null;
  if (ordered.length === 0) {
    list = null;
  } else if (grouped) {
    list = CATALOG_GROUPS.map((g) => {
      const inGroup = ordered.filter((h) => h.entry.group === g);
      if (inGroup.length === 0) return null;
      return (
        // biome-ignore lint/a11y/useSemanticElements: a group of options inside a listbox
        <div key={g} role="group" aria-labelledby={`${id}-g-${g}`} className="step-catalog__group">
          <div className="step-catalog__heading" id={`${id}-g-${g}`} role="presentation">
            {t("analysis.catalog.groupCount", {
              group: t(`analysis.catalog.group.${g}`),
              count: inGroup.length,
            })}
          </div>
          <div className="step-catalog__grid">{inGroup.map(option)}</div>
        </div>
      );
    });
  } else {
    list = <div className="step-catalog__grid">{ordered.map(option)}</div>;
  }

  const recentHere = recent
    .map((type) => ofShape.find((e) => e.type === type))
    .filter((e): e is CatalogEntry => e !== undefined && e.unavailable === undefined);

  return (
    <Dialog
      title={t("analysis.steps.add")}
      onClose={onClose}
      size="large"
      backGuard={false}
      escapeKeepsInput={false}
      actions={
        <>
          <span className="step-catalog__keys" aria-hidden="true">
            <kbd className="kbd">{t("analysis.catalog.enterKey")}</kbd>
          </span>
          <button
            type="button"
            className="button button--primary"
            disabled={current === undefined || current.unavailable !== undefined}
            onClick={() => add(current)}
          >
            {t("analysis.catalog.addSelected")}
          </button>
        </>
      }
    >
      <div className="step-catalog__dialog">
        <label className="step-catalog__search">
          <Icon name="search" />
          <input
            type="search"
            className="step-catalog__input"
            value={query}
            placeholder={t("analysis.catalog.searchHint")}
            aria-label={t("analysis.catalog.search")}
            aria-controls={`${id}-list`}
            aria-activedescendant={current === undefined ? undefined : optionId(current.type)}
            data-autofocus
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={onSearchKeyDown}
          />
        </label>
        <div className="step-catalog__bar">
          {shapes.length > 1 ? (
            <div
              className="step-catalog__shapes"
              role="radiogroup"
              aria-label={t("analysis.catalog.shapes")}
            >
              <span className="field__hint">{t("analysis.catalog.for")}</span>
              {shapes.map((s) => (
                // biome-ignore lint/a11y/useSemanticElements: a segmented choice of buttons, as the board draws it
                <button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={s === shape}
                  tabIndex={s === shape ? 0 : -1}
                  className="button button--ghost button--small"
                  onClick={() => setShape(s)}
                  onKeyDown={onShapeKeyDown}
                >
                  {t("analysis.catalog.shapeCount", {
                    shape: shapeName(s),
                    count: entries.filter((e) => e.from === s).length,
                  })}
                </button>
              ))}
            </div>
          ) : null}
          <span className="field__hint step-catalog__before">
            {before.kind === "frame"
              ? t("analysis.catalog.before.frame", { rows: before.rows, fields: before.fields })
              : before.kind === "graph"
                ? t("analysis.catalog.before.graph", { nodes: before.nodes, edges: before.edges })
                : before.kind === "trace"
                  ? t("analysis.catalog.before.trace", { count: before.count })
                  : t("analysis.catalog.before.none")}
          </span>
        </div>
        <div className="step-catalog__columns">
          <div className="step-catalog__left">
            {searching || recentHere.length === 0 ? null : (
              <div className="step-catalog__recent">
                <span className="step-catalog__heading" id={`${id}-recent`}>
                  {t("analysis.catalog.recent")}
                </span>
                {/* biome-ignore lint/a11y/useSemanticElements: a row of quick picks */}
                <div className="step-catalog__chips" role="group" aria-labelledby={`${id}-recent`}>
                  {recentHere.map((e) => (
                    <button
                      key={e.type}
                      type="button"
                      className="button button--ghost button--small step-catalog__chip"
                      onClick={() => add(e)}
                    >
                      {e.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div
              id={`${id}-list`}
              role="listbox"
              aria-label={t("analysis.steps.add")}
              className="step-catalog__list"
            >
              {list}
            </div>
            {empty}
          </div>
          {current === undefined ? null : (
            <CatalogPreview
              entry={current}
              sample={sample}
              preview={previews.get(current.type) ?? { kind: "noData" }}
            />
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** Columns and rows the preview tables show. */
const PREVIEW_FIELDS = 4;
const PREVIEW_ROWS = 3;

function MiniTable({ frame, caption }: { frame: Frame; caption: string }) {
  const { language } = useI18n();
  const fields = frame.fields.slice(0, PREVIEW_FIELDS);
  const rows = Math.min(frame.fields[0]?.values.length ?? 0, PREVIEW_ROWS);
  return (
    <table className="data-table step-catalog__table">
      <caption className="step-catalog__heading">{caption}</caption>
      <thead>
        <tr>
          {fields.map((f, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: field names may repeat
            <th key={i} scope="col">
              {f.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: rows }, (_, row) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no identity
          <tr key={row}>
            {fields.map((f, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: field names may repeat
              <td key={i}>{formatValue(f.type, f.values[row], language)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CatalogPreview({
  entry,
  sample,
  preview,
}: {
  entry: CatalogEntry;
  sample: Frame | undefined;
  preview: StepPreview;
}) {
  const { t } = useI18n();
  const id = useId();
  return (
    <aside className="step-catalog__preview" aria-labelledby={`${id}-title`}>
      <h3 className="step-catalog__preview-title" id={`${id}-title`}>
        {entry.label}
      </h3>
      <p className="step-catalog__help">{entry.help ?? entry.about}</p>
      <p className="step-catalog__flow">
        <ShapeChip from={entry.from} to={entry.to} />
        {entry.where === undefined ? null : <span className="field__hint">{entry.where}</span>}
      </p>
      {entry.unavailable !== undefined ? (
        <p className="field__hint">{entry.unavailable}</p>
      ) : preview.kind === "noData" ? (
        <p className="field__hint">{t("analysis.catalog.previewNoData")}</p>
      ) : preview.kind === "later" ? (
        <p className="field__hint">{t("analysis.catalog.previewLater")}</p>
      ) : (
        <>
          {sample === undefined ? null : (
            <MiniTable frame={sample} caption={t("analysis.catalog.beforeData")} />
          )}
          {preview.kind === "frame" ? (
            <MiniTable frame={preview.frame} caption={t("analysis.catalog.afterData")} />
          ) : (
            <p className="field__hint">
              {t("analysis.catalog.doesNotFit", { reason: preview.reason })}
            </p>
          )}
          <p className="field__hint">{t("analysis.catalog.previewNote")}</p>
        </>
      )}
    </aside>
  );
}
