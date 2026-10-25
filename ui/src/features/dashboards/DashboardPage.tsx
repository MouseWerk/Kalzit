import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getRouteApi,
  Link,
  useBlocker,
  useLocation,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import {
  type ReactNode,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { isApiError } from "../../api/client";
import { Breadcrumbs, type Crumb, folderTrail } from "../../components/Breadcrumbs";
import { EmptyState } from "../../components/EmptyState";
import { FormAlert } from "../../components/FormAlert";
import { Icon } from "../../components/Icon";
import { type Translate, useI18n } from "../../i18n/i18n";
import { useEscapeLayer } from "../../lib/layers";
import {
  applyTimeOverride,
  getUserTimeSettings,
  setTimeOverride,
  subscribeTimeSettings,
  type TimeOverride,
  type TimeSettings,
} from "../../lib/timeSettings";
import { showErrorToast, showToast } from "../../lib/toasts";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import { CrosshairContext, createCrosshair } from "../../panels/crosshair";
import { PanelHostContext } from "../../panels/host";
import { PinButton } from "../../shell/PinButton";
import { StarButton, useRecordView } from "../../shell/StarButton";
import { useWideLayout } from "../../shell/sidebarState";
import { AccessDialog } from "../admin/access";
import { datasourcesQuery } from "../datasources/api";
import { preloadCodeEditor } from "../datasources/editors/CodeEditor";
import { AnnotationDialog } from "./AnnotationDialog";
import { mayManageAccess } from "./accessIntegration";
import { annotationRanges, type DashboardMark, useDashboardAnnotations } from "./annotations";
import {
  createDashboard,
  DASHBOARDS_KEY,
  type Dashboard,
  dashboardFromBody,
  dashboardQuery,
  deleteDashboard,
  fetchDashboard,
  foldersQuery,
  type LinkedPanel,
  restoreDashboard,
  saveDashboard,
} from "./api";
import { OwnerDialog } from "./TeamDialogs";
import "./dashboards.css";
import "./dashboardTools.css";
import { DashboardGrid, resolvePanel } from "./DashboardGrid";
import { DashboardInfo } from "./DashboardInfo";
import { DashboardLinks } from "./DashboardLinks";
import { DashboardRail } from "./DashboardRail";
import { DashboardToolbar } from "./DashboardToolbar";
import { readDraft, writeDraft } from "./draftStore";
import { buildExport, downloadJson } from "./exportImport";
import { createLibraryPanel, LIBRARY_PANELS_KEY, saveLibraryPanel } from "./featuresApi";
import { moveRow, panelsOf, placeInSection, sectionBottom } from "./layout";
import {
  BROWSER_ZONE,
  clickTargets,
  type DashboardModel,
  newPanelId,
  type PanelModel,
  type RowModel,
  type VariableValues,
  valueList,
} from "./model";
import { PanelCard } from "./PanelCard";
import { type EditorSnapshot, PanelEditor } from "./PanelEditor";
import { panelRange } from "./panelTime";
import { RefreshControl } from "./RefreshControl";
import type { DashboardSearch } from "./routes";
import { ConflictDialog, SaveDialog } from "./SaveDialogs";
import { SettingsDialog } from "./SettingsDialog";
import { TimeControls } from "./TimeRangePicker";
import {
  CopyPanelDialog,
  JsonModelDialog,
  LibraryPickerDialog,
  LibrarySaveDialog,
  MakeLibraryDialog,
  RowDialog,
  SaveAsDialog,
} from "./ToolDialogs";
import { delayedNow, resolveRange, type TextRange } from "./timeRange";
import { ConfirmDialog } from "./ui/Dialog";
import { errorMessage } from "./ui/errors";
import { initialVariables, VariablesBar } from "./Variables";

/**
 * Saving checks every data source the panels and variables use: one the caller may not query is
 * 403, one that does not exist (or is not visible) is 422 on `model`. Both get their own text.
 */
function saveErrorText(t: Translate, error: unknown): string {
  if (isApiError(error, "forbidden")) {
    return t("dashboards.save.forbidden");
  }
  if (isApiError(error, "validation") && error.field === "model") {
    // The server names the place in English ("model.panels[0].grid: ..."); only the missing
    // data source is common enough for its own text.
    return /data source .* does not exist/.test(error.message)
      ? t("dashboards.save.modelRefused")
      : t("dashboards.save.modelInvalid", { detail: error.message });
  }
  return errorMessage(t, error);
}

const dashboardRoute = getRouteApi("/_app/dashboards/$dashboardId");
const appRoute = getRouteApi("/_app");

/** Size of a new panel: half the width, a comfortable chart height. */
const NEW_PANEL_GRID = { w: 12, h: 8 };
/** TV mode hides its controls after this long without a pointer move or key. */
const TV_IDLE_MS = 4000;

/** How the dashboard is shown: with the app around it, alone (kiosk), or alone with controls (TV). */
export type ViewMode = "normal" | "kiosk" | "tv";

/** What lives in the address, so links can share it. */
export interface DisplayState {
  from?: string | undefined;
  to?: string | undefined;
  edit?: boolean | undefined;
  mode: ViewMode;
  /** A panel shown alone, full screen. */
  viewPanel?: string | undefined;
  /** The panel open in the full-page editor (its own route), or `NEW_PANEL` for one being added. */
  editPanel?: string | undefined;
  /** Opening the editor replaces the current history entry instead of adding one. */
  replace?: boolean | undefined;
}

/** No annotations: one array, so the panels' props stay the same while they are hidden. */
const NO_MARKS: DashboardMark[] = [];

/** The dashboard's own time options as an override of the viewer's preferences, or null. */
function timeOverrideOf(
  timeZone: string | undefined,
  weekStart: TimeSettings["weekStart"] | undefined,
  fiscalYearStartMonth: number | undefined,
): TimeOverride | null {
  const override: TimeOverride = {};
  if (timeZone !== undefined) {
    override.timeZone = timeZone === BROWSER_ZONE ? null : timeZone;
  }
  if (weekStart != null) {
    override.weekStart = weekStart;
  }
  if (fiscalYearStartMonth !== undefined) {
    override.fiscalYearStartMonth = fiscalYearStartMonth;
  }
  return Object.keys(override).length === 0 ? null : override;
}

/** `editPanel` for a panel being added: the editor at `/dashboards/$id/panels/new`. */
export const NEW_PANEL = "new";

export function DashboardPage() {
  const { t } = useI18n();
  const org = useCurrentOrg();
  const { dashboardId } = dashboardRoute.useParams();
  const search = dashboardRoute.useSearch();
  const navigate = dashboardRoute.useNavigate();
  // Set on the editor's child routes only.
  const { panelId } = useParams({ strict: false });
  const adding = useLocation({ select: (location) => location.pathname.endsWith("/panels/new") });
  if (org === undefined) {
    return (
      <EmptyState icon="dashboards" title={t("dashboards.noOrg.title")}>
        {t("dashboards.noOrg.text")}
      </EmptyState>
    );
  }
  return (
    <DashboardScreen
      orgId={org.id}
      dashboardId={dashboardId}
      display={{
        from: search.from,
        to: search.to,
        edit: search.edit,
        mode: search.kiosk ?? "normal",
        viewPanel: search.viewPanel,
        editPanel: panelId ?? (adding ? NEW_PANEL : undefined),
      }}
      onDisplay={(patch) => {
        if ("editPanel" in patch) {
          // Into the editor and back are entries in the history; the browser's back button
          // leaves the editor as Discard does, after asking when something changed.
          const keep = (prev: DashboardSearch) => ({ ...prev, edit: undefined });
          const replace = patch.replace === true;
          void (patch.editPanel === undefined
            ? navigate({ to: "/dashboards/$dashboardId", params: { dashboardId }, search: keep })
            : patch.editPanel === NEW_PANEL
              ? navigate({
                  to: "/dashboards/$dashboardId/panels/new",
                  params: { dashboardId },
                  search: keep,
                  replace,
                })
              : navigate({
                  to: "/dashboards/$dashboardId/panels/$panelId/edit",
                  params: { dashboardId, panelId: patch.editPanel },
                  search: keep,
                  replace,
                }));
          return;
        }
        void navigate({
          search: (prev) => {
            const next = { ...prev };
            if ("from" in patch) next.from = patch.from;
            if ("to" in patch) next.to = patch.to;
            if ("edit" in patch) next.edit = patch.edit;
            if ("viewPanel" in patch) next.viewPanel = patch.viewPanel;
            if ("mode" in patch) next.kiosk = patch.mode === "normal" ? undefined : patch.mode;
            return next;
          },
          replace: true,
        });
      }}
    />
  );
}

interface ScreenProps {
  orgId: string;
  dashboardId: string;
  display: DisplayState;
  onDisplay: (patch: Partial<DisplayState>) => void;
  /** Extra controls (the playlist's), shown in the bar. */
  controls?: ReactNode;
}

/** Loads one dashboard and shows it; also used by the playlist player. */
export function DashboardScreen({ orgId, dashboardId, display, onDisplay, controls }: ScreenProps) {
  const { t } = useI18n();
  const dashboard = useQuery(dashboardQuery(orgId, dashboardId));
  useRecordView(orgId, dashboardId);
  // Variable values the viewer picked, per dashboard: a save starts a new version (and a fresh
  // view), which must not throw the picks away.
  const picked = useRef(new Map<string, VariableValues>());

  useEffect(() => {
    if (dashboard.data !== undefined) {
      document.title = t("app.documentTitle", {
        page: dashboard.data.title === "" ? t("dashboards.untitled") : dashboard.data.title,
      });
    }
  }, [dashboard.data, t]);

  if (dashboard.isPending) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  if (dashboard.isError) {
    return (
      <EmptyState
        icon="dashboards"
        title={
          isApiError(dashboard.error, "not_found")
            ? t("dashboards.notFound.title")
            : t("dashboards.loadFailed")
        }
        actions={
          <Link to="/dashboards" className="button button--secondary">
            {t("dashboards.backToList")}
          </Link>
        }
      >
        {isApiError(dashboard.error, "not_found")
          ? t("dashboards.notFound.text")
          : errorMessage(t, dashboard.error)}
      </EmptyState>
    );
  }
  // Keyed by version: a newly saved or restored version starts from a clean state.
  return (
    <DashboardView
      key={`${dashboard.data.id}:${dashboard.data.version}`}
      orgId={orgId}
      dashboard={dashboard.data}
      picked={picked.current}
      display={display}
      onDisplay={onDisplay}
      controls={controls}
    />
  );
}

type DialogState =
  | { kind: "settings" }
  | { kind: "save" }
  | { kind: "conflict"; current: Dashboard; message: string }
  | { kind: "discard" }
  | { kind: "delete" }
  | { kind: "row"; row: RowModel }
  | { kind: "removeRow"; row: RowModel }
  | { kind: "copy"; panel: PanelModel }
  | { kind: "saveAs" }
  | { kind: "json"; readOnly: boolean }
  | { kind: "libraryPick" }
  | { kind: "makeLibrary"; panel: PanelModel }
  | { kind: "librarySave"; panel: PanelModel; isNew: boolean }
  | { kind: "annotate"; time: number; panelId: string | null }
  | { kind: "mark"; mark: DashboardMark }
  | { kind: "discardPanel"; fresh: boolean }
  | { kind: "access" }
  | { kind: "owner" }
  | { kind: "info" }
  | null;

/**
 * How the open panel editor is being left: with its change put into the draft (Back, Apply,
 * Esc), with the panel put back as it was (Discard; also the browser's back button or a link,
 * after asking when something changed), or as it stands because the change already went
 * elsewhere (made into a library panel, or a new panel saved and opened at its own address).
 */
type LeaveMode = "apply" | "discard" | "keep";

/** The panel the editor opened, for Discard: absent and `fresh` for a panel added just now. */
interface OpenedPanel {
  id: string;
  panel: PanelModel | undefined;
  fresh: boolean;
}

/**
 * The values the panel editor previews with: a repeated panel (or one in a repeated row) shows
 * its first copy, so the repeat's variable has one value, not the list.
 */
function editorValues(panel: PanelModel, rows: readonly RowModel[], values: VariableValues) {
  const row = rows.find((r) => r.id === panel.rowId);
  const variable = panel.repeat?.variable ?? row?.repeat?.variable;
  if (variable === undefined) {
    return values;
  }
  const first = valueList(values[variable])[0];
  return first === undefined ? values : { ...values, [variable]: first };
}

/** The panel as the dashboard stores it when it shows a library panel: its place, no queries. */
export function linkedPlace(panel: PanelModel): PanelModel {
  // Only the place, plus type and title for whoever reads the stored model; the library panel
  // holds queries, steps, options and links (the server refuses them on a slot).
  const slot: PanelModel = {
    id: panel.id,
    type: panel.type,
    title: panel.title,
    grid: panel.grid,
    targets: [],
    transformations: [],
    options: {},
    fieldConfig: {},
  };
  if (panel.rowId !== undefined) slot.rowId = panel.rowId;
  if (panel.repeat !== undefined) slot.repeat = panel.repeat;
  if (panel.libraryPanelId !== undefined) slot.libraryPanelId = panel.libraryPanelId;
  return slot;
}

/** Whether a library panel's content changed in the editor (place and title aside). */
function contentChanged(panel: PanelModel, linked: LinkedPanel): boolean {
  const content = (p: PanelModel) => {
    const { id: _i, grid: _g, rowId: _r, repeat: _p, libraryPanelId: _l, ...rest } = p;
    return JSON.stringify(rest);
  };
  return content(panel) !== content({ ...linked.model, id: panel.id, grid: panel.grid });
}

function DashboardView({
  orgId,
  dashboard,
  picked,
  display,
  onDisplay,
  controls,
}: {
  orgId: string;
  dashboard: Dashboard;
  picked: Map<string, VariableValues>;
  display: DisplayState;
  onDisplay: (patch: Partial<DisplayState>) => void;
  controls?: ReactNode;
}) {
  const { t } = useI18n();
  const permissions = useOrgPermissions();
  const wideLayout = useWideLayout();
  // For the breadcrumbs; without folders:read the trail starts at the list.
  const folders = useQuery({
    ...foldersQuery(orgId),
    enabled: permissions.has("folders:read"),
  });
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const headingId = useId();
  // Dashboards in restricted folders are hidden altogether, so whoever sees one may edit it when
  // their role allows; the server checks the folder grant on save. A trashed one is read-only.
  const inTrash = dashboard.deletedAt !== null;
  // What this caller may do here, grants included; the organization role until the server
  // answers with `access`.
  const canEdit = (dashboard.access?.write ?? permissions.has("dashboards:write")) && !inTrash;
  const canDelete = dashboard.access?.delete ?? permissions.has("dashboards:delete");
  // Annotations: annotations:write, or write access to this dashboard (a grant counts).
  const canAnnotate =
    !inTrash && (permissions.has("annotations:write") || (dashboard.access?.write ?? false));

  const userId = appRoute.useRouteContext().me.id;
  // Kept drafts belong to one account in one organization.
  const owner = useMemo(() => ({ userId, orgId }), [userId, orgId]);
  // What this tab kept of unsaved work on this version (a reload): the draft and the editor's
  // panel. It comes back below, once it is clear that this person may edit.
  const [kept] = useState(() => readDraft(owner, dashboard.id, dashboard.version));
  const [draft, setDraft] = useState<DashboardModel | null>(null);
  // The editor's panel from a reload, used once when the editor opens on it again.
  const [keptEditor, setKeptEditor] = useState(kept?.editor);
  // Edit mode is where query editors appear; start loading the editor before one opens.
  useEffect(() => {
    if (draft !== null) {
      void preloadCodeEditor();
    }
  }, [draft]);
  const model = draft ?? dashboard.model;
  // The dashboard's own time zone, week start and fiscal year apply to everything on the page
  // while it is open (the draft's, so a change in the settings shows at once); the range below
  // resolves with them from the first render on.
  const userTime = useSyncExternalStore(
    subscribeTimeSettings,
    getUserTimeSettings,
    getUserTimeSettings,
  );
  const timeOverride = useMemo(
    () => timeOverrideOf(model.timeZone, model.weekStart, model.fiscalYearStartMonth),
    [model.timeZone, model.weekStart, model.fiscalYearStartMonth],
  );
  const timeSettings = useMemo(
    () => applyTimeOverride(userTime, timeOverride),
    [userTime, timeOverride],
  );
  // Whether the zone in effect is the dashboard's own: it set one the browser knows.
  const dashboardZone =
    timeOverride?.timeZone !== undefined && timeSettings.timeZone === timeOverride.timeZone;
  useLayoutEffect(() => {
    setTimeOverride(timeOverride);
    return () => setTimeOverride(null);
  }, [timeOverride]);
  const rows = model.rows ?? [];
  // Library panels added or changed in this session, on top of those the dashboard answered.
  const [extraLibrary, setExtraLibrary] = useState<Record<string, LinkedPanel>>({});
  const library = { ...dashboard.libraryPanels, ...extraLibrary };
  const [values, setValues] = useState<VariableValues>(() => {
    const start = initialVariables(dashboard.model.variables);
    const kept = Object.entries(picked.get(dashboard.id) ?? {}).filter(([name]) => name in start);
    return { ...start, ...Object.fromEntries(kept) };
  });
  useEffect(() => {
    picked.set(dashboard.id, values);
  }, [picked, dashboard.id, values]);
  // Rows opened or closed while viewing; not saved.
  const [openRows, setOpenRows] = useState<Record<string, boolean>>({});
  const [refresh, setRefresh] = useState(dashboard.model.refreshSeconds ?? 0);
  // `run` re-runs the panels (refresh, auto refresh); `manual` counts only the Refresh button,
  // which also reads variable options again.
  const [clock, setClock] = useState(() => ({ now: Date.now(), run: 0, manual: 0 }));
  const [dialog, setDialog] = useState<DialogState>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The panel whose menu takes focus when the editor closes.
  const [focusAfter, setFocusAfter] = useState<string | null>(null);
  const editing = display.editPanel;
  const isNewPanel = editing === NEW_PANEL;
  // The open editor's state, read when it is left, and the panel as it was when it opened.
  const snapshot = useRef<EditorSnapshot | null>(null);
  const opened = useRef<OpenedPanel | null>(null);
  // Set by the editor's buttons just before they leave it; unset, leaving discards.
  const leaveMode = useRef<LeaveMode | null>(null);
  // A panel being added: it joins the dashboard only when it is applied.
  const [fresh, setFresh] = useState<PanelModel | null>(null);
  const draftRef = useRef(draft);
  const editingRef = useRef(editing);
  useEffect(() => {
    draftRef.current = draft;
    editingRef.current = editing;
  });
  // The model as last drawn, for actions that look a panel or row up: reading it from a ref
  // keeps those actions the same objects while the draft changes, so cards are not drawn again.
  const modelRef = useRef(model);
  useEffect(() => {
    modelRef.current = model;
  });

  // A kept draft comes back for someone who may edit this dashboard; for anyone else it goes.
  // (Before the editor's address below, which would otherwise start from the saved model.)
  useEffect(() => {
    if (kept === null || !permissions.loaded) {
      return;
    }
    if (canEdit) {
      setDraft((current) => current ?? kept.model);
    } else {
      setKeptEditor(undefined);
      writeDraft(owner, dashboard.id, null);
    }
  }, [kept, permissions.loaded, canEdit, owner, dashboard.id]);

  // The editor's address opens edit mode (a reload, a shared link), for those who may edit;
  // everyone else goes back to the dashboard.
  useEffect(() => {
    if (editing === undefined || !permissions.loaded) {
      return;
    }
    if (!canEdit) {
      onDisplay({ editPanel: undefined });
      return;
    }
    setDraft((current) => current ?? dashboard.model);
  }, [editing, permissions.loaded, canEdit, dashboard.model, onDisplay]);
  useEffect(() => {
    if (editing !== undefined && !isNewPanel && draft !== null && opened.current?.id !== editing) {
      opened.current = {
        id: editing,
        panel: draft.panels.find((p) => p.id === editing),
        fresh: false,
      };
    }
  }, [editing, isNewPanel, draft]);

  // Unsaved work survives a reload of this tab: the draft, and what the open editor holds.
  function keepDraft() {
    const current = draftRef.current;
    const state = snapshot.current;
    const key = editingRef.current;
    writeDraft(
      owner,
      dashboard.id,
      current === null
        ? null
        : {
            version: dashboard.version,
            model: current,
            editor: state === null || key === undefined ? undefined : { key, panel: state.panel() },
          },
    );
  }
  useEffect(() => {
    // Nothing is written before a kept draft had its chance to come back.
    if (draft === null && kept !== null && !permissions.loaded) {
      return;
    }
    writeDraft(
      owner,
      dashboard.id,
      draft === null ? null : { version: dashboard.version, model: draft },
    );
  }, [owner, dashboard.id, dashboard.version, draft, kept, permissions.loaded]);
  const keepTimer = useRef(0);
  // Leaving the page (a reload, closing the tab) keeps the editor's latest change at once,
  // without waiting for the pause after typing.
  const flushDraft = useEffectEvent(() => {
    window.clearTimeout(keepTimer.current);
    if (draftRef.current !== null) {
      keepDraft();
    }
  });
  useEffect(() => {
    const onPageHide = () => flushDraft();
    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.clearTimeout(keepTimer.current);
    };
  }, []);

  // "?edit" opens edit mode once, and only for someone who may edit; it must not reopen it after
  // a save remounts the view. Permissions arrive after the first render, so this waits for them.
  useEffect(() => {
    if (display.edit !== true || !permissions.loaded) {
      return;
    }
    if (canEdit) {
      setDraft((current) => current ?? dashboard.model);
    }
    onDisplay({ edit: undefined });
  }, [display.edit, permissions.loaded, canEdit, dashboard.model, onDisplay]);

  // The range and what the cards run with keep their identity while they stay the same, so an
  // edit of the draft (a panel moved) does not hand every card new props.
  // "Now" for this run: the clock, minus the dashboard's now delay.
  const now = useMemo(
    () => delayedNow(clock.now, model.nowDelay, timeSettings),
    [clock.now, model.nowDelay, timeSettings],
  );
  const textRange: TextRange = useMemo(
    () =>
      draft === null && display.from !== undefined && display.to !== undefined
        ? { from: display.from, to: display.to }
        : model.timeRange,
    [draft, display.from, display.to, model.timeRange],
  );
  const resolved = useMemo(
    () => resolveRange(textRange, now, timeSettings),
    [textRange, now, timeSettings],
  );
  const tick = () => setClock((c) => ({ now: Date.now(), run: c.run + 1, manual: c.manual + 1 }));

  useEffect(() => {
    if (refresh <= 0) {
      return;
    }
    // A tab in the background does not refresh; it catches up when it is shown again.
    let missed = false;
    const run = () => setClock((c) => ({ ...c, now: Date.now(), run: c.run + 1 }));
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        run();
      } else {
        missed = true;
      }
    }, refresh * 1000);
    const onVisible = () => {
      if (document.visibilityState === "visible" && missed) {
        missed = false;
        run();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh]);

  // TV mode: the controls hide after a while without input and come back with any.
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    if (display.mode === "normal") {
      setIdle(false);
      return;
    }
    let timer = window.setTimeout(() => setIdle(true), TV_IDLE_MS);
    const wake = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), TV_IDLE_MS);
    };
    window.addEventListener("pointermove", wake);
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", wake);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", wake);
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
    };
  }, [display.mode]);
  // Escape leaves a panel shown alone first, then kiosk or TV mode.
  useEscapeLayer(display.viewPanel !== undefined && dialog === null, () =>
    onDisplay({ viewPanel: undefined }),
  );
  useEscapeLayer(
    display.viewPanel === undefined && display.mode !== "normal" && dialog === null,
    () => onDisplay({ mode: "normal" }),
  );

  const annotations = useDashboardAnnotations({
    orgId,
    dashboardId: dashboard.id,
    // The dashboard's range and the own ranges of the time panels on screen, so a shifted panel
    // shows the annotations of the period it draws.
    ranges: resolved.ok
      ? annotationRanges(
          model.panels.map((p) => resolvePanel(p, library)),
          rows,
          (row) => (openRows[row.id] === undefined ? row.collapsed : !openRows[row.id]),
          resolved.range,
          now,
        )
      : [],
    saved: dashboard.model,
    values,
    run: clock.run,
  });

  const save = useMutation({
    mutationFn: ({
      next,
      version,
      message,
    }: {
      next: DashboardModel;
      version: number;
      message: string;
    }) => saveDashboard(orgId, dashboard.id, { model: next, version, message }),
    onSuccess: async () => {
      setDialog(null);
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: [DASHBOARDS_KEY, orgId] });
    },
    onError: async (error, { message }) => {
      if (isApiError(error, "version_conflict")) {
        // The answer carries the stored dashboard as `current`; only when it is missing or
        // unreadable is it read again.
        const current =
          dashboardFromBody(error.current) ??
          (await fetchDashboard(orgId, dashboard.id).catch(() => null));
        if (current !== null) {
          save.reset();
          setDialog({ kind: "conflict", current, message });
        }
      }
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteDashboard(orgId, dashboard.id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [DASHBOARDS_KEY, orgId] });
      await navigate({ to: "/dashboards/trash" });
    },
  });

  const restore = useMutation({
    mutationFn: () => restoreDashboard(orgId, dashboard.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: [DASHBOARDS_KEY, orgId] }),
  });

  const librarySave = useMutation({
    mutationFn: async ({ panel }: { panel: PanelModel; isNew: boolean }) => {
      const id = panel.libraryPanelId ?? "";
      const linked = library[id];
      return saveLibraryPanel(orgId, id, {
        name: linked?.name ?? panel.title,
        panel,
        version: linked?.version ?? 0,
      });
    },
    onSuccess: async (saved, { panel, isNew }) => {
      setExtraLibrary((current) => ({
        ...current,
        [saved.id]: { id: saved.id, name: saved.name, version: saved.version, model: saved.panel },
      }));
      applyPanel(linkedPlace(panel), isNew);
      await queryClient.invalidateQueries({ queryKey: [LIBRARY_PANELS_KEY, orgId] });
    },
  });

  const changeDraft = (change: (current: DashboardModel) => DashboardModel) =>
    setDraft((current) => (current === null ? current : change(current)));

  function onRangeChange(range: TextRange) {
    if (draft !== null) {
      changeDraft((m) => ({ ...m, timeRange: range }));
    } else {
      onDisplay({ from: range.from, to: range.to });
    }
    setClock((c) => ({ ...c, now: Date.now() }));
  }

  // The type chosen in the rail's Add pane for the panel about to be added.
  const [pendingType, setPendingType] = useState<string | undefined>(undefined);

  function newPanel(type = "timeseries"): PanelModel {
    return {
      id: newPanelId(),
      type,
      title: "",
      grid: { x: 0, y: sectionBottom(model.panels, null, rows), ...NEW_PANEL_GRID },
      targets: [],
      transformations: [],
      options: {},
      fieldConfig: {},
    };
  }

  // Adding a panel: one made now (or the one kept from a reload), outside the draft.
  const startFresh = useEffectEvent(() => {
    const panel = keptEditor?.key === NEW_PANEL ? keptEditor.panel : newPanel(pendingType);
    setPendingType(undefined);
    setFresh(panel);
    opened.current = { id: panel.id, panel: undefined, fresh: true };
  });
  useEffect(() => {
    if (isNewPanel && draft !== null && fresh === null) {
      startFresh();
    }
  }, [isNewPanel, draft, fresh]);

  /** A new panel opens in the editor at its own address; it joins the dashboard on Apply. */
  function addPanel(type?: string) {
    setPendingType(type);
    onDisplay({ editPanel: NEW_PANEL });
  }

  /** Puts the panel the editor opened back as it was (a new one never joined the draft). */
  function restorePanel(before: OpenedPanel | null) {
    const panel = before?.panel;
    if (before === null || before.fresh || panel === undefined) {
      return;
    }
    changeDraft((m) => ({
      ...m,
      panels: m.panels.map((p) => (p.id === before.id && p !== panel ? panel : p)),
    }));
  }

  function leaveEditor(mode: LeaveMode) {
    leaveMode.current = mode;
    onDisplay({ editPanel: undefined });
  }

  function applyPanel(panel: PanelModel, isNew: boolean) {
    changeDraft((m) => {
      let panels = isNew
        ? [...m.panels, panel]
        : m.panels.map((p) => (p.id === panel.id ? panel : p));
      // A panel moved into another row goes to the bottom of that row.
      const before = m.panels.find((p) => p.id === panel.id);
      if (!isNew && before !== undefined && before.rowId !== panel.rowId) {
        const others = panels.filter((p) => p.id !== panel.id);
        const y = sectionBottom(others, panel.rowId ?? null, m.rows ?? []);
        panels = panels.map((p) => (p.id === panel.id ? { ...p, grid: { ...p.grid, y } } : p));
      }
      return { ...m, panels };
    });
    setDialog(null);
  }

  /** The editor's Apply: a library panel with new content asks first, then saves it. */
  function onPanelApply(panel: PanelModel, isNew: boolean) {
    const linked = panel.libraryPanelId === undefined ? undefined : library[panel.libraryPanelId];
    if (linked !== undefined && contentChanged(panel, linked)) {
      librarySave.reset();
      setDialog({ kind: "librarySave", panel, isNew });
      return;
    }
    applyPanel(linked === undefined ? panel : linkedPlace(panel), isNew);
  }

  // Leaving the editor: Back, Apply and Esc put its change into the draft (a new panel joins
  // it); Discard, the browser's back button and links leave the panel as it was.
  const onEditorLeft = useEffectEvent((left: string) => {
    const state = snapshot.current;
    const before = opened.current;
    const mode = leaveMode.current ?? "discard";
    const wasNew = left === NEW_PANEL;
    snapshot.current = null;
    opened.current = null;
    leaveMode.current = null;
    window.clearTimeout(keepTimer.current);
    setKeptEditor(undefined);
    if (wasNew) {
      setFresh(null);
    }
    if (mode === "discard") {
      restorePanel(before);
    } else if (mode === "apply" && state !== null && (wasNew || state.id === left)) {
      if (wasNew || state.changed()) {
        onPanelApply(state.panel(), wasNew);
      }
    }
    keepDraft();
    // Focus goes back to the panel that was edited (a new one that was applied included).
    const back = wasNew ? (mode === "apply" ? state?.id : undefined) : left;
    setFocusAfter(back ?? null);
  });
  // Focus goes to that panel's menu once the dashboard is drawn again after the editor.
  useEffect(() => {
    if (editing !== undefined || focusAfter === null) {
      return;
    }
    const button = document.querySelector<HTMLElement>(
      `[data-panel-id="${CSS.escape(focusAfter)}"] .panel-menu__button`,
    );
    button?.focus();
    setFocusAfter(null);
  });
  const lastEditing = useRef(editing);
  useEffect(() => {
    const left = lastEditing.current;
    lastEditing.current = editing;
    if (left !== undefined && left !== editing) {
      onEditorLeft(left);
    }
  }, [editing]);

  function addRow() {
    changeDraft((m) => ({
      ...m,
      rows: [
        ...(m.rows ?? []),
        {
          id: newPanelId(),
          title: t("dashboardTools.rows.defaultTitle", { n: (m.rows ?? []).length + 1 }),
          collapsed: false,
        },
      ],
    }));
  }

  /** Removes a row; its panels stay, below the panels outside every row. */
  function removeRow(row: RowModel) {
    changeDraft((m) => {
      const remaining = (m.rows ?? []).filter((r) => r.id !== row.id);
      const base = sectionBottom(m.panels, null, m.rows ?? []);
      const panels = m.panels.map((p) => {
        if (p.rowId !== row.id) return p;
        const { rowId: _row, ...rest } = p;
        return { ...rest, grid: { ...p.grid, y: base + p.grid.y } };
      });
      const next = { ...m, panels };
      if (remaining.length > 0) {
        next.rows = remaining;
      } else {
        delete next.rows;
      }
      return next;
    });
    setDialog(null);
  }

  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(dashboard.model);
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  });
  // Leaving the dashboard with nothing changed keeps no draft for later.
  const forgetUnchanged = useEffectEvent(() => {
    if (!dirtyRef.current && !(snapshot.current?.changed() ?? false)) {
      writeDraft(owner, dashboard.id, null);
    }
  });
  useEffect(() => () => forgetUnchanged(), []);
  // Leaving the dashboard with unsaved changes asks first; so does leaving the editor without
  // its buttons (the browser's back button) when that would drop a change to the panel.
  const editorChanged = () => snapshot.current?.changed() ?? false;
  const unsaved = () => dirtyRef.current || editorChanged();
  const here = `/dashboards/${dashboard.id}`;
  const staysHere = (pathname: string) =>
    pathname === here || pathname.startsWith(`${here}/panels/`);
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => {
      if (staysHere(next.pathname)) {
        const fromEditor = current.pathname.startsWith(`${here}/panels/`);
        return fromEditor && leaveMode.current === null && editorChanged();
      }
      return unsaved();
    },
    enableBeforeUnload: unsaved,
    withResolver: true,
    disabled: draft === null,
  });
  const droppingPanel = blocker.status === "blocked" && staysHere(blocker.next.pathname);
  const inEditMode = draft !== null;
  const editActions = !inEditMode
    ? undefined
    : {
        onEdit: (id: string) => onDisplay({ editPanel: id }),
        onDuplicate: (id: string) =>
          changeDraft((m) => {
            const source = m.panels.find((p) => p.id === id);
            if (source === undefined) {
              return m;
            }
            const copy = { ...structuredClone(source), id: newPanelId() };
            copy.grid.y = source.grid.y + source.grid.h;
            return {
              ...m,
              panels: placeInSection([...m.panels, copy], copy.id, copy.grid, m.rows ?? []),
            };
          }),
        onRemove: (id: string) =>
          changeDraft((m) => ({ ...m, panels: m.panels.filter((p) => p.id !== id) })),
        onGrid: (id: string, grid: { x: number; y: number; w: number; h: number }) =>
          changeDraft((m) => ({
            ...m,
            panels: placeInSection(m.panels, id, grid, m.rows ?? []),
          })),
        onCopy: (id: string) => {
          const panel = modelRef.current.panels.find((p) => p.id === id);
          if (panel !== undefined) setDialog({ kind: "copy", panel });
        },
        onRowMove: (from: number, to: number) =>
          changeDraft((m) => ({ ...m, rows: moveRow(m.rows ?? [], from, to) })),
        onRowEdit: (rowId: string) => {
          const row = (modelRef.current.rows ?? []).find((r) => r.id === rowId);
          if (row !== undefined) setDialog({ kind: "row", row });
        },
        onRowRemove: (rowId: string) => {
          const row = (modelRef.current.rows ?? []).find((r) => r.id === rowId);
          if (row !== undefined) setDialog({ kind: "removeRow", row });
        },
        onRowToggle: (rowId: string) =>
          changeDraft((m) => ({
            ...m,
            rows: (m.rows ?? []).map((r) =>
              r.id === rowId ? { ...r, collapsed: !r.collapsed } : r,
            ),
          })),
      };

  async function exportJson() {
    const sources = await queryClient.fetchQuery(datasourcesQuery(orgId)).catch(() => []);
    downloadJson(model.title, buildExport(model, library, sources));
  }

  // Panels may set a variable the dashboard defines (a node click setting $customerId).
  const host = {
    orgId,
    variables: {
      ...clickTargets(model.variables),
      set: (name: string, value: string) => setValues((v) => ({ ...v, [name]: value })),
    },
  };

  const gridQuery = useMemo(
    () => ({
      orgId,
      dashboardId: dashboard.id,
      range: resolved.ok ? resolved.range : { from: 0, to: 0 },
      variables: values,
      saved: dashboard.model.variables,
      source: "stored" as const,
      run: clock.run,
    }),
    [orgId, dashboard.id, resolved, values, dashboard.model.variables, clock.run],
  );
  // The rail hides the annotations and the filter bar for this view of the dashboard.
  const [annotationsShown, setAnnotationsShown] = useState(true);
  const [filtersShown, setFiltersShown] = useState(true);
  const marks = annotationsShown ? annotations.marks : NO_MARKS;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the React Compiler keeps this memo only with the setter listed
  const viewActions = useMemo(
    () => ({
      onView: (panelId: string) => onDisplay({ viewPanel: panelId }),
      marks,
      onOpenMark: (mark: DashboardMark) => setDialog({ kind: "mark", mark }),
      onAnnotate: canAnnotate
        ? (panelId: string, time: number) => setDialog({ kind: "annotate", time, panelId })
        : undefined,
    }),
    [onDisplay, marks, canAnnotate, setDialog],
  );

  const alone =
    display.viewPanel === undefined
      ? undefined
      : model.panels.find((p) => p.id === display.viewPanel);
  const dashboardTitle = model.title === "" ? t("dashboards.untitled") : model.title;
  const trail: Crumb[] = [
    { label: t("dashboards.title"), link: { to: "/dashboards", search: {} } },
    ...folderTrail(folders.data ?? [], dashboard.folderId).map((step) => ({
      label: step.name,
      link: { to: "/dashboards" as const, search: { folder: step.id } },
    })),
  ];
  // The editor's trail ends at the dashboard, which leads back to it.
  const editorTrail: Crumb[] = [
    ...trail,
    {
      label: dashboardTitle,
      link: { to: "/dashboards/$dashboardId", params: { dashboardId: dashboard.id }, search: {} },
    },
  ];
  const edited =
    editing === undefined || draft === null
      ? undefined
      : isNewPanel
        ? (fresh ?? undefined)
        : draft.panels.find((p) => p.id === editing);
  const editorTitle = isNewPanel ? t("dashboards.editor.newTitle") : t("dashboards.editor.title");
  const editorView =
    editing === undefined ? null : draft === null ||
      !resolved.ok ||
      (isNewPanel && fresh === null) ? (
      <p className="loading">{t("common.loading")}</p>
    ) : edited === undefined ? (
      <>
        <Breadcrumbs crumbs={[...editorTrail, { label: editorTitle }]} />
        <EmptyState
          icon="dashboards"
          title={t("dashboards.editor.notFound.title")}
          actions={
            <button
              type="button"
              className="button button--secondary"
              onClick={() => leaveEditor("keep")}
            >
              {t("dashboards.editor.back")}
            </button>
          }
        >
          {t("dashboards.editor.notFound.text")}
        </EmptyState>
      </>
    ) : (
      <PanelHostContext value={host}>
        {/*
          The editor shows no filter bar, but query variables still need their options read so a
          panel using $region previews with a value when the editor is opened by its address.
        */}
        <div hidden>
          <VariablesBar
            orgId={orgId}
            dashboardId={dashboard.id}
            variables={model.variables}
            values={values}
            textRange={textRange}
            range={resolved.range}
            run={clock.manual}
            stored={dashboard.model.variables}
            onChange={(name, value) => setValues((v) => ({ ...v, [name]: value }))}
          />
        </div>
        <PanelEditor
          key={edited.id}
          orgId={orgId}
          dashboardId={dashboard.id}
          userId={userId}
          isNew={isNewPanel}
          panel={
            keptEditor !== undefined && keptEditor.key === editing
              ? keptEditor.panel
              : resolvePanel(edited, library)
          }
          original={isNewPanel ? undefined : resolvePanel(edited, library)}
          refresh={clock.run}
          toolbar={
            <>
              <TimeControls
                value={textRange}
                onChange={onRangeChange}
                userId={userId}
                dashboardZone={dashboardZone}
                nowDelay={model.nowDelay}
                shortcuts
                compact
              />
              <RefreshControl onRefresh={tick} compact />
            </>
          }
          range={resolved.range}
          variables={editorValues(edited, rows, values)}
          stored={(() => {
            const saved = dashboard.model.panels.find((p) => p.id === edited.id);
            return saved === undefined ? undefined : resolvePanel(saved, dashboard.libraryPanels);
          })()}
          savedVariables={dashboard.model.variables}
          crumbs={editorTrail}
          onSnapshot={(state) => {
            snapshot.current = state;
            // Kept for a reload a moment after the last change, not on every key.
            window.clearTimeout(keepTimer.current);
            keepTimer.current = window.setTimeout(keepDraft, 400);
          }}
          rows={rows}
          dashboardVariables={model.variables}
          libraryName={
            edited.libraryPanelId === undefined
              ? undefined
              : (library[edited.libraryPanelId]?.name ?? t("libraryPanels.missing"))
          }
          onMakeLibrary={(panel) => setDialog({ kind: "makeLibrary", panel })}
          onApply={() => leaveEditor("apply")}
          onDiscard={() => {
            if (snapshot.current?.changed() === true) {
              setDialog({ kind: "discardPanel", fresh: isNewPanel });
            } else {
              leaveEditor("discard");
            }
          }}
          onSave={(panel) => {
            const linked =
              panel.libraryPanelId === undefined ? undefined : library[panel.libraryPanelId];
            if (linked !== undefined && contentChanged(panel, linked)) {
              onPanelApply(panel, false);
              return;
            }
            applyPanel(linked === undefined ? panel : linkedPlace(panel), isNewPanel);
            if (isNewPanel) {
              // Part of the dashboard now: the editor goes on at the panel's own address.
              leaveMode.current = "keep";
              onDisplay({ editPanel: panel.id, replace: true });
            }
            setDialog({ kind: "save" });
          }}
        />
      </PanelHostContext>
    );
  const mode = display.mode;
  const className = [
    "dashboard",
    mode === "normal" ? "" : "dashboard--kiosk",
    mode === "tv" ? "dashboard--tv" : "",
    idle ? "dashboard--idle" : "",
    alone === undefined ? "" : "dashboard--alone",
    editing === undefined ? "" : "dashboard--editor",
  ]
    .filter((c) => c !== "")
    .join(" ");

  // Time panels share the pointer's time as the dashboard says; one store per setting.
  const sharedCursor = model.sharedCursor ?? "off";
  const crosshair = useMemo(() => createCrosshair(sharedCursor), [sharedCursor]);
  const canAccess = mayManageAccess("dashboard", dashboard.access?.permissions, permissions);
  const toolbarActions = {
    edit: () => setDraft(dashboard.model),
    leaveEdit: () => (dirty ? setDialog({ kind: "discard" }) : setDraft(null)),
    save: () => setDialog({ kind: "save" }),
    addPanel: () => addPanel(),
    addRow,
    addLibraryPanel: () => setDialog({ kind: "libraryPick" }),
    // From view mode the settings start edit mode: they change the draft.
    settings: () => {
      setDraft((current) => current ?? dashboard.model);
      setDialog({ kind: "settings" });
    },
    json: () => setDialog({ kind: "json", readOnly: draft === null }),
    exportJson: () => void exportJson(),
    copyLink: () => void copyLink(),
    saveAs: () => setDialog({ kind: "saveAs" }),
    history: () =>
      void navigate({
        to: "/dashboards/$dashboardId/versions",
        params: { dashboardId: dashboard.id },
      }),
    access: () => setDialog({ kind: "access" }),
    owner: () => setDialog({ kind: "owner" }),
    remove: () => setDialog({ kind: "delete" }),
    kiosk: () => onDisplay({ mode: "kiosk" }),
    tv: () => onDisplay({ mode: "tv" }),
    exitMode: () => onDisplay({ mode: "normal" }),
  };

  // The filter bar at the start of the toolbar: the variables and links. Ad hoc filters (P2-6)
  // join it there.
  const filters =
    !resolved.ok || alone !== undefined || !filtersShown ? null : (
      <div className="dash-filters">
        <VariablesBar
          orgId={orgId}
          dashboardId={dashboard.id}
          variables={model.variables}
          values={values}
          textRange={textRange}
          range={resolved.range}
          run={clock.manual}
          stored={draft === null ? undefined : dashboard.model.variables}
          onChange={(name, value) => setValues((v) => ({ ...v, [name]: value }))}
        />
        <DashboardLinks
          orgId={orgId}
          dashboardId={dashboard.id}
          links={model.links ?? []}
          values={values}
        />
      </div>
    );

  // The rail at the canvas' right edge, on wide screens outside kiosk and TV mode.

  const showRail = wideLayout && mode === "normal";

  /** Shows a panel from the outline: its row opens when it is folded, then it scrolls in. */
  function goToPanel(panel: PanelModel) {
    const row = rows.find((r) => r.id === panel.rowId);
    if (row !== undefined && (openRows[row.id] === undefined ? row.collapsed : !openRows[row.id])) {
      setOpenRows((current) => ({ ...current, [row.id]: true }));
    }
    window.requestAnimationFrame(() => {
      const card = document.querySelector<HTMLElement>(`[data-panel-id="${CSS.escape(panel.id)}"]`);
      // jsdom has no scrollIntoView; every browser has.
      card?.scrollIntoView?.({ block: "nearest" });
      card?.querySelector<HTMLElement>(".panel-menu__button")?.focus();
    });
  }

  /** The address of this dashboard with the time range on screen, for sharing. */
  async function copyLink() {
    const url = new URL(`/dashboards/${dashboard.id}`, window.location.origin);
    url.searchParams.set("from", textRange.from);
    url.searchParams.set("to", textRange.to);
    try {
      await navigator.clipboard.writeText(url.toString());
      showToast({ message: t("toolbar.share.linkCopied") });
    } catch {
      showErrorToast(t("toolbar.share.linkFailed"));
    }
  }

  return (
    <div className={className}>
      {editorView ?? (
        <>
          {mode === "kiosk" ? (
            // Kiosk mode shows only this way out, while the pointer, a touch or a key was used
            // lately (as TV mode shows its bar); keyboard focus always shows it.
            <button
              type="button"
              className="dashboard__exit button button--secondary"
              onClick={() => onDisplay({ mode: "normal" })}
            >
              {t("dashboardTools.view.exit")}
            </button>
          ) : null}
          {mode === "normal" ? (
            <Breadcrumbs
              crumbs={[...trail, { label: dashboardTitle }]}
              extra={<StarButton orgId={orgId} dashboardId={dashboard.id} compact />}
            />
          ) : null}
          {mode === "kiosk" ? null : (
            <DashboardToolbar
              title={dashboardTitle}
              headingId={headingId}
              mode={mode}
              editing={draft !== null}
              dirty={dirty}
              can={{
                edit: canEdit,
                remove: canDelete && !inTrash,
                access: canAccess,
                saveAs: permissions.has("dashboards:write") || canEdit,
              }}
              controls={controls}
              filters={filters}
              rangeError={resolved.ok ? undefined : t(`dashboards.time.error.${resolved.error}`)}
              range={textRange}
              onRange={onRangeChange}
              userId={userId}
              dashboardZone={dashboardZone}
              nowDelay={model.nowDelay}
              shortcuts={dialog === null}
              refreshSeconds={refresh}
              onRefreshSeconds={setRefresh}
              refreshIntervals={model.refreshIntervals}
              onRefresh={tick}
              actions={toolbarActions}
            />
          )}
          {inTrash && mode === "normal" ? (
            <div className="dashboard__mode" role="status">
              <Icon name="alert" />
              <span>{t("dashboards.inTrash")}</span>
              {canDelete ? (
                <button
                  type="button"
                  className="button button--secondary button--small"
                  onClick={() => restore.mutate()}
                  disabled={restore.isPending}
                >
                  {t("dashboards.trash.restore")}
                </button>
              ) : null}
            </div>
          ) : null}
          {draft === null ? null : (
            <p className="dashboard__mode" role="status">
              <Icon name="dashboards" />
              {dirty ? t("dashboards.editingUnsaved") : t("dashboards.editing")}
            </p>
          )}
          {notice === null ? null : (
            <p className="dashboard__mode" role="status">
              {notice}
            </p>
          )}
          {resolved.ok ? (
            alone !== undefined ? (
              <div className="dashboard__alone">
                <button
                  type="button"
                  className="button button--secondary dashboard__back"
                  onClick={() => onDisplay({ viewPanel: undefined })}
                >
                  {t("dashboardTools.view.back")}
                </button>
                {/* Alone too, a panel may set variables (a node click) and explore. */}
                <PanelHostContext value={host}>
                  <PanelCard
                    panel={resolvePanel(alone, library)}
                    alone
                    query={{
                      orgId,
                      dashboardId: dashboard.id,
                      range: panelRange(alone, resolved.range, now),
                      variables: editorValues(alone, rows, values),
                      saved: dashboard.model.variables,
                      source: "stored",
                      run: clock.run,
                    }}
                    view={{ ...viewActions, values: editorValues(alone, rows, values) }}
                  />
                </PanelHostContext>
              </div>
            ) : (
              <div className={showRail ? "dash-canvas dash-canvas--rail" : "dash-canvas"}>
                {model.panels.length === 0 && rows.length === 0 ? (
                  <EmptyState
                    icon="dashboards"
                    title={t("dashboards.noPanels.title")}
                    actions={
                      draft !== null ? (
                        <button
                          type="button"
                          className="button button--primary"
                          onClick={() => addPanel()}
                        >
                          {t("dashboards.addPanel")}
                        </button>
                      ) : canEdit ? (
                        <button
                          type="button"
                          className="button button--primary"
                          onClick={() => setDraft(dashboard.model)}
                        >
                          {t("dashboards.edit")}
                        </button>
                      ) : undefined
                    }
                  >
                    {canEdit ? t("dashboards.noPanels.text") : t("dashboards.noPanels.textViewer")}
                  </EmptyState>
                ) : (
                  <PanelHostContext value={host}>
                    <CrosshairContext value={crosshair}>
                      <DashboardGrid
                        panels={model.panels}
                        rows={rows}
                        libraryPanels={library}
                        now={now}
                        query={gridQuery}
                        storedPanels={dashboard.model.panels}
                        collapsed={(row) =>
                          openRows[row.id] === undefined ? row.collapsed : !openRows[row.id]
                        }
                        onToggleRow={(row) =>
                          setOpenRows((current) => {
                            const open = current[row.id] ?? !row.collapsed;
                            return { ...current, [row.id]: !open };
                          })
                        }
                        view={viewActions}
                        edit={editActions}
                      />
                    </CrosshairContext>
                  </PanelHostContext>
                )}
                {showRail ? (
                  <DashboardRail
                    pin={<PinButton orgId={orgId} dashboardId={dashboard.id} />}
                    userId={userId}
                    editing={draft !== null}
                    panels={model.panels}
                    rows={rows}
                    untitled={t("dashboards.panel.untitled")}
                    canEdit={canEdit}
                    onGoTo={goToPanel}
                    filtersShown={filtersShown}
                    onFilters={() => setFiltersShown((shown) => !shown)}
                    annotationsShown={annotationsShown}
                    onAnnotations={() => setAnnotationsShown((shown) => !shown)}
                    actions={{
                      ...toolbarActions,
                      addPanel,
                      fullscreen: () => {
                        // Refused without a user gesture or by policy; nothing to tell then.
                        document.documentElement.requestFullscreen?.().catch(() => undefined);
                      },
                      info: () => setDialog({ kind: "info" }),
                    }}
                  />
                ) : null}
              </div>
            )
          ) : null}
        </>
      )}
      {dialog?.kind === "discardPanel" ? (
        <ConfirmDialog
          title={t("dashboards.editor.discardTitle")}
          confirmLabel={t("dashboards.discard.confirm")}
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDialog(null);
            leaveEditor("discard");
          }}
        >
          {dialog.fresh
            ? t("dashboards.editor.discardNewText")
            : t("dashboards.editor.discardText")}
        </ConfirmDialog>
      ) : null}
      {blocker.status === "blocked" && droppingPanel ? (
        <ConfirmDialog
          title={t("dashboards.editor.discardTitle")}
          confirmLabel={t("dashboards.discard.confirm")}
          onCancel={() => blocker.reset()}
          onConfirm={() => blocker.proceed()}
        >
          {isNewPanel ? t("dashboards.editor.discardNewText") : t("dashboards.editor.discardText")}
        </ConfirmDialog>
      ) : null}
      {blocker.status === "blocked" && !droppingPanel ? (
        <ConfirmDialog
          title={t("dashboards.leave.title")}
          confirmLabel={t("dashboards.leave.confirm")}
          onCancel={() => blocker.reset()}
          onConfirm={() => {
            // Left on purpose: a reload of this dashboard later starts clean.
            writeDraft(owner, dashboard.id, null);
            blocker.proceed();
          }}
        >
          {t("dashboards.discard.text")}
        </ConfirmDialog>
      ) : null}
      {dialog?.kind === "settings" ? (
        <SettingsDialog
          orgId={orgId}
          model={model}
          onApply={(next) => {
            changeDraft(() => next);
            setValues((v) => ({ ...initialVariables(next.variables), ...v }));
            setDialog(null);
          }}
          onJson={() => setDialog({ kind: "json", readOnly: false })}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "json" ? (
        <JsonModelDialog
          orgId={orgId}
          model={model}
          readOnly={dialog.readOnly || draft === null}
          onApply={(next) => {
            changeDraft(() => next);
            setValues((v) => ({ ...initialVariables(next.variables), ...v }));
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "row" ? (
        <RowDialog
          row={dialog.row}
          variables={model.variables}
          onApply={(row) => {
            changeDraft((m) => ({
              ...m,
              rows: (m.rows ?? []).map((r) => (r.id === row.id ? row : r)),
            }));
            setDialog(null);
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "removeRow" ? (
        <ConfirmDialog
          title={t("dashboardTools.rows.removeTitle")}
          confirmLabel={t("dashboardTools.rows.removeConfirm")}
          onCancel={() => setDialog(null)}
          onConfirm={() => removeRow(dialog.row)}
        >
          {t("dashboardTools.rows.removeText", {
            title: dialog.row.title === "" ? t("dashboardTools.rows.untitled") : dialog.row.title,
            count: panelsOf(model.panels, dialog.row.id, rows).length,
          })}
        </ConfirmDialog>
      ) : null}
      {dialog?.kind === "copy" ? (
        <CopyPanelDialog
          orgId={orgId}
          currentId={dashboard.id}
          panel={dialog.panel}
          onDone={(target) => {
            setDialog(null);
            setNotice(t("dashboardTools.copy.done", { title: target.title }));
            void queryClient.invalidateQueries({ queryKey: [DASHBOARDS_KEY, orgId] });
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "saveAs" ? (
        <SaveAsDialog
          orgId={orgId}
          model={model}
          folderId={dashboard.folderId}
          onSave={async ({ title, folderId }) => {
            const created = await createDashboard(orgId, { folderId, model: { ...model, title } });
            setDialog(null);
            await queryClient.invalidateQueries({ queryKey: [DASHBOARDS_KEY, orgId] });
            await navigate({ to: "/dashboards/$dashboardId", params: { dashboardId: created.id } });
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "libraryPick" ? (
        <LibraryPickerDialog
          orgId={orgId}
          onPick={(lib) => {
            setExtraLibrary((current) => ({
              ...current,
              [lib.id]: { id: lib.id, name: lib.name, version: lib.version, model: lib.panel },
            }));
            const place = newPanel();
            applyPanel(
              linkedPlace({ ...lib.panel, id: place.id, grid: place.grid, libraryPanelId: lib.id }),
              true,
            );
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "makeLibrary" ? (
        <MakeLibraryDialog
          orgId={orgId}
          panel={dialog.panel}
          onCreate={async ({ name, folderId }) => {
            const created = await createLibraryPanel(orgId, {
              name,
              folderId,
              panel: dialog.panel,
            });
            setExtraLibrary((current) => ({
              ...current,
              [created.id]: {
                id: created.id,
                name: created.name,
                version: created.version,
                model: created.panel,
              },
            }));
            const isNew = !(draft?.panels ?? []).some((p) => p.id === dialog.panel.id);
            applyPanel(linkedPlace({ ...dialog.panel, libraryPanelId: created.id }), isNew);
            // Made from the editor: the panel now shows the library panel; the editor's own copy
            // of it must not overwrite that on the way out.
            if (editing !== undefined) {
              leaveEditor("keep");
            }
            await queryClient.invalidateQueries({ queryKey: [LIBRARY_PANELS_KEY, orgId] });
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "librarySave" ? (
        <LibrarySaveDialog
          orgId={orgId}
          libraryId={dialog.panel.libraryPanelId ?? ""}
          name={library[dialog.panel.libraryPanelId ?? ""]?.name ?? dialog.panel.title}
          busy={librarySave.isPending}
          error={
            librarySave.isError
              ? isApiError(librarySave.error, "version_conflict")
                ? t("libraryPanels.changed")
                : errorMessage(t, librarySave.error)
              : undefined
          }
          onConfirm={() => librarySave.mutate({ panel: dialog.panel, isNew: dialog.isNew })}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "annotate" ? (
        <AnnotationDialog
          mode="add"
          orgId={orgId}
          dashboardId={dashboard.id}
          time={dialog.time}
          panelId={dialog.panelId}
          canWrite={canAnnotate}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "mark" ? (
        <AnnotationDialog
          mode="open"
          orgId={orgId}
          dashboardId={dashboard.id}
          mark={dialog.mark}
          canWrite={canAnnotate}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "save" && draft !== null ? (
        <SaveDialog
          busy={save.isPending}
          error={
            save.isError && !isApiError(save.error, "version_conflict")
              ? saveErrorText(t, save.error)
              : undefined
          }
          onSave={(message) => save.mutate({ next: draft, version: dashboard.version, message })}
          onClose={() => {
            save.reset();
            setDialog(null);
          }}
        />
      ) : null}
      {dialog?.kind === "conflict" && draft !== null ? (
        <ConflictDialog
          base={dashboard.model}
          mine={draft}
          current={dialog.current}
          busy={save.isPending}
          error={save.isError ? saveErrorText(t, save.error) : undefined}
          onOverwrite={() =>
            save.mutate({
              next: draft,
              version: dialog.current.version,
              message: dialog.message,
            })
          }
          onTakeTheirs={() => {
            setDialog(null);
            setDraft(null);
            queryClient.setQueryData(dashboardQuery(orgId, dashboard.id).queryKey, dialog.current);
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "discard" ? (
        <ConfirmDialog
          title={t("dashboards.discard.title")}
          confirmLabel={t("dashboards.discard.confirm")}
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            setDraft(null);
            setDialog(null);
          }}
        >
          {t("dashboards.discard.text")}
        </ConfirmDialog>
      ) : null}
      {dialog?.kind === "delete" ? (
        <ConfirmDialog
          title={t("dashboards.delete.title")}
          confirmLabel={t("dashboards.delete.confirm")}
          onCancel={() => setDialog(null)}
          onConfirm={() => remove.mutate()}
          busy={remove.isPending}
          error={remove.isError ? errorMessage(t, remove.error) : undefined}
        >
          {t("dashboards.delete.text", { title: model.title })}
        </ConfirmDialog>
      ) : null}
      {dialog?.kind === "info" ? (
        <DashboardInfo
          dashboard={dashboard}
          folder={folders.data?.find((f) => f.id === dashboard.folderId)?.name}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "access" ? (
        <AccessDialog
          open
          onClose={() => setDialog(null)}
          resource={{ type: "dashboard", id: dashboard.id, name: dashboard.title }}
        />
      ) : null}
      {dialog?.kind === "owner" ? (
        <OwnerDialog
          orgId={orgId}
          kind="dashboards"
          id={dashboard.id}
          name={dashboard.title}
          owner={dashboard.ownerTeam}
          visibility={dashboard.teamOnly ? "team" : "shared"}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {save.isError && dialog === null && !isApiError(save.error, "version_conflict") ? (
        <FormAlert>{saveErrorText(t, save.error)}</FormAlert>
      ) : null}
    </div>
  );
}
