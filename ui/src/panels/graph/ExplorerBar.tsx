import { useId, useState } from "react";
import { ConfirmDialog } from "../../features/dashboards/ui/Dialog";
import { useI18n } from "../../i18n/i18n";
import { type Direction, MAX_EXPAND_LIMIT } from "./adapter";
import type { Explorer, StepSettings } from "./useExplorer";
import "./graph.css";
import "../../features/dashboards/ui/shared.css";

/** Taking back this many steps or more at once asks first. */
export const CONFIRM_STEPS = 3;

const DIRECTIONS: readonly Direction[] = ["both", "out", "in"];

/**
 * The explorer's steps and the settings of the next one (Graph board, frame 2A): the query's
 * result and each step as a breadcrumb, where a click on an earlier entry takes back every later
 * step; the step still loading at the end, with Cancel; Undo and Start over; then limit, edge
 * types and direction for the next step.
 */
export function ExplorerBar({
  explorer,
  baseNodes,
  edgeTypes,
  onBack,
  onOpenQuery,
  queryNote,
}: {
  explorer: Explorer;
  /** Nodes of the query's own result, for its entry. */
  baseNodes: number;
  /** Edge types in the graph, offered for the next step. */
  edgeTypes: readonly string[];
  /** A step was taken back (for the announcement). */
  onBack: (removed: number) => void;
  /** Opens the exploration as a query in Explore; absent where that is not possible. */
  onOpenQuery: (() => void) | null;
  /** Why the exploration cannot open as a query (too many nodes), or null. */
  queryNote: string | null;
}) {
  const { t, language } = useI18n();
  const number = new Intl.NumberFormat(language);
  const limitId = useId();
  const directionId = useId();
  const [confirm, setConfirm] = useState<number | null>(null);
  const { steps, pending, settings } = explorer;
  const [limitText, setLimitText] = useState(String(settings.limit));
  const set = (patch: Partial<StepSettings>) => explorer.setSettings({ ...settings, ...patch });

  function backTo(count: number) {
    const removed = steps.length - count;
    if (removed <= 0) return;
    if (removed >= CONFIRM_STEPS) {
      setConfirm(count);
      return;
    }
    explorer.backTo(count);
    onBack(removed);
  }

  const allTypes = settings.types.length === 0;
  return (
    <section className="graph-steps" aria-label={t("graph.steps.title")}>
      <div className="graph-steps__row">
        <ol className="graph-steps__list">
          <li>
            <button
              type="button"
              className="graph-steps__step"
              aria-current={steps.length === 0 && pending === null ? "step" : undefined}
              onClick={() => backTo(0)}
            >
              {t("graph.steps.base", { count: number.format(baseNodes) })}
            </button>
          </li>
          {steps.map((step, i) => (
            <li key={step.id}>
              <button
                type="button"
                className="graph-steps__step"
                aria-current={i === steps.length - 1 && pending === null ? "step" : undefined}
                onClick={() => backTo(i + 1)}
              >
                {step.total === null
                  ? t("graph.steps.step", {
                      name: step.caption,
                      count: number.format(step.loaded),
                    })
                  : t("graph.steps.stepOf", {
                      name: step.caption,
                      count: number.format(step.loaded),
                      total: number.format(step.total),
                    })}
              </button>
            </li>
          ))}
          {pending === null ? null : (
            <li className="graph-steps__pending" aria-live="polite">
              <span>{t("graph.steps.loading", { name: pending.caption })}</span>
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => explorer.cancel()}
              >
                {t("graph.steps.cancel")}
              </button>
            </li>
          )}
        </ol>
        <div className="graph-steps__actions">
          <button
            type="button"
            className="button button--ghost button--small"
            disabled={steps.length === 0 && pending === null}
            aria-keyshortcuts="Control+Z"
            onClick={() => {
              const had = steps.length;
              explorer.undo();
              if (pending === null && had > 0) onBack(1);
            }}
          >
            {t("graph.steps.undo")}
          </button>
          <button
            type="button"
            className="button button--ghost button--small"
            disabled={steps.length === 0}
            onClick={() => backTo(0)}
          >
            {t("graph.steps.reset")}
          </button>
        </div>
      </div>
      <div className="graph-steps__next">
        <div className="graph-steps__field">
          <label className="field__label" htmlFor={limitId}>
            {t("graph.steps.limit")}
          </label>
          <input
            id={limitId}
            className="input graph-steps__limit"
            inputMode="numeric"
            value={limitText}
            aria-describedby={`${limitId}-hint`}
            aria-invalid={
              /^\d+$/.test(limitText) &&
              Number(limitText) >= 1 &&
              Number(limitText) <= MAX_EXPAND_LIMIT
                ? undefined
                : true
            }
            onChange={(event) => {
              const next = event.currentTarget.value;
              setLimitText(next);
              const n = Number(next);
              if (/^\d+$/.test(next.trim()) && n >= 1 && n <= MAX_EXPAND_LIMIT) set({ limit: n });
            }}
          />
        </div>
        {edgeTypes.length === 0 ? null : (
          <fieldset className="graph-steps__types">
            <legend className="field__label">{t("graph.steps.types")}</legend>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={allTypes}
                onChange={() => set({ types: [] })}
                disabled={allTypes}
              />
              {t("graph.steps.allTypes", { count: number.format(edgeTypes.length) })}
            </label>
            {edgeTypes.map((type) => (
              <label key={type} className="checkbox graph-steps__type">
                <input
                  type="checkbox"
                  checked={!allTypes && settings.types.includes(type)}
                  onChange={(event) => {
                    const on = event.currentTarget.checked;
                    const next = on
                      ? [...settings.types, type]
                      : settings.types.filter((x) => x !== type);
                    set({ types: next.length === edgeTypes.length ? [] : next });
                  }}
                />
                {type}
              </label>
            ))}
          </fieldset>
        )}
        <div className="graph-steps__field">
          <label className="field__label" htmlFor={directionId}>
            {t("graph.steps.direction")}
          </label>
          <select
            id={directionId}
            className="select"
            value={settings.direction}
            onChange={(event) => set({ direction: event.currentTarget.value as Direction })}
          >
            {DIRECTIONS.map((d) => (
              <option key={d} value={d}>
                {t(`graph.steps.direction.${d}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <p className="graph__note" id={`${limitId}-hint`}>
        {t("graph.steps.limitHint", { max: number.format(MAX_EXPAND_LIMIT) })}{" "}
        {t("graph.steps.yours")}
      </p>
      {queryNote === null ? null : <p className="graph__note">{queryNote}</p>}
      {onOpenQuery === null ? null : (
        <div>
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={onOpenQuery}
          >
            {t("graph.steps.openQuery")}
          </button>
        </div>
      )}
      {confirm === null ? null : (
        <ConfirmDialog
          title={t("graph.steps.confirmTitle")}
          confirmLabel={t("graph.steps.confirm", {
            count: number.format(steps.length - confirm),
          })}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const removed = steps.length - confirm;
            explorer.backTo(confirm);
            setConfirm(null);
            onBack(removed);
          }}
        >
          {t("graph.steps.confirmText", { count: number.format(steps.length - confirm) })}
        </ConfirmDialog>
      )}
    </section>
  );
}
