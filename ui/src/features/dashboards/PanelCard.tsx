import {
  type KeyboardEvent,
  type PointerEvent,
  startTransition,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { exportPanel, exportQuery } from "../../analysis/api";
import { type ExportChoice, ExportDialog } from "../../analysis/ExportDialog";
import { runPanelSteps } from "../../analysis/panel";
import { asSteps, isProjection, type StepsRun, stepFrames } from "../../analysis/steps";
import type { TimeRange } from "../../api/generated/shapes";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { isComposingKey } from "../../lib/ime";
import { useOrgPermissions } from "../../org/useOrg";
import { parseFieldConfig } from "../../panels/fieldConfig/fieldConfig";
import { usePatternEngine, usesPatterns } from "../../panels/fieldConfig/pattern";
import { getPanel } from "../../panels/registry";
// PanelBody's own layout; Explore shows it without the dashboard stylesheet.
import "../../panels/panels.css";
import { projectionApplies } from "../../documents/projection";
import { type PanelAnnotations, PanelAnnotationsContext } from "../../panels/annotations";
import { PanelErrorBoundary } from "../../panels/PanelErrorBoundary";
import { EmptyPanel } from "../../panels/shared";
import { useStyleVars } from "../../panels/styleVars";
import type { DocumentFilter } from "../../panels/types";
import { hasQuery, normalizeQuery } from "../datasources/queryKinds";
import { useSourceKinds } from "../datasources/useSourceKinds";
import type { DashboardMark } from "./annotations";
import "./dashboards.css";
import "./dashboardTools.css";
import { reasonText } from "../datasources/reasons";
import { linkHref } from "./links";
import {
  clampGrid,
  type GridPos,
  type PanelModel,
  storedQueryVariables,
  type VariableValues,
  variableTexts,
} from "./model";
import { PanelMenu, type PanelMenuItem } from "./PanelMenu";
import { TIME_PANELS, timeNote } from "./panelTime";
import {
  documentsOf,
  errorsOf,
  graphsOf,
  isTruncated,
  otherShapes,
  type TargetOutcome,
} from "./results";
import { intervalFor, MAX_DATA_POINTS } from "./timeRange";
import { Dialog } from "./ui/Dialog";
import { errorBodyMessage, errorMessage } from "./ui/errors";
import { Inspect } from "./ui/Inspect";
import { firstLoad, type PanelQueryInput, usePanelResults } from "./usePanelResults";

/** The width at which dashboards.css switches to one column. */
const SINGLE_COLUMN = "(max-width: 48rem)";

export interface PanelViewActions {
  /** The variable values this panel runs with (its repeat copy's value included). */
  values: VariableValues;
  /** Shows the panel alone, full screen. */
  onView?: ((panelId: string) => void) | undefined;
  marks: readonly DashboardMark[];
  onOpenMark: (mark: DashboardMark) => void;
  /** Present for those who may write annotations. */
  onAnnotate?: ((panelId: string, time: number) => void) | undefined;
}

export interface PanelEditActions {
  onEdit: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  /** Copies the panel to another dashboard. */
  onCopy?: () => void;
  /** A new position or size; the grid pushes overlapped panels down. */
  onGrid: (grid: GridPos, byKeyboard: boolean) => void;
  /** Size of one grid cell in px, for turning a pointer drag into cells. */
  cellSize: () => { width: number; height: number };
  /** The panel is the one the inspector shows. */
  selected?: boolean;
  /** Makes the panel the selected one (a click on it, or its arrange handle taking focus). */
  onSelect?: () => void;
}

interface PanelCardProps {
  query: Omit<PanelQueryInput, "panel">;
  panel: PanelModel;
  /** The value of a repeat copy, shown with the title. */
  repeatValue?: string | undefined;
  /** Links, annotations and full screen, while viewing and editing. */
  view?: PanelViewActions | undefined;
  /** Present in edit mode. */
  edit?: PanelEditActions | undefined;
  /** Full screen: the panel fills the view and has no arrange controls. */
  alone?: boolean;
}

/** One panel in the grid: title bar, its own query state, and the visualization. */
export function PanelCard({
  query,
  panel,
  repeatValue,
  view,
  edit,
  alone = false,
}: PanelCardProps) {
  const { t } = useI18n();
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  const hintId = useId();
  const [inspecting, setInspecting] = useState(false);
  const [exporting, setExporting] = useState(false);
  // The server checks data:export on the export routes; without it the action is not offered.
  const mayExport = useOrgPermissions().has("data:export");
  const handleRef = useRef<HTMLButtonElement>(null);
  const keepHandleFocus = useRef(false);
  // While the pointer drags or resizes: the card follows through a transform and a placeholder
  // shows the cell it will land in; both are styled through the CSSOM, without a render per move.
  const [dragging, setDragging] = useState<"move" | "resize" | null>(null);
  const placeholderRef = useRef<HTMLDivElement>(null);
  // Set between a drop and the render that puts the card into its new cell.
  const settling = useRef(false);

  // A keyboard move can change the panel's place in reading order, and moving a focused element
  // in the document drops its focus; the handle takes it back so arrow keys keep working.
  useEffect(() => {
    if (keepHandleFocus.current && document.activeElement !== handleRef.current) {
      handleRef.current?.focus();
    }
    keepHandleFocus.current = false;
  });
  const results = usePanelResults({ ...query, panel });
  const kindOf = useSourceKinds(query.orgId);
  const baseTitle = panel.title === "" ? t("dashboards.panel.untitled") : panel.title;
  const title = repeatValue === undefined ? baseTitle : `${baseTitle}: ${repeatValue}`;
  const note = timeNote(panel);
  const noteText = [
    note.last === undefined ? null : t("dashboardTools.time.last", { range: note.last }),
    note.shift === undefined ? null : t("dashboardTools.time.shifted", { shift: note.shift }),
  ]
    .filter((part) => part !== null)
    .join(", ");
  const links = (panel.links ?? []).flatMap((link) => {
    const href = linkHref(link.url, view?.values ?? query.variables);
    return href === null ? [] : [{ ...link, href }];
  });
  const isTimePanel = TIME_PANELS.has(panel.type);
  const onAnnotate = view?.onAnnotate;
  const annotations: PanelAnnotations | null =
    view === undefined || !isTimePanel
      ? null
      : {
          marks: view.marks.filter((m) => m.panelId === null || m.panelId === panel.id),
          onOpen: (mark) => view.onOpenMark(mark as DashboardMark),
          onAdd: onAnnotate === undefined ? undefined : (time) => onAnnotate(panel.id, time),
        };

  useStyleVars(ref, {
    "--col": panel.grid.x + 1,
    "--row": panel.grid.y + 1,
    "--w": panel.grid.w,
    "--h": panel.grid.h,
  });
  // The placeholder starts where the panel is.
  useLayoutEffect(() => {
    if (dragging !== null) {
      placeAt(placeholderRef.current, panel.grid);
    }
  }, [dragging, panel.grid]);
  // A dropped card stands in its new cell now: the drag's offset goes in the same frame.
  const { x: gridX, y: gridY, w: gridW, h: gridH } = panel.grid;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the cell's values stand for its move
  useLayoutEffect(() => {
    if (settling.current) {
      settling.current = false;
      ref.current?.style.removeProperty("translate");
    }
  }, [gridX, gridY, gridW, gridH]);

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
    // Enter or Space on the arrange handle selects the panel, the keyboard's click on it.
    if ((event.key === "Enter" || event.key === " ") && !isComposingKey(event)) {
      event.preventDefault();
      edit.onSelect?.();
      return;
    }
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
    const card = ref.current;
    target.setPointerCapture(event.pointerId);
    const start = { x: event.clientX, y: event.clientY, grid: { ...panel.grid } };
    const cell = edit.cellSize();
    const key = (g: GridPos) => `${g.x},${g.y},${g.w},${g.h}`;
    let pointer = { x: start.x, y: start.y };
    let next = start.grid;
    let placed = key(start.grid);
    let frame = 0;
    setDragging(mode);
    // At most once per frame: the card's offset and the placeholder's cell. Nothing renders and
    // the dashboard changes once, on release.
    const follow = () => {
      frame = 0;
      const dxPx = pointer.x - start.x;
      const dyPx = pointer.y - start.y;
      const dx = Math.round(dxPx / cell.width);
      const dy = Math.round(dyPx / cell.height);
      const g = start.grid;
      next = clampGrid(
        mode === "move" ? { ...g, x: g.x + dx, y: g.y + dy } : { ...g, w: g.w + dx, h: g.h + dy },
      );
      // The translate property, not a custom property: those inherit, and setting one would
      // restyle everything inside the card on every frame.
      if (mode === "move") {
        card?.style.setProperty("translate", `${dxPx}px ${dyPx}px`);
      }
      // The grid lays out again only when the target cell changes, not on every move.
      if (key(next) !== placed) {
        placed = key(next);
        placeAt(placeholderRef.current, next);
      }
    };
    const onMove = (move: globalThis.PointerEvent) => {
      pointer = { x: move.clientX, y: move.clientY };
      if (frame === 0) {
        frame = requestAnimationFrame(follow);
      }
    };
    const onUp = (up: globalThis.PointerEvent) => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("pointerup", onUp);
      target.removeEventListener("pointercancel", onUp);
      cancelAnimationFrame(frame);
      if (up.type === "pointerup") {
        follow();
      } else {
        next = start.grid;
      }
      setDragging(null);
      if (key(next) === key(start.grid)) {
        card?.style.removeProperty("translate");
        return;
      }
      // The drop renders as a transition, in slices that leave the main thread free between
      // them, so it makes no long task; the card keeps its offset until it stands in its cell.
      settling.current = true;
      startTransition(() => edit.onGrid(next, false));
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointercancel", onUp);
  }

  const outcomes = results.data ?? [];
  const noData = results.data === undefined;
  // Every action of the panel, in one menu: its links first, then viewing, then editing.
  const menuItems: PanelMenuItem[] = [
    ...links.map((link) => ({
      key: `link:${link.title}${link.url}`,
      label: link.title,
      name: link.title,
      href: link.href,
      ...(link.newTab === true ? { newTab: true } : {}),
    })),
  ];
  if (view?.onView !== undefined && !alone) {
    const onView = view.onView;
    menuItems.push({
      key: "view",
      label: t("dashboardTools.view.panel"),
      name: t("dashboardTools.view.panelNamed", { title }),
      onSelect: () => onView(panel.id),
    });
  }
  if (onAnnotate !== undefined && isTimePanel) {
    menuItems.push({
      key: "annotate",
      label: t("annotations.add"),
      name: t("annotations.addNamed", { title }),
      onSelect: () => onAnnotate(panel.id, Math.min(Date.now(), query.range.to)),
    });
  }
  menuItems.push({
    key: "inspect",
    label: t("dashboards.panel.inspect"),
    name: t("dashboards.panel.inspectNamed", { title }),
    onSelect: () => setInspecting(true),
    disabled: noData,
  });
  if (mayExport) {
    menuItems.push({
      key: "export",
      label: t("analysis.export.button"),
      name: t("analysis.export.buttonNamed", { title }),
      onSelect: () => setExporting(true),
      disabled: noData,
    });
  }
  if (edit !== undefined) {
    menuItems.push(
      {
        key: "edit",
        label: t("dashboards.panel.edit"),
        name: t("dashboards.panel.editNamed", { title }),
        onSelect: edit.onEdit,
      },
      {
        key: "duplicate",
        label: t("dashboards.panel.duplicate"),
        name: t("dashboards.panel.duplicateNamed", { title }),
        onSelect: edit.onDuplicate,
      },
    );
    if (edit.onCopy !== undefined) {
      menuItems.push({
        key: "copy",
        label: t("dashboardTools.copy.panel"),
        name: t("dashboardTools.copy.panelNamed", { title }),
        onSelect: edit.onCopy,
      });
    }
    menuItems.push({
      key: "remove",
      label: t("dashboards.panel.remove"),
      name: t("dashboards.panel.removeNamed", { title }),
      onSelect: edit.onRemove,
    });
  }
  const selected = edit?.selected === true && !alone;
  const className = [
    "panel-card",
    edit === undefined ? "" : "panel-card--editing",
    selected ? "panel-card--selected" : "",
    panel.transparent === true ? "panel-card--transparent" : "",
    alone ? "panel-card--alone" : "",
    dragging === null ? "" : `panel-card--${dragging === "move" ? "dragging" : "resizing"}`,
  ]
    .filter((c) => c !== "")
    .join(" ");

  return (
    <>
      {dragging === null ? null : (
        <div className="dash-placeholder" ref={placeholderRef} aria-hidden="true" />
      )}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Enter or Space on the arrange handle selects the panel from the keyboard */}
      <article
        ref={ref}
        className={className}
        data-panel-id={panel.id}
        aria-labelledby={titleId}
        aria-busy={results.isFetching}
        aria-current={selected ? "true" : undefined}
        onClick={
          edit?.onSelect === undefined
            ? undefined
            : (event) => {
                // Controls inside the card do their own thing; anywhere else selects it.
                const control = (event.target as HTMLElement).closest(OWN_CONTROLS);
                if (control !== null && event.currentTarget.contains(control)) {
                  return;
                }
                edit.onSelect?.();
              }
        }
      >
        {selected && edit !== undefined ? <SizeBadge w={panel.grid.w} h={panel.grid.h} /> : null}
        <header
          className="panel-card__header"
          onPointerDown={edit === undefined ? undefined : (event) => startDrag(event, "move")}
        >
          <h2 className="panel-card__title truncate" id={titleId} title={title}>
            {title}
          </h2>
          {panel.libraryPanelId === undefined ? null : (
            <span className="panel-card__badge">{t("libraryPanels.badge")}</span>
          )}
          {noteText === "" ? null : (
            <span className="panel-card__note" title={noteText}>
              {noteText}
            </span>
          )}
          {panel.description === undefined ? null : (
            <PanelDescription title={title} description={panel.description} />
          )}
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
            {/* After the handle, so selecting with Enter there leads on to these with Tab. */}
            {selected && edit !== undefined ? (
              <MiniToolbar title={title} onEdit={edit.onEdit} onDuplicate={edit.onDuplicate} />
            ) : null}
            <PanelMenu title={title} items={menuItems} />
          </div>
        </header>
        <div className="panel-card__body">
          <PanelAnnotationsContext.Provider value={annotations}>
            <PanelBody
              panel={panel}
              title={title}
              range={query.range}
              pending={firstLoad(results)}
              error={results.error}
              outcomes={outcomes}
              revision={results.dataUpdatedAt}
              variables={variableTexts(query.variables)}
              kindOf={kindOf}
            />
          </PanelAnnotationsContext.Provider>
        </div>
        {edit === undefined || alone ? null : (
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
        {exporting ? (
          <ExportDialog
            frames={runPanelSteps(panel.transformations, outcomes).frames.map((f) => f.name)}
            note={
              query.source === "stored" && edit !== undefined
                ? t("analysis.export.stored")
                : undefined
            }
            run={(choice, signal) => exportPanelData(query, panel, choice, signal, kindOf)}
            onClose={() => setExporting(false)}
          />
        ) : null}
      </article>
    </>
  );
}

/** Puts the drag placeholder into a grid cell. */
function placeAt(element: HTMLElement | null, grid: GridPos) {
  if (element === null) {
    return;
  }
  element.style.setProperty("--col", String(grid.x + 1));
  element.style.setProperty("--row", String(grid.y + 1));
  element.style.setProperty("--w", String(grid.w));
  element.style.setProperty("--h", String(grid.h));
}

/**
 * The file of one panel: the saved panel through its export route, as viewers see it, or the
 * panel being edited through the free export route, as editors run it.
 */
function exportPanelData(
  query: Omit<PanelQueryInput, "panel">,
  panel: PanelModel,
  choice: ExportChoice,
  signal: AbortSignal,
  kindOf: (datasourceId: string) => string | undefined,
) {
  const common = {
    timeRange: query.range,
    maxDataPoints: MAX_DATA_POINTS,
    intervalMs: intervalFor(query.range),
    format: choice.format,
    language: choice.language,
    ...(choice.frame === undefined ? {} : { frame: choice.frame }),
  };
  if (query.source === "stored") {
    const variables = storedQueryVariables(query.variables, query.saved ?? []);
    return exportPanel(query.orgId, query.dashboardId, panel.id, { ...common, variables }, signal);
  }
  return exportQuery(
    query.orgId,
    {
      ...common,
      variables: query.variables,
      queries: exportTargets(panel, kindOf),
      steps: panel.transformations,
      title: panel.title,
    },
    signal,
  );
}

/**
 * The queries a draft export sends. Queries still being written are left out, unless a step reads
 * them: then the server says what is wrong with them instead of refusing the steps. Whether a
 * query is written is decided by its source's kind.
 */
export function exportTargets(
  panel: PanelModel,
  kindOf: (datasourceId: string) => string | undefined,
) {
  const read = new Set(asSteps(panel.transformations).flatMap(stepFrames));
  return panel.targets
    .filter(
      (target) =>
        read.has(target.refId) ||
        (target.datasourceId !== "" && hasQuery(target.query, kindOf(target.datasourceId))),
    )
    .map((t) => ({
      refId: t.refId,
      datasourceId: t.datasourceId,
      query: normalizeQuery(t.query, kindOf(t.datasourceId)),
    }));
}

interface PanelBodyProps {
  panel: PanelModel;
  title: string;
  range: TimeRange;
  pending: boolean;
  error: Error | null;
  outcomes: readonly TargetOutcome[];
  /**
   * Click-to-filter on a document value of the target `refId`. Explore and the panel editor
   * turn it into a `$match` stage; dashboards leave it out, so viewers only read.
   */
  onFilter?: ((refId: string, path: string, value: unknown) => void) | undefined;
  /** Changes with every new result: a run, or a page loaded after it. */
  revision?: string | number | undefined;
  /** The steps' run when the caller already has it (the panel editor shares it with its steps). */
  stepsRun?: StepsRun | undefined;
  /** Dashboard variables, for panels that show text. */
  variables?: Readonly<Record<string, string>>;
  /**
   * The kind of a target's data source, which decides whether its query can run. Without it (or
   * for a source the caller cannot see) the query's own fields decide.
   */
  kindOf?: ((datasourceId: string) => string | undefined) | undefined;
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
  onFilter,
  revision,
  stepsRun: given,
  variables,
  kindOf = () => undefined,
}: PanelBodyProps) {
  const { t } = useI18n();
  // Field option patterns need re2js, which loads with the first panel that uses one. The panel
  // is drawn again once it is there: until then its patterns matched nothing.
  const patterns = usePatternEngine(usesPatterns(panel.fieldConfig)) ? "patterns" : "waiting";
  // The panel's steps run here, on what the queries answered; a failing step shows its reason
  // and the panel draws what the steps before it made. Kept while the steps and answers stay the
  // same, so a panel drawn again for another reason (moved in the grid) hands its chart the same
  // frames and the chart is not drawn again.
  const transformations = panel.transformations;
  const stepsRun = useMemo(
    () => given ?? runPanelSteps(transformations, outcomes),
    [given, transformations, outcomes],
  );
  const frames = useMemo(() => stepsRun.frames.map((f) => f.frame), [stepsRun]);
  const plugin = getPanel(panel.type);
  // Parsed once per change of the stored options, for the same reason.
  const stored = panel.options;
  const options = useMemo(() => plugin?.options(stored), [plugin, stored]);
  const storedConfig = panel.fieldConfig;
  const fieldConfig = useMemo(() => parseFieldConfig(storedConfig), [storedConfig]);
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
        options={options}
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
  // A query counts when its source's kind says it can run, or when the server answered it (a
  // viewer may not see the source, and the panel route runs every stored query).
  const answered = new Set(outcomes.flatMap((o) => ("result" in o ? [o.refId] : [])));
  if (
    !panel.targets.some(
      (target) => answered.has(target.refId) || hasQuery(target.query, kindOf(target.datasourceId)),
    )
  ) {
    return <p className="panel-empty">{t("dashboards.panel.noQuery")}</p>;
  }
  if (pending) {
    return <p className="panel-empty">{t("common.loading")}</p>;
  }
  const graphs = graphsOf(outcomes, panel.targets);
  // Documents an enabled projection step turns into a frame are that frame now; the others stay
  // documents for the document panels.
  const projected = new Set(
    asSteps(panel.transformations).flatMap((step) =>
      isProjection(step) && projectionApplies(step) ? [step.frame] : [],
    ),
  );
  const documents = documentsOf(outcomes).filter((d) => !projected.has(d.refId));
  const errors = errorsOf(outcomes);
  const shapes = otherShapes(outcomes, plugin.shapes);
  const failedAll =
    frames.length === 0 && graphs.length === 0 && documents.length === 0 && errors.length > 0;
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
  // A graph panel draws graphs; every other panel documents (when it takes them) or frames.
  const graphPanel = plugin.shapes.includes("graph");
  const takesDocuments = plugin.shapes.includes("documents") && documents.length > 0;
  const takesFrames = plugin.shapes.includes("frame") && frames.length > 0;
  const drawable = graphPanel ? graphs.length > 0 : takesDocuments || takesFrames;
  let note: string | null = null;
  if (!drawable) {
    if (!graphPanel && documents.length > 0) {
      note = t("documents.panel.needsProjection");
    } else if (plugin.shapes.includes("documents") && frames.length > 0) {
      note = t("documents.panel.needsDocuments");
    } else if (shapes.length > 0) {
      note = t("dashboards.panel.otherShape", { shape: shapes[0] ?? "" });
    }
  }
  const failed = stepsRun.failed;
  return (
    <div className="panel-content">
      {errorList}
      {failed === undefined ? null : (
        <p className="panel-error panel-error--partial">
          <Icon name="alert" />
          <span>
            {t("analysis.steps.failed", {
              n: failed.index + 1,
              message:
                reasonText(t, {
                  reason: failed.error.reason,
                  params: failed.error.params,
                  fallback: failed.error.message,
                }) ?? failed.error.message,
            })}
          </span>
        </p>
      )}
      {drawable ? (
        <div className="panel-content__viz">
          <PanelErrorBoundary
            resetKeys={[
              outcomes,
              revision,
              panel.type,
              JSON.stringify(panel.options ?? null),
              JSON.stringify(panel.fieldConfig ?? null),
              JSON.stringify(panel.transformations ?? null),
              patterns,
            ]}
          >
            <Panel
              key={patterns}
              frames={frames}
              graphs={graphs}
              documents={documents.map((d) => d.documents)}
              onFilter={
                onFilter === undefined
                  ? undefined
                  : (filter: DocumentFilter) => {
                      const refId = documents[filter.index]?.refId;
                      if (refId !== undefined) {
                        onFilter(refId, filter.path, filter.value);
                      }
                    }
              }
              options={options}
              fieldConfig={fieldConfig}
              timeRange={range}
              title={title}
              revision={revision}
              {...(variables === undefined ? {} : { variables })}
            />
          </PanelErrorBoundary>
        </div>
      ) : note === null ? (
        <EmptyPanel reason="noData" />
      ) : (
        <p className="panel-empty">{note}</p>
      )}
      {isTruncated(outcomes) ? (
        <p className="panel-note">{t("dashboards.panel.truncated")}</p>
      ) : null}
    </div>
  );
}

/**
 * The panel's description behind a quiet info button: shown on hover and keyboard focus, and
 * toggled by a tap or click (touch screens have no hover). Screen readers get it once, through
 * `aria-describedby`; the text is plain, never markup.
 */
function PanelDescription({ title, description }: { title: string; description: string }) {
  const { t } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <span className="panel-card__about-anchor" data-open={open ? "" : undefined}>
      <button
        type="button"
        className="panel-card__about"
        aria-label={t("dashboards.panel.aboutFor", { title })}
        aria-describedby={id}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open && !isComposingKey(event)) {
            event.stopPropagation();
            setOpen(false);
          }
        }}
      >
        <Icon name="help" />
      </button>
      <span className="panel-card__about-text" id={id} role="tooltip">
        {description}
      </span>
    </span>
  );
}

/** The selected panel's size in grid units, quiet in the bottom corner. */
function SizeBadge({ w, h }: { w: number; h: number }) {
  return (
    <span className="panel-card__size" aria-hidden="true">
      {w} × {h}
    </span>
  );
}

/** The selected panel's small toolbar in its header: open in the editor, duplicate. */
function MiniToolbar({
  title,
  onEdit,
  onDuplicate,
}: {
  title: string;
  onEdit: () => void;
  onDuplicate: () => void;
}) {
  const { t } = useI18n();
  return (
    <div
      className="panel-card__mini"
      role="toolbar"
      aria-label={t("dashboards.panel.actionsFor", { title })}
    >
      <button
        type="button"
        className="button button--ghost button--small"
        aria-label={t("dashboards.panel.editNamed", { title })}
        onClick={onEdit}
      >
        <Icon name="edit" />
        {t("dashboards.panel.edit")}
      </button>
      <button
        type="button"
        className="button button--ghost button--small"
        aria-label={t("dashboards.panel.duplicateNamed", { title })}
        title={t("dashboards.panel.duplicate")}
        onClick={onDuplicate}
      >
        <Icon name="copy" />
      </button>
    </div>
  );
}

/** What a click must not select the panel through: its own controls and labels. */
const OWN_CONTROLS =
  "button, a, input, select, textarea, label, summary, [contenteditable], " +
  '[role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], ' +
  '[role="switch"], [role="slider"], [role="option"], [tabindex]:not([tabindex="-1"])';
