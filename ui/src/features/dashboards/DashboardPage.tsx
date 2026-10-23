import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useBlocker, useNavigate, useParams } from "@tanstack/react-router";
import { type ReactNode, useEffect, useEffectEvent, useId, useMemo, useRef, useState } from "react";
import { isApiError } from "../../api/client";
import { Breadcrumbs, type Crumb, folderTrail } from "../../components/Breadcrumbs";
import { EmptyState } from "../../components/EmptyState";
import { FormAlert } from "../../components/FormAlert";
import { Icon } from "../../components/Icon";
import { type Translate, useI18n } from "../../i18n/i18n";
import { useEscapeLayer } from "../../lib/layers";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import { PanelHostContext } from "../../panels/host";
import { StarButton, useRecordView } from "../../shell/StarButton";
import { datasourcesQuery } from "../datasources/api";
import { preloadCodeEditor } from "../datasources/editors/CodeEditor";
import { AnnotationDialog } from "./AnnotationDialog";
import { AccessButton } from "./accessIntegration";
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
import "./dashboards.css";
import "./dashboardTools.css";
import { DashboardGrid, resolvePanel } from "./DashboardGrid";
import { DashboardLinks } from "./DashboardLinks";
import { buildExport, downloadJson } from "./exportImport";
import { createLibraryPanel, LIBRARY_PANELS_KEY, saveLibraryPanel } from "./featuresApi";
import { moveRow, panelsOf, placeInSection, sectionBottom } from "./layout";
import {
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
import { REFRESH_CHOICES } from "./refresh";
import type { DashboardSearch } from "./routes";
import { ConflictDialog, SaveDialog } from "./SaveDialogs";
import { SettingsDialog } from "./SettingsDialog";
import { TimeRangePicker } from "./TimeRangePicker";
import {
  CopyPanelDialog,
  JsonModelDialog,
  LibraryPickerDialog,
  LibrarySaveDialog,
  MakeLibraryDialog,
  RowDialog,
  SaveAsDialog,
} from "./ToolDialogs";
import { resolveRange, type TextRange } from "./timeRange";
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
  /** The panel open in the full-page editor (its own route). */
  editPanel?: string | undefined;
}

export function DashboardPage() {
  const { t } = useI18n();
  const org = useCurrentOrg();
  const { dashboardId } = dashboardRoute.useParams();
  const search = dashboardRoute.useSearch();
  const navigate = dashboardRoute.useNavigate();
  // Set on the editor's child route only.
  const { panelId } = useParams({ strict: false });
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
        editPanel: panelId,
      }}
      onDisplay={(patch) => {
        if ("editPanel" in patch) {
          // Into the editor and back are entries in the history, so the browser's back button
          // leaves the editor as the Back button does.
          const keep = (prev: DashboardSearch) => ({ ...prev, edit: undefined });
          void (patch.editPanel === undefined
            ? navigate({ to: "/dashboards/$dashboardId", params: { dashboardId }, search: keep })
            : navigate({
                to: "/dashboards/$dashboardId/panels/$panelId/edit",
                params: { dashboardId, panelId: patch.editPanel },
                search: keep,
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
  | null;

/**
 * How the open panel editor is being left: with its change put into the draft (Back, Esc, the
 * browser's back button, a breadcrumb), with the panel put back as it was (Discard), or as it
 * stands because the change already went elsewhere (made into a library panel).
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
  const { t, timeZone, weekStart } = useI18n();
  const permissions = useOrgPermissions();
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

  const [draft, setDraft] = useState<DashboardModel | null>(null);
  // Edit mode is where query editors appear; start loading the editor before one opens.
  useEffect(() => {
    if (draft !== null) {
      void preloadCodeEditor();
    }
  }, [draft]);
  const model = draft ?? dashboard.model;
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
  const userId = appRoute.useRouteContext().me.id;
  const editing = display.editPanel;
  // The open editor's state, read when it is left, and the panel as it was when it opened.
  const snapshot = useRef<EditorSnapshot | null>(null);
  const opened = useRef<OpenedPanel | null>(null);
  const leaveMode = useRef<LeaveMode>("apply");
  // The model as last drawn, for actions that look a panel or row up: reading it from a ref
  // keeps those actions the same objects while the draft changes, so cards are not drawn again.
  const modelRef = useRef(model);
  useEffect(() => {
    modelRef.current = model;
  });

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
    if (editing !== undefined && draft !== null && opened.current?.id !== editing) {
      opened.current = {
        id: editing,
        panel: draft.panels.find((p) => p.id === editing),
        fresh: false,
      };
    }
  }, [editing, draft]);

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
  const textRange: TextRange = useMemo(
    () =>
      draft === null && display.from !== undefined && display.to !== undefined
        ? { from: display.from, to: display.to }
        : model.timeRange,
    [draft, display.from, display.to, model.timeRange],
  );
  const resolved = useMemo(
    () => resolveRange(textRange, clock.now, { timeZone, weekStart }),
    [textRange, clock.now, timeZone, weekStart],
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
          clock.now,
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

  function newPanel(): PanelModel {
    return {
      id: newPanelId(),
      type: "timeseries",
      title: "",
      grid: { x: 0, y: sectionBottom(model.panels, null, rows), ...NEW_PANEL_GRID },
      targets: [],
      transformations: [],
      options: {},
      fieldConfig: {},
    };
  }

  /** A new panel goes into the draft at once and opens in the editor; Discard takes it out. */
  function addPanel() {
    const panel = newPanel();
    changeDraft((m) => ({ ...m, panels: [...m.panels, panel] }));
    opened.current = { id: panel.id, panel: undefined, fresh: true };
    onDisplay({ editPanel: panel.id });
  }

  /** Puts the panel the editor opened back as it was; a panel added just now goes again. */
  function restorePanel(before: OpenedPanel | null) {
    if (before === null) {
      return;
    }
    changeDraft((m) => {
      if (before.fresh) {
        return { ...m, panels: m.panels.filter((p) => p.id !== before.id) };
      }
      const panel = before.panel;
      return panel === undefined
        ? m
        : { ...m, panels: m.panels.map((p) => (p.id === before.id ? panel : p)) };
    });
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

  // Leaving the editor by any route (Back, Esc, the browser's back button, a breadcrumb) puts
  // its change into the draft, unless it was discarded.
  const onEditorLeft = useEffectEvent((left: string) => {
    const state = snapshot.current;
    const before = opened.current;
    const mode = leaveMode.current;
    snapshot.current = null;
    opened.current = null;
    leaveMode.current = "apply";
    if (mode === "discard") {
      restorePanel(before);
    } else if (mode === "apply" && state !== null && state.id === left && state.changed()) {
      onPanelApply(state.panel(), false);
    }
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
  // Leaving the dashboard with unsaved changes asks first; the editor and back do not.
  const unsaved = () => dirtyRef.current || (snapshot.current?.changed() ?? false);
  const blocker = useBlocker({
    shouldBlockFn: ({ next }) => {
      const here = `/dashboards/${dashboard.id}`;
      const staying = next.pathname === here || next.pathname.startsWith(`${here}/panels/`);
      return !staying && unsaved();
    },
    enableBeforeUnload: unsaved,
    withResolver: true,
    disabled: draft === null,
  });
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
  const marks = annotations.marks;
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
      : draft.panels.find((p) => p.id === editing);
  const editorView =
    editing === undefined ? null : draft === null || !resolved.ok ? (
      <p className="loading">{t("common.loading")}</p>
    ) : edited === undefined ? (
      <>
        <Breadcrumbs crumbs={[...editorTrail, { label: t("dashboards.editor.title") }]} />
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
        <PanelEditor
          key={edited.id}
          orgId={orgId}
          dashboardId={dashboard.id}
          userId={userId}
          panel={resolvePanel(edited, library)}
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
          }}
          rows={rows}
          dashboardVariables={model.variables}
          libraryName={
            edited.libraryPanelId === undefined
              ? undefined
              : (library[edited.libraryPanelId]?.name ?? t("libraryPanels.missing"))
          }
          onMakeLibrary={(panel) => setDialog({ kind: "makeLibrary", panel })}
          onBack={() => leaveEditor("apply")}
          onDiscard={() => {
            const fresh = opened.current?.fresh === true;
            if (snapshot.current?.changed() === true || fresh) {
              setDialog({ kind: "discardPanel", fresh });
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
            applyPanel(linked === undefined ? panel : linkedPlace(panel), false);
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

  const moreMenu = (
    <details className="tool-menu">
      <summary className="button button--secondary">{t("dashboardTools.more")}</summary>
      <div className="tool-menu__list">
        <button
          type="button"
          className="button button--ghost"
          onClick={() => onDisplay({ mode: "kiosk" })}
        >
          {t("dashboardTools.view.kiosk")}
        </button>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => onDisplay({ mode: "tv" })}
        >
          {t("dashboardTools.view.tv")}
        </button>
        <button type="button" className="button button--ghost" onClick={() => void exportJson()}>
          {t("dashboardTools.export")}
        </button>
        <button
          type="button"
          className="button button--ghost"
          onClick={() => setDialog({ kind: "json", readOnly: true })}
        >
          {t("dashboardTools.json.view")}
        </button>
        {permissions.has("dashboards:write") || canEdit ? (
          <button
            type="button"
            className="button button--ghost"
            onClick={() => setDialog({ kind: "saveAs" })}
          >
            {t("dashboardTools.saveAs.button")}
          </button>
        ) : null}
      </div>
    </details>
  );

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
            <Breadcrumbs crumbs={[...trail, { label: dashboardTitle }]} />
          ) : null}
          {mode === "kiosk" ? null : (
            <div className="dashboard__bar">
              <h1 className="dashboard__title truncate" id={headingId}>
                {model.title === "" ? t("dashboards.untitled") : model.title}
              </h1>
              <div className="dashboard__tools">
                {controls}
                {resolved.ok ? null : (
                  <span className="field__error">
                    {t(`dashboards.time.error.${resolved.error}`)}
                  </span>
                )}
                <TimeRangePicker value={textRange} onChange={onRangeChange} />
                <button type="button" className="button button--secondary" onClick={tick}>
                  {t("dashboards.refresh")}
                </button>
                <label className="visually-hidden" htmlFor={`${headingId}-refresh`}>
                  {t("dashboards.refresh.auto")}
                </label>
                <select
                  id={`${headingId}-refresh`}
                  className="select"
                  value={refresh}
                  onChange={(event) => setRefresh(Number(event.currentTarget.value))}
                  title={t("dashboards.refresh.auto")}
                >
                  {REFRESH_CHOICES.map((choice) => (
                    <option key={choice.seconds} value={choice.seconds}>
                      {t(choice.label)}
                    </option>
                  ))}
                </select>
                {mode === "tv" ? (
                  <button
                    type="button"
                    className="button button--secondary"
                    onClick={() => onDisplay({ mode: "normal" })}
                  >
                    {t("dashboardTools.view.exit")}
                  </button>
                ) : draft === null ? (
                  <>
                    <StarButton orgId={orgId} dashboardId={dashboard.id} />
                    {canEdit ? (
                      <button
                        type="button"
                        className="button button--primary"
                        onClick={() => setDraft(dashboard.model)}
                      >
                        {t("dashboards.edit")}
                      </button>
                    ) : null}
                    <Link
                      to="/dashboards/$dashboardId/versions"
                      params={{ dashboardId: dashboard.id }}
                      className="button button--secondary"
                    >
                      {t("dashboards.versions")}
                    </Link>
                    <AccessButton
                      allowed={dashboard.access?.permissions}
                      resource={{ kind: "dashboard", id: dashboard.id, name: dashboard.title }}
                    />
                    {canDelete && !inTrash ? (
                      <button
                        type="button"
                        className="button button--secondary"
                        onClick={() => setDialog({ kind: "delete" })}
                      >
                        {t("dashboards.delete")}
                      </button>
                    ) : null}
                    {moreMenu}
                  </>
                ) : (
                  <>
                    {/*
                     * "Done" takes the place of "Edit", so a second click on that spot leaves edit
                     * mode instead of adding a panel by accident.
                     */}
                    <button
                      type="button"
                      className="button button--secondary"
                      onClick={() => (dirty ? setDialog({ kind: "discard" }) : setDraft(null))}
                    >
                      {dirty ? t("dashboards.discard") : t("dashboards.doneEditing")}
                    </button>
                    <button type="button" className="button button--secondary" onClick={addPanel}>
                      {t("dashboards.addPanel")}
                    </button>
                    <button type="button" className="button button--secondary" onClick={addRow}>
                      {t("dashboardTools.rows.add")}
                    </button>
                    <button
                      type="button"
                      className="button button--secondary"
                      onClick={() => setDialog({ kind: "libraryPick" })}
                    >
                      {t("libraryPanels.add")}
                    </button>
                    <button
                      type="button"
                      className="button button--secondary"
                      onClick={() => setDialog({ kind: "settings" })}
                    >
                      {t("dashboards.settings")}
                    </button>
                    <button
                      type="button"
                      className="button button--primary"
                      onClick={() => setDialog({ kind: "save" })}
                      disabled={!dirty}
                    >
                      {t("dashboards.save")}
                    </button>
                  </>
                )}
              </div>
            </div>
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
            <>
              {mode === "kiosk" || alone !== undefined ? null : (
                <>
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
                </>
              )}
              {alone !== undefined ? (
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
                        range: panelRange(alone, resolved.range, clock.now),
                        variables: editorValues(alone, rows, values),
                        saved: dashboard.model.variables,
                        source: "stored",
                        run: clock.run,
                      }}
                      view={{ ...viewActions, values: editorValues(alone, rows, values) }}
                    />
                  </PanelHostContext>
                </div>
              ) : model.panels.length === 0 && rows.length === 0 ? (
                <EmptyState
                  icon="dashboards"
                  title={t("dashboards.noPanels.title")}
                  actions={
                    draft !== null ? (
                      <button type="button" className="button button--primary" onClick={addPanel}>
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
                  <DashboardGrid
                    panels={model.panels}
                    rows={rows}
                    libraryPanels={library}
                    now={clock.now}
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
                </PanelHostContext>
              )}
            </>
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
      {blocker.status === "blocked" ? (
        <ConfirmDialog
          title={t("dashboards.leave.title")}
          confirmLabel={t("dashboards.leave.confirm")}
          onCancel={() => blocker.reset()}
          onConfirm={() => blocker.proceed()}
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
      {save.isError && dialog === null && !isApiError(save.error, "version_conflict") ? (
        <FormAlert>{saveErrorText(t, save.error)}</FormAlert>
      ) : null}
    </div>
  );
}
