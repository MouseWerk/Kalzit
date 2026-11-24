import { useNavigate } from "@tanstack/react-router";
import {
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
  startTransition,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { exportPanel, exportQuery, saveFile } from "../../analysis/api";
import { type ExportChoice, ExportDialog, exportResults } from "../../analysis/ExportDialog";
import { runPanelSteps, useAnalysisCalendar } from "../../analysis/panel";
import { asSteps, isProjection, type StepsRun, stepFrames } from "../../analysis/steps";
import type { DocumentSet, GraphSet, TimeRange } from "../../api/generated/shapes";
import { Icon } from "../../components/Icon";
import { Skeleton } from "../../components/Skeleton";
import { useI18n } from "../../i18n/i18n";
import { isComposingKey } from "../../lib/ime";
import { showErrorToast } from "../../lib/toasts";
import { liveNote } from "../../live/text";
import { useInView } from "../../live/useInView";
import { useOrgPermissions } from "../../org/useOrg";
import { parseFieldConfig, shownFieldConfig } from "../../panels/fieldConfig/fieldConfig";
import { usePatternEngine, usesPatterns } from "../../panels/fieldConfig/pattern";
import { getPanel, isTraceList, useExternalPanels } from "../../panels/registry";
// PanelBody's own layout; Explore shows it without the dashboard stylesheet.
import "../../panels/panels.css";
import { projectionApplies } from "../../documents/projection";
import { type PanelAnnotations, PanelAnnotationsContext } from "../../panels/annotations";
import { PanelHostContext, usePanelHost } from "../../panels/host";
import { imageFileName, panelImage } from "../../panels/image";
import { PanelErrorBoundary } from "../../panels/PanelErrorBoundary";
import { EmptyPanel } from "../../panels/shared";
import { useStyleVars } from "../../panels/styleVars";
import type { DocumentFilter, PanelSeries } from "../../panels/types";
import { hasQuery, normalizeQuery } from "../datasources/queryKinds";
import { useSourceKinds } from "../datasources/useSourceKinds";
import type { DashboardMark } from "./annotations";
import "./dashboards.css";
import "./dashboardTools.css";
import { PanelAlertMarksContext } from "../../panels/alertMarks";
import { PanelAiSummary } from "../ai/PanelAiSummary";
import { featureUsable, useAiStatusFor } from "../ai/useAiStatus";
import {
  alertLimits,
  firingSpanRule,
  PanelAlertBadge,
  useAlertingOn,
  useAlertOverlay,
  useFiringSpans,
  usePanelAlerts,
} from "../alerting/PanelAlerts";
import { formatNumber } from "../alerting/ruleModel";
import { reasonText } from "../datasources/reasons";
import { linkHref } from "./links";
import {
  clampGrid,
  type GridPos,
  type Hold,
  holdOf,
  type PanelModel,
  panelUses,
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
  tracesOf,
} from "./results";
import { intervalFor, MAX_DATA_POINTS } from "./timeRange";
import { Dialog } from "./ui/Dialog";
import { errorBodyMessage, errorMessage } from "./ui/errors";
import { Inspect } from "./ui/Inspect";
import { usePanelLive } from "./usePanelLive";
import { type MoreDocuments, usePanelPages } from "./usePanelPages";
import {
  firstLoad,
  type PanelQueryInput,
  panelDistribution,
  type TargetDistribution,
  usePanelResults,
} from "./usePanelResults";

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
  /** Opens a panel in the panel editor; present for those who may edit the dashboard. */
  onEditPanel?: ((panelId: string) => void) | undefined;
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

/**
 * Tells the panel which dashboard panel it is drawn for, so a viewer's own state of it (a graph
 * panel's pins and selection) is kept on the server. Repeat copies and panels not yet saved
 * keep none (`panelId` null).
 */
function PanelViewHost({
  dashboardId,
  panelId,
  values,
  onEditQuery,
  children,
}: {
  dashboardId: string;
  panelId: string | null;
  /** The values this panel runs with (a repeat copy's own included), for its data links. */
  values: VariableValues;
  /** Opens the panel in the panel editor; absent for those who may not edit it. */
  onEditQuery?: (() => void) | undefined;
  children: ReactNode;
}) {
  const host = usePanelHost();
  // The latest handler, behind a stable function: a new one on every render must not hand the
  // panel a new host (which would restart what it keeps per host, such as its view state).
  const editRef = useRef(onEditQuery);
  useEffect(() => {
    editRef.current = onEditQuery;
  });
  const editable = onEditQuery !== undefined;
  const value = useMemo(
    () => ({
      ...host,
      linkValues: values,
      ...(panelId === null ? {} : { view: { dashboardId, panelId } }),
      ...(editable ? { editQuery: () => editRef.current?.() } : {}),
    }),
    [host, dashboardId, panelId, values, editable],
  );
  return <PanelHostContext value={value}>{children}</PanelHostContext>;
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
  const { t, language } = useI18n();
  const navigate = useNavigate();
  const calendar = useAnalysisCalendar();
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  const hintId = useId();
  const [inspecting, setInspecting] = useState(false);
  const [exporting, setExporting] = useState(false);
  // A picture of the panel is being made (saveImage); the card is read in an effect.
  const [imaging, setImaging] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  // AI shows only while it is usable; a summary reads the saved panel as the server runs it.
  const ai = useAiStatusFor(query.orgId);
  // The server checks data:export on the export routes; without it the action is not offered.
  const permissions = useOrgPermissions();
  const mayExport = permissions.has("data:export");
  const mayWriteAlerts = permissions.has("alerts:write");
  const alertingOn = useAlertingOn();
  const handleRef = useRef<HTMLButtonElement>(null);
  const keepHandleFocus = useRef(false);
  // While the pointer drags or resizes: the card follows through a transform and a placeholder
  // shows the cell it will land in; both are styled through the CSSOM, without a render per move.
  const [dragging, setDragging] = useState<"move" | "resize" | null>(null);
  const placeholderRef = useRef<HTMLDivElement>(null);
  // Ends the press being tracked (its window listeners), without dropping: run before a new
  // press and when the card goes, so no listener outlives the drag.
  const endPress = useRef<(() => void) | null>(null);
  useEffect(() => () => endPress.current?.(), []);

  // A keyboard move can change the panel's place in reading order, and moving a focused element
  // in the document drops its focus; the handle takes it back so arrow keys keep working.
  useEffect(() => {
    if (keepHandleFocus.current && document.activeElement !== handleRef.current) {
      handleRef.current?.focus();
    }
    keepHandleFocus.current = false;
  });
  const results = usePanelResults({ ...query, panel });
  // Pages loaded after the answer through its document sets' cursors.
  const paged = usePanelPages({ ...query, panel }, results);
  // Retry after a data source error: the same request again. Stable, so the body is not drawn
  // again for it.
  const { refetch } = results;
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);
  // While the dashboard is live, the panels on screen follow their results.
  const [inView, observe] = useInView(query.live !== undefined);
  const cardRef = useCallback(
    (element: HTMLElement | null) => {
      ref.current = element;
      observe(element);
    },
    [observe],
  );
  // A query variable at "All" this panel uses has no values yet: it waits, or says why not.
  const hold = holdOf(panelUses(panel), query.held);
  const live = usePanelLive({ ...query, panel }, inView && hold === null);
  // Paused by the person: the panel keeps its last result and says so.
  const liveText =
    query.live?.paused === true
      ? { label: t("live.paused"), detail: t("live.detail.paused") }
      : liveNote(t, live);
  // A moving range ends at the last live run, unless a refresh since then ran later.
  const range =
    live.range !== undefined && live.range.to > query.range.to ? live.range : query.range;
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
    if (holdOf(link.url, query.held) !== null) return [];
    const href = linkHref(link.url, view?.values ?? query.variables);
    return href === null ? [] : [{ ...link, href }];
  });
  const isTimePanel = TIME_PANELS.has(panel.type);
  const onAnnotate = view?.onAnnotate;
  // Alert rules made from this panel: the badge, the dashed limit and the firing range. Only the
  // saved panel itself, not its repeat copies or a draft.
  const storedPanel = query.source === "stored" && repeatValue === undefined;
  const panelRules = usePanelAlerts(storedPanel ? query.dashboardId : undefined, panel.id);
  const [overlayHidden, setOverlayHidden] = useAlertOverlay(query.dashboardId, panel.id);
  const limits = overlayHidden ? [] : alertLimits(panelRules);
  const alertMarks = limits.length === 0 ? null : { limits };
  const firingSpans = useFiringSpans(
    query.dashboardId,
    panelRules,
    query.range,
    isTimePanel && !overlayHidden,
  );
  // The dashed limit, named as on the board ("Grenze 1,5"); only where a time axis draws it.
  const limitText =
    isTimePanel && limits.length > 0
      ? t("alerting.panel.limit", {
          value: limits.map((limit) => formatNumber(limit, language)).join(", "),
        })
      : null;
  const annotations: PanelAnnotations | null =
    view === undefined || !isTimePanel
      ? null
      : {
          marks: [
            ...view.marks.filter((m) => m.panelId === null || m.panelId === panel.id),
            ...firingSpans,
          ],
          onOpen: (mark) => {
            if (mark.key.startsWith("alert:")) {
              const rule = firingSpanRule(mark.key);
              void navigate({
                to: "/alerting/history",
                search: rule === undefined ? {} : { rule },
              });
              return;
            }
            view.onOpenMark(mark as DashboardMark);
          },
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
    // The header's buttons (Edit, Duplicate, the menu, the description) are clicked, never
    // dragged; the arrange handle and the header's empty space drag.
    if (!dragsFrom(event.target, event.currentTarget)) {
      return;
    }
    // No text selection while the pointer moves over the header.
    event.preventDefault();
    endPress.current?.();
    const target = event.currentTarget;
    const card = ref.current;
    const pointerId = event.pointerId;
    const start = { x: event.clientX, y: event.clientY, grid: { ...panel.grid } };
    const cell = edit.cellSize();
    const key = (g: GridPos) => `${g.x},${g.y},${g.w},${g.h}`;
    let pointer = { x: start.x, y: start.y };
    let next = start.grid;
    let placed = key(start.grid);
    let frame = 0;
    // A press that does not move past the threshold stays a click: nothing is captured, so the
    // click lands where it was pressed (it selects the panel, or the handle's own click).
    let started = false;
    const begin = () => {
      started = true;
      try {
        target.setPointerCapture(pointerId);
      } catch {
        // The pointer is already gone (released between the move and this call).
      }
      setDragging(mode);
    };
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
      if (move.pointerId !== pointerId) {
        return;
      }
      // The button is up, but its release never reached the page (let go outside the window,
      // or taken by a dialog): the press ends here, as a cancel.
      if ((move.buttons & 1) === 0) {
        finish(false);
        return;
      }
      pointer = { x: move.clientX, y: move.clientY };
      if (!started) {
        if (!pastThreshold(start, pointer)) {
          return;
        }
        begin();
      }
      if (frame === 0) {
        frame = requestAnimationFrame(follow);
      }
    };
    const onUp = (up: globalThis.PointerEvent) => {
      if (up.pointerId === pointerId) {
        finish(up.type === "pointerup");
      }
    };
    /** Ends the press: a drop where the pointer is (`drop`), else back where it started. */
    const finish = (drop: boolean) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (endPress.current === cancel) {
        endPress.current = null;
      }
      if (!started) {
        return;
      }
      cancelAnimationFrame(frame);
      if (drop) {
        follow();
      } else {
        next = start.grid;
      }
      setDragging(null);
      if (key(next) === key(start.grid)) {
        card?.style.removeProperty("translate");
        return;
      }
      // The card stands in its new cell in this frame (the drop's offset goes with it); the
      // dashboard follows as a transition, in slices that leave the main thread free, so it
      // makes no long task and the panels it pushes move right after.
      placeAt(card, next);
      card?.style.removeProperty("translate");
      startTransition(() => edit.onGrid(next, false));
    };
    const cancel = () => finish(false);
    endPress.current = cancel;
    // On the window: before the threshold nothing is captured and the pointer may leave the
    // header; after it the captured events still pass through the window.
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  const imageFailed = t("dashboards.panel.imageFailed");
  useEffect(() => {
    if (!imaging) return;
    void saveImage(ref, title, imageFailed).finally(() => setImaging(false));
  }, [imaging, title, imageFailed]);
  const outcomes = paged.outcomes;
  const noData = results.data === undefined;
  // Its own element, so a panel that does not wait keeps the same body while nothing it shows
  // changes (moving another panel draws only that one again).
  const body = (
    <PanelBody
      panel={panel}
      title={title}
      range={range}
      pending={firstLoad(results)}
      error={results.error}
      outcomes={outcomes}
      revision={`${results.dataUpdatedAt}:${paged.pageCount}`}
      more={paged.more}
      variables={variableTexts(query.variables)}
      kindOf={kindOf}
      onRetry={retry}
      fetching={results.isFetching}
      distribution={panelDistribution(
        { ...query, panel, manual: query.manual ?? query.run },
        kindOf,
      )}
    />
  );
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
    // What the panel shows, as a picture: made in the browser, from the screen.
    menuItems.push({
      key: "image",
      label: t("dashboards.panel.image"),
      name: t("dashboards.panel.imageNamed", { title }),
      onSelect: () => setImaging(true),
      disabled: noData || imaging,
    });
  }
  // Each AI function shows while its own provider can be used.
  const storedView = query.source === "stored" && edit === undefined;
  if (storedView && featureUsable(ai.status, "summarize")) {
    menuItems.push({
      key: "summarize",
      label: t("ai.call.summarize"),
      name: t("ai.call.summarizeNamed", { title }),
      onSelect: () => setSummarizing(true),
    });
  }
  if (storedView && featureUsable(ai.status, "chat")) {
    // "In Fragen öffnen": a chat about this dashboard, the question about the panel ready.
    menuItems.push({
      key: "ask",
      label: t("ai.chat.openInAsk"),
      name: t("ai.chat.openInAskNamed", { title }),
      onSelect: () =>
        void navigate({
          to: "/ask",
          search: { dashboard: query.dashboardId, q: t("ai.chat.askAboutPanel", { title }) },
        }),
    });
  }
  // "Alert-Regel erstellen": a rule with a copy of this panel's query, kept linked for the badge.
  if (
    storedView &&
    repeatValue === undefined &&
    mayWriteAlerts &&
    alertingOn &&
    panel.targets.length > 0
  ) {
    menuItems.push({
      key: "alert",
      label: t("alerting.panel.create"),
      name: t("alerting.panel.createNamed", { title }),
      onSelect: () =>
        void navigate({
          to: "/alerting/rules/new",
          search: { dashboard: query.dashboardId, panel: panel.id },
        }),
    });
  }
  // Only where something is drawn to hide: a limit or a firing area on a time axis.
  if (isTimePanel && alertLimits(panelRules).length > 0) {
    menuItems.push({
      key: "alertOverlay",
      label: t(overlayHidden ? "alerting.panel.showOverlay" : "alerting.panel.hideOverlay"),
      name: t(
        overlayHidden ? "alerting.panel.showOverlayNamed" : "alerting.panel.hideOverlayNamed",
        {
          title,
        },
      ),
      onSelect: () => setOverlayHidden(!overlayHidden),
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
        ref={cardRef}
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
                if (selectsOnClick(event.target, event.currentTarget)) {
                  edit.onSelect?.();
                }
              }
        }
        onDoubleClick={
          edit === undefined || alone
            ? undefined
            : (event) => {
                // A double click on the panel's content opens it in the editor in one step.
                if (
                  !event.defaultPrevented &&
                  isBodyDoubleClick(event.target, event.currentTarget)
                ) {
                  edit.onEdit();
                }
              }
        }
      >
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
          {panel.analysisId === undefined || edit === undefined ? null : (
            <span className="panel-card__badge">{t("analyses.panel.badge")}</span>
          )}
          {noteText === "" ? null : (
            <span className="panel-card__note" title={noteText}>
              {noteText}
            </span>
          )}
          {liveText === null ? null : (
            <span className="panel-card__live" title={liveText.detail}>
              {liveText.label}
              <span className="visually-hidden">: {liveText.detail}</span>
            </span>
          )}
          {panel.description === undefined ? null : (
            <PanelDescription title={title} description={panel.description} />
          )}
          <PanelAlertBadge rules={panelRules} title={title} />
          {limitText === null ? null : (
            <span className="panel-card__note" title={limitText}>
              {limitText}
            </span>
          )}
          <div className="panel-card__actions" data-no-image="">
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
                  onClick={() => edit.onSelect?.()}
                >
                  <Icon name="grip" />
                </button>
                <span className="visually-hidden" id={hintId}>
                  {t("dashboards.panel.arrangeHint")}
                </span>
              </>
            )}
            {/* After the handle, so selecting with Enter there leads on to these with Tab. In the
                header, not over the content; narrow panels leave both to the menu. */}
            {selected && edit !== undefined ? (
              <>
                <SizeBadge w={panel.grid.w} h={panel.grid.h} />
                <MiniToolbar title={title} onEdit={edit.onEdit} onDuplicate={edit.onDuplicate} />
              </>
            ) : null}
            {/* Opening a panel's menu while editing makes it the selected panel. */}
            <PanelMenu
              title={title}
              items={menuItems}
              onOpen={selected ? undefined : edit?.onSelect}
            />
          </div>
        </header>
        <div className="panel-card__body">
          <PanelAlertMarksContext value={alertMarks}>
            <PanelAnnotationsContext.Provider value={annotations}>
              <PanelViewHost
                dashboardId={query.dashboardId}
                panelId={repeatValue === undefined && edit === undefined ? panel.id : null}
                values={query.variables}
                onEditQuery={
                  edit?.onEdit ??
                  (view?.onEditPanel === undefined ? undefined : () => view.onEditPanel?.(panel.id))
                }
              >
                {hold === null ? body : <PanelHold hold={hold} />}
              </PanelViewHost>
            </PanelAnnotationsContext.Provider>
          </PanelAlertMarksContext>
        </div>
        {edit === undefined || alone ? null : (
          <div
            className="panel-card__resize"
            data-no-image=""
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
        {summarizing ? (
          <PanelAiSummary
            orgId={query.orgId}
            dashboardId={query.dashboardId}
            panelId={panel.id}
            title={title}
            range={range}
            variables={storedQueryVariables(query.variables, query.saved ?? [])}
            intervalMs={intervalFor(range)}
            onClose={() => setSummarizing(false)}
          />
        ) : null}
        {exporting ? (
          <ExportDialog
            results={exportResults(runPanelSteps(panel.transformations, outcomes, calendar))}
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

/** Saves the panel `card` as a PNG image named after its title; a failure says so in a toast. */
async function saveImage(card: RefObject<HTMLElement | null>, title: string, failed: string) {
  try {
    // The menu that asked for it closes first, so focus and hover marks are not in the picture.
    await new Promise((resolve) => requestAnimationFrame(resolve));
    if (card.current === null) return;
    const blob = await panelImage(card.current);
    saveFile({ blob, filename: imageFileName(title) });
  } catch {
    showErrorToast(failed);
  }
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
 * A panel that waits for the values of a query variable at "All": loading, or the error of the
 * variable's options query, instead of a run with an empty list.
 */
function PanelHold({ hold }: { hold: Hold }) {
  const { t } = useI18n();
  if (hold.error === null) {
    return (
      <p className="panel-empty" role="status">
        {t("dashboards.variables.waiting", { name: hold.name })}
      </p>
    );
  }
  return (
    <div className="panel-error" role="alert">
      <Icon name="alert" />
      <span>{t("dashboards.variables.allFailed", { name: hold.name, detail: hold.error })}</span>
    </div>
  );
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
  /**
   * The field distribution of the target `refId` over its whole result, from the server: the
   * panel route for a stored panel, the free route for a draft or Explore.
   */
  distribution?: TargetDistribution | undefined;
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
  /** Runs the queries again; offered beside a failed request or a query's error. */
  onRetry?: (() => void) | undefined;
  /** The queries are running (a retry among them): Retry waits until they are back. */
  fetching?: boolean | undefined;
  /** "Load more" for document sets whose source has more; absent where pages are not offered. */
  more?: MoreDocuments | undefined;
  /**
   * Drawn for someone who only reads (a public link, a snapshot): a result the panel cannot
   * show is said plainly, without the steps an editor would take.
   */
  reader?: boolean | undefined;
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
  distribution,
  revision,
  stepsRun: given,
  variables,
  kindOf = () => undefined,
  onRetry,
  fetching = false,
  more,
  reader = false,
}: PanelBodyProps) {
  const { t } = useI18n();
  const calendar = useAnalysisCalendar();
  // Field option patterns need re2js, which loads with the first panel that uses one. The panel
  // is drawn again once it is there: until then its patterns matched nothing.
  const patterns = usePatternEngine(usesPatterns(panel.fieldConfig)) ? "patterns" : "waiting";
  // The panel's steps run here, on what the queries answered; a failing step shows its reason
  // and the panel draws what the steps before it made. Kept while the steps and answers stay the
  // same, so a panel drawn again for another reason (moved in the grid) hands its chart the same
  // frames and the chart is not drawn again.
  const transformations = panel.transformations;
  const stepsRun = useMemo(
    () => given ?? runPanelSteps(transformations, outcomes, calendar),
    [given, transformations, outcomes, calendar],
  );
  const frames = useMemo(() => stepsRun.frames.map((f) => f.frame), [stepsRun]);
  // Drawn again when the plugins' panel types arrive.
  const plugins = useExternalPanels();
  const plugin = getPanel(panel.type, plugins);
  // Parsed once per change of the stored options, for the same reason.
  const stored = panel.options;
  const options = useMemo(() => plugin?.options(stored), [plugin, stored]);
  const storedConfig = panel.fieldConfig;
  const fieldConfig = useMemo(
    () => shownFieldConfig(parseFieldConfig(storedConfig)),
    [storedConfig],
  );
  if (plugin === undefined) {
    // A plugin's panel type is a reverse domain name: its plugin is not there, off or blocked.
    return (
      <p className="panel-empty">
        {panel.type.includes(".")
          ? t("panelPlugins.error.unavailable", { type: panel.type })
          : t("dashboards.panel.unknownType", { type: panel.type })}
      </p>
    );
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
  const retry =
    onRetry === undefined ? null : (
      <button
        type="button"
        className="button button--secondary button--small panel-error__retry"
        onClick={onRetry}
        disabled={fetching}
      >
        {t("common.retry")}
      </button>
    );
  if (error !== null) {
    return (
      <div className="panel-error" role="alert">
        <Icon name="alert" />
        <span>{errorMessage(t, error)}</span>
        {retry}
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
    return <Skeleton variant="panel" className="panel-skeleton" />;
  }
  // The graphs as the steps leave them: a top-N step keeps a smaller graph, a graph step that
  // makes a table leaves none.
  const graphs = graphsOf(
    stepsRun.graphs.map((g) => ({ refId: g.name, result: { shape: "graph", graph: g.graph } })),
    panel.targets,
  );
  // Documents an enabled projection step turns into a frame are that frame now; the others stay
  // documents for the document panels.
  const projected = new Set(
    asSteps(panel.transformations).flatMap((step) =>
      isProjection(step) && projectionApplies(step) ? [step.frame] : [],
    ),
  );
  const documents = documentsOf(outcomes).filter((d) => !projected.has(d.refId));
  // The traces as the trace steps leave them; a step that made a table or a graph leaves none.
  const traces = tracesOf(stepsRun.traces, panel.targets);
  const errors = errorsOf(outcomes);
  const shapes = otherShapes(outcomes, plugin.shapes);
  const failedAll =
    frames.length === 0 &&
    graphs.length === 0 &&
    documents.length === 0 &&
    traces.length === 0 &&
    errors.length > 0;
  const errorList =
    errors.length === 0 ? null : (
      <div
        className={
          failedAll
            ? "panel-error panel-error--list"
            : "panel-error panel-error--list panel-error--partial"
        }
        role="alert"
      >
        <ul className="panel-error__list">
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
        {retry}
      </div>
    );
  if (failedAll) {
    return errorList;
  }
  const { Panel } = plugin;
  // A graph panel draws graphs; every other panel documents (when it takes them) or frames.
  const graphPanel = plugin.shapes.includes("graph");
  const takesDocuments = plugin.shapes.includes("documents") && documents.length > 0;
  const takesFrames = plugin.shapes.includes("frame") && frames.length > 0;
  // The trace panel draws traces, and a table of traces as its list.
  const tracePanel = plugin.shapes.includes("trace");
  const drawable = tracePanel
    ? traces.length > 0 || frames.some(isTraceList)
    : graphPanel
      ? graphs.length > 0
      : takesDocuments || takesFrames;
  let note: string | null = null;
  if (!drawable) {
    if (reader && (documents.length > 0 || frames.length > 0 || shapes.length > 0)) {
      note = t("dashboards.panel.readerShape");
    } else if (!tracePanel && traces.length > 0) {
      note = t("datasources.reason.steps.trace_needs_projection", {
        frame: traces[0]?.refId ?? "",
      });
    } else if (tracePanel && frames.length > 0) {
      note = t("dashboards.panel.needsTrace");
    } else if (!graphPanel && documents.length > 0) {
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
              traces={traces}
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
              distribution={
                distribution === undefined
                  ? undefined
                  : {
                      // The set's target belongs to the question: sets keep their order.
                      identity: JSON.stringify([
                        distribution.identity,
                        documents.map((d) => d.refId),
                      ]),
                      manual: distribution.manual,
                      run: (index, ask, signal) => {
                        const refId = documents[index]?.refId;
                        return refId === undefined
                          ? Promise.reject(new Error(`no document set ${index}`))
                          : distribution.run(refId, ask, signal);
                      },
                    }
              }
              options={options}
              fieldConfig={fieldConfig}
              timeRange={range}
              title={title}
              revision={revision}
              {...(variables === undefined ? {} : { variables })}
              {...(plugin.external === true
                ? { series: pluginSeries(stepsRun, documents, graphs, errors) }
                : {})}
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
      {more === undefined || !drawable || !takesDocuments ? null : (
        <MoreButtons documents={documents} more={more} />
      )}
    </div>
  );
}

/** One "Load more" per document set the source has more of, and why the last page failed. */
function MoreButtons({
  documents,
  more,
}: {
  documents: readonly { refId: string; documents: DocumentSet }[];
  more: MoreDocuments;
}) {
  const { t } = useI18n();
  const open = documents.flatMap((d) =>
    d.documents.nextCursor === undefined
      ? []
      : [{ refId: d.refId, cursor: d.documents.nextCursor }],
  );
  if (open.length === 0 && more.error === null) {
    return null;
  }
  return (
    <div className="panel-more" data-no-image="">
      {open.map(({ refId, cursor }) => (
        <button
          key={refId}
          type="button"
          className="button button--secondary button--small"
          disabled={more.loading !== null || more.disabled}
          onClick={() => more.load(refId, cursor)}
        >
          {more.loading === refId
            ? t("common.loading")
            : documents.length > 1
              ? t("documents.more.loadQuery", { refId })
              : t("documents.more.load")}
        </button>
      ))}
      {more.error === null ? null : (
        <p className="panel-note" role="alert">
          {more.error}
        </p>
      )}
    </div>
  );
}

/**
 * What a plugin's panel receives: every query's result in its native shape after the panel's
 * steps (frames, the document sets no projection turned into a frame, graphs), and the queries
 * that failed with their error, by `refId`.
 */
function pluginSeries(
  stepsRun: StepsRun,
  documents: readonly { refId: string; documents: DocumentSet }[],
  graphs: readonly { refId: string; graph: GraphSet }[],
  errors: readonly { refId: string; code: string; message: string; reason?: unknown }[],
): PanelSeries[] {
  return [
    ...stepsRun.frames.map((f) => ({
      refId: f.name,
      result: { shape: "frame" as const, frame: f.frame },
    })),
    ...documents.map((d) => ({
      refId: d.refId,
      result: { shape: "documents" as const, documents: d.documents },
    })),
    ...graphs.map((g) => ({ refId: g.refId, result: { shape: "graph" as const, graph: g.graph } })),
    ...errors.map((e) => ({
      refId: e.refId,
      error: {
        code: e.code,
        message: e.message,
        ...(typeof e.reason === "string" ? { reason: e.reason } : {}),
      },
    })),
  ];
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
        <Icon name="info" />
      </button>
      <span className="panel-card__about-text" id={id} role="tooltip">
        {description}
      </span>
    </span>
  );
}

/** The selected panel's size in grid units, quiet in its header. */
function SizeBadge({ w, h }: { w: number; h: number }) {
  return (
    <span className="panel-card__size" aria-hidden="true" data-no-image="">
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
  // A group, not role="toolbar": a toolbar promises one Tab stop with arrow keys inside.
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of buttons, not a field set
    <div
      className="panel-card__mini"
      role="group"
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

/**
 * Surfaces that take focus only for the keyboard (a chart's readout, a table that scrolls): a
 * click on them is a click on the panel's content, not on a control.
 */
const FOCUS_ONLY = ":not(.ts__plot):not(.readout):not(.vt)";

/** What a click must not select the panel through: its own controls and labels. */
const OWN_CONTROLS =
  "button, a, input, select, textarea, label, summary, [contenteditable], " +
  '[role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], ' +
  `[role="switch"], [role="slider"], [role="option"], [tabindex]:not([tabindex="-1"])${FOCUS_ONLY}`;

/** Widgets with pointer gestures of their own (a graph canvas, a grid, a tree). */
const OWN_POINTER_WIDGETS =
  '[role="application"], [role="grid"], [role="tree"], [role="treegrid"], .trace-overview';

/** How far (in px) a press moves before it is a drag rather than a click. */
export const DRAG_THRESHOLD = 4;

/** Whether the pointer moved far enough from where it was pressed to start a drag. */
export function pastThreshold(
  start: { x: number; y: number },
  now: { x: number; y: number },
): boolean {
  return Math.hypot(now.x - start.x, now.y - start.y) >= DRAG_THRESHOLD;
}

/**
 * Whether a click on `target` in the card `card` selects the panel while editing: anywhere on it
 * (its chart and table included) except on a control inside it, which does its own thing.
 */
export function selectsOnClick(target: EventTarget | null, card: Element): boolean {
  if (!(target instanceof Element) || !card.contains(target)) {
    return false;
  }
  const control = target.closest(OWN_CONTROLS);
  return control === null || !card.contains(control);
}

/**
 * Whether a press on `target` inside the drag area `area` may start a drag: the area itself,
 * its plain text, and the arrange handle do; any other control in it (Edit, Duplicate, the
 * menu, the description) is pressed and clicked as a control.
 */
export function dragsFrom(target: EventTarget | null, area: Element): boolean {
  if (!(target instanceof Element) || !area.contains(target)) {
    return false;
  }
  if (target.closest(".panel-card__handle") !== null) {
    return true;
  }
  const control = target.closest(OWN_CONTROLS);
  return control === null || !area.contains(control);
}

/**
 * Whether a double click on `target` in the card `card` opens the panel in the editor: on its
 * content or its title, not on a control inside it (a table's sort button, a link, a field),
 * and not when it selected text (a double click selects a word, which must stay possible).
 */
export function isBodyDoubleClick(target: EventTarget | null, card: Element): boolean {
  if (!(target instanceof Element) || !card.contains(target)) {
    return false;
  }
  if ((window.getSelection()?.toString() ?? "") !== "") {
    return false;
  }
  if (target.closest(".panel-card__body, .panel-card__title") === null) {
    return false;
  }
  const control = target.closest(`${OWN_CONTROLS}, ${OWN_POINTER_WIDGETS}`);
  return control === null || !card.contains(control);
}
