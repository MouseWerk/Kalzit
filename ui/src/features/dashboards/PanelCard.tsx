import { type KeyboardEvent, type PointerEvent, useEffect, useId, useRef, useState } from "react";
import type { TimeRange } from "../../api/generated/shapes";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { parseFieldConfig } from "../../panels/fieldConfig/fieldConfig";
import { usePatternEngine, usesPatterns } from "../../panels/fieldConfig/pattern";
import { getPanel } from "../../panels/registry";
// PanelBody's own layout; Explore shows it without the dashboard stylesheet.
import "../../panels/panels.css";
import { EmptyPanel } from "../../panels/shared";
import { useStyleVars } from "../../panels/styleVars";
import { queryText } from "../datasources/queryKinds";
import "./dashboards.css";
import type { GridPos, PanelModel } from "./model";
import { errorsOf, framesOf, isTruncated, otherShapes, type TargetOutcome } from "./results";
import { Dialog } from "./ui/Dialog";
import { errorBodyMessage, errorMessage } from "./ui/errors";
import { Inspect } from "./ui/Inspect";
import { type PanelQueryInput, usePanelResults } from "./usePanelResults";

/** The width at which dashboards.css switches to one column. */
const SINGLE_COLUMN = "(max-width: 48rem)";

export interface PanelEditActions {
  onEdit: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  /** A new position or size; the grid pushes overlapped panels down. */
  onGrid: (grid: GridPos, byKeyboard: boolean) => void;
  /** Size of one grid cell in px, for turning a pointer drag into cells. */
  cellSize: () => { width: number; height: number };
}

interface PanelCardProps {
  query: Omit<PanelQueryInput, "panel">;
  panel: PanelModel;
  /** Present in edit mode. */
  edit?: PanelEditActions | undefined;
}

/** One panel in the grid: title bar, its own query state, and the visualization. */
export function PanelCard({ query, panel, edit }: PanelCardProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  const hintId = useId();
  const [inspecting, setInspecting] = useState(false);
  const handleRef = useRef<HTMLButtonElement>(null);
  const keepHandleFocus = useRef(false);

  // A keyboard move can change the panel's place in reading order, and moving a focused element
  // in the document drops its focus; the handle takes it back so arrow keys keep working.
  useEffect(() => {
    if (keepHandleFocus.current && document.activeElement !== handleRef.current) {
      handleRef.current?.focus();
    }
    keepHandleFocus.current = false;
  });
  const results = usePanelResults({ ...query, panel });
  const title = panel.title === "" ? t("dashboards.panel.untitled") : panel.title;

  useStyleVars(ref, {
    "--col": panel.grid.x + 1,
    "--row": panel.grid.y + 1,
    "--w": panel.grid.w,
    "--h": panel.grid.h,
  });

  function onHandleKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (edit === undefined) {
      return;
    }
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const step = delta[event.key];
    if (step === undefined) {
      return;
    }
    event.preventDefault();
    const [dx, dy] = step;
    const { x, y, w, h } = panel.grid;
    keepHandleFocus.current = true;
    edit.onGrid(
      event.shiftKey ? { x, y, w: w + dx, h: h + dy } : { x: x + dx, y: y + dy, w, h },
      true,
    );
  }

  function startDrag(event: PointerEvent<HTMLElement>, mode: "move" | "resize") {
    // Small screens show every panel full width in one column, where dragging across columns
    // would move panels nobody can see move; the arrange button works there.
    const singleColumn =
      typeof window.matchMedia === "function" && window.matchMedia(SINGLE_COLUMN).matches;
    if (edit === undefined || event.button !== 0 || singleColumn) {
      return;
    }
    event.preventDefault();
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, y: event.clientY, grid: { ...panel.grid } };
    const cell = edit.cellSize();
    let last = `${start.grid.x},${start.grid.y},${start.grid.w},${start.grid.h}`;
    const onMove = (move: globalThis.PointerEvent) => {
      const dx = Math.round((move.clientX - start.x) / cell.width);
      const dy = Math.round((move.clientY - start.y) / cell.height);
      const g = start.grid;
      const next =
        mode === "move" ? { ...g, x: g.x + dx, y: g.y + dy } : { ...g, w: g.w + dx, h: g.h + dy };
      const key = `${next.x},${next.y},${next.w},${next.h}`;
      if (key !== last) {
        last = key;
        edit.onGrid(next, false);
      }
    };
    const onUp = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  }

  const outcomes = results.data ?? [];

  return (
    <article
      ref={ref}
      className={edit === undefined ? "panel-card" : "panel-card panel-card--editing"}
      aria-labelledby={titleId}
      aria-busy={results.isFetching}
    >
      <header
        className="panel-card__header"
        onPointerDown={edit === undefined ? undefined : (event) => startDrag(event, "move")}
      >
        <h2 className="panel-card__title truncate" id={titleId} title={title}>
          {title}
        </h2>
        <div className="panel-card__actions">
          {edit === undefined ? null : (
            <>
              <button
                type="button"
                ref={handleRef}
                className="button button--ghost button--small panel-card__handle"
                aria-describedby={hintId}
                aria-label={t("dashboards.panel.arrange", { title })}
                title={t("dashboards.panel.arrangeHint")}
                onKeyDown={onHandleKey}
              >
                <span aria-hidden="true">⠿</span>
              </button>
              <span className="visually-hidden" id={hintId}>
                {t("dashboards.panel.arrangeHint")}
              </span>
            </>
          )}
          <button
            type="button"
            className="button button--ghost button--small"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setInspecting(true)}
            aria-label={t("dashboards.panel.inspectNamed", { title })}
            disabled={results.data === undefined}
          >
            {t("dashboards.panel.inspect")}
          </button>
          {edit === undefined ? null : (
            <>
              <button
                type="button"
                className="button button--ghost button--small"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={edit.onEdit}
                aria-label={t("dashboards.panel.editNamed", { title })}
              >
                {t("dashboards.panel.edit")}
              </button>
              <button
                type="button"
                className="button button--ghost button--small"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={edit.onDuplicate}
                aria-label={t("dashboards.panel.duplicateNamed", { title })}
              >
                {t("dashboards.panel.duplicate")}
              </button>
              <button
                type="button"
                className="button button--ghost button--small"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={edit.onRemove}
                aria-label={t("dashboards.panel.removeNamed", { title })}
              >
                {t("dashboards.panel.remove")}
              </button>
            </>
          )}
        </div>
      </header>
      <div className="panel-card__body">
        <PanelBody
          panel={panel}
          title={title}
          range={query.range}
          pending={results.isPending && results.fetchStatus !== "idle"}
          error={results.error}
          outcomes={outcomes}
          variables={query.variables}
        />
      </div>
      {edit === undefined ? null : (
        <div
          className="panel-card__resize"
          aria-hidden="true"
          onPointerDown={(event) => startDrag(event, "resize")}
        />
      )}
      {inspecting ? (
        <Dialog
          title={t("dashboards.inspect.title", { title })}
          onClose={() => setInspecting(false)}
          size="large"
        >
          <Inspect outcomes={outcomes} />
        </Dialog>
      ) : null}
    </article>
  );
}

interface PanelBodyProps {
  panel: PanelModel;
  title: string;
  range: TimeRange;
  pending: boolean;
  error: Error | null;
  outcomes: readonly TargetOutcome[];
  /** Dashboard variables, for panels that show text. */
  variables?: Readonly<Record<string, string>>;
}

/**
 * Loading, failure and data of one panel. Errors are mapped per query: one failing query shows
 * its message while the others still draw.
 */
export function PanelBody({
  panel,
  title,
  range,
  pending,
  error,
  outcomes,
  variables,
}: PanelBodyProps) {
  const { t } = useI18n();
  // Field option patterns need re2js, which loads with the first panel that uses one. The panel
  // is drawn again once it is there: until then its patterns matched nothing.
  const patterns = usePatternEngine(usesPatterns(panel.fieldConfig)) ? "patterns" : "waiting";
  const plugin = getPanel(panel.type);
  if (plugin === undefined) {
    return <p className="panel-empty">{t("dashboards.panel.unknownType", { type: panel.type })}</p>;
  }
  // A panel that needs no query (text) draws right away, whatever the queries do.
  if (plugin.standalone === true) {
    const { Panel } = plugin;
    return (
      <Panel
        key={patterns}
        frames={[]}
        options={plugin.options(panel.options)}
        timeRange={range}
        title={title}
        {...(variables === undefined ? {} : { variables })}
      />
    );
  }
  // A failed request comes first: it must never read as "no query yet".
  if (error !== null) {
    return (
      <div className="panel-error" role="alert">
        <Icon name="alert" />
        <span>{errorMessage(t, error)}</span>
      </div>
    );
  }
  if (!panel.targets.some((target) => queryText(target.query).trim() !== "")) {
    return <p className="panel-empty">{t("dashboards.panel.noQuery")}</p>;
  }
  if (pending) {
    return <p className="panel-empty">{t("common.loading")}</p>;
  }
  const frames = framesOf(outcomes);
  const errors = errorsOf(outcomes);
  const shapes = otherShapes(outcomes);
  const failedAll = frames.length === 0 && errors.length > 0;
  const errorList =
    errors.length === 0 ? null : (
      <ul className={failedAll ? "panel-error" : "panel-error panel-error--partial"} role="alert">
        {errors.map((e) => (
          <li key={e.refId}>
            <Icon name="alert" />
            <span>
              {errors.length > 1 || !failedAll
                ? `${t("dashboards.inspect.query", { refId: e.refId })}: `
                : ""}
              {errorBodyMessage(t, e)}
            </span>
          </li>
        ))}
      </ul>
    );
  if (failedAll) {
    return errorList;
  }
  const { Panel } = plugin;
  return (
    <div className="panel-content">
      {errorList}
      {frames.length === 0 ? (
        shapes.length > 0 ? (
          <p className="panel-empty">
            {t("dashboards.panel.otherShape", { shape: shapes[0] ?? "" })}
          </p>
        ) : (
          <EmptyPanel reason="noData" />
        )
      ) : (
        <div className="panel-content__viz">
          <Panel
            key={patterns}
            frames={frames}
            options={plugin.options(panel.options)}
            fieldConfig={parseFieldConfig(panel.fieldConfig)}
            timeRange={range}
            title={title}
            {...(variables === undefined ? {} : { variables })}
          />
        </div>
      )}
      {isTruncated(outcomes) ? (
        <p className="panel-note">{t("dashboards.panel.truncated")}</p>
      ) : null}
    </div>
  );
}
