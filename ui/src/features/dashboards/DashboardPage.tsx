import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { isApiError } from "../../api/client";
import { EmptyState } from "../../components/EmptyState";
import { FormAlert } from "../../components/FormAlert";
import { Icon } from "../../components/Icon";
import { type Translate, useI18n } from "../../i18n/i18n";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import { preloadCodeEditor } from "../datasources/editors/CodeEditor";
import { AccessButton } from "./accessIntegration";
import {
  DASHBOARDS_KEY,
  type Dashboard,
  dashboardFromBody,
  dashboardQuery,
  deleteDashboard,
  fetchDashboard,
  restoreDashboard,
  saveDashboard,
} from "./api";
import "./dashboards.css";
import { DashboardGrid } from "./DashboardGrid";
import {
  bottomRow,
  type DashboardModel,
  type GridPos,
  newPanelId,
  type PanelModel,
  placePanel,
} from "./model";
import { PanelEditor } from "./PanelEditor";
import { REFRESH_CHOICES } from "./refresh";
import { ConflictDialog, SaveDialog } from "./SaveDialogs";
import { SettingsDialog } from "./SettingsDialog";
import { TimeRangePicker } from "./TimeRangePicker";
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

/** Size of a new panel: half the width, a comfortable chart height. */
const NEW_PANEL_GRID = { w: 12, h: 8 };

export function DashboardPage() {
  const { t } = useI18n();
  const org = useCurrentOrg();
  if (org === undefined) {
    return (
      <EmptyState icon="dashboards" title={t("dashboards.noOrg.title")}>
        {t("dashboards.noOrg.text")}
      </EmptyState>
    );
  }
  return <DashboardLoader orgId={org.id} />;
}

function DashboardLoader({ orgId }: { orgId: string }) {
  const { t } = useI18n();
  const { dashboardId } = dashboardRoute.useParams();
  const dashboard = useQuery(dashboardQuery(orgId, dashboardId));
  // Variable values the viewer picked, per dashboard: a save starts a new version (and a fresh
  // view), which must not throw the picks away.
  const picked = useRef(new Map<string, Record<string, string>>());

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
    />
  );
}

function DashboardView({
  orgId,
  dashboard,
  picked,
}: {
  orgId: string;
  dashboard: Dashboard;
  picked: Map<string, Record<string, string>>;
}) {
  const { t } = useI18n();
  const permissions = useOrgPermissions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const search = dashboardRoute.useSearch();
  const routeNavigate = dashboardRoute.useNavigate();
  const headingId = useId();
  // Dashboards in restricted folders are hidden altogether, so whoever sees one may edit it when
  // their role allows; the server checks the folder grant on save. A trashed one is read-only.
  const inTrash = dashboard.deletedAt !== null;
  // What this caller may do here, grants included; the organization role until the server
  // answers with `access`.
  const canEdit = (dashboard.access?.write ?? permissions.has("dashboards:write")) && !inTrash;
  const canDelete = dashboard.access?.delete ?? permissions.has("dashboards:delete");

  const [draft, setDraft] = useState<DashboardModel | null>(null);
  // Edit mode is where query editors appear; start loading the editor before one opens.
  useEffect(() => {
    if (draft !== null) {
      void preloadCodeEditor();
    }
  }, [draft]);
  const model = draft ?? dashboard.model;
  const [values, setValues] = useState(() => {
    const start = initialVariables(dashboard.model.variables);
    const kept = Object.entries(picked.get(dashboard.id) ?? {}).filter(([name]) => name in start);
    return { ...start, ...Object.fromEntries(kept) };
  });
  useEffect(() => {
    picked.set(dashboard.id, values);
  }, [picked, dashboard.id, values]);
  const [refresh, setRefresh] = useState(dashboard.model.refreshSeconds ?? 0);
  // `run` re-runs the panels (refresh, auto refresh); `manual` counts only the Refresh button,
  // which also reads variable options again.
  const [clock, setClock] = useState(() => ({ now: Date.now(), run: 0, manual: 0 }));
  const [dialog, setDialog] = useState<
    | { kind: "panel"; panel: PanelModel; isNew: boolean }
    | { kind: "settings" }
    | { kind: "save" }
    | { kind: "conflict"; current: Dashboard; message: string }
    | { kind: "discard" }
    | { kind: "delete" }
    | null
  >(null);

  // "?edit" opens edit mode once, and only for someone who may edit; it must not reopen it after
  // a save remounts the view. Permissions arrive after the first render, so this waits for them.
  useEffect(() => {
    if (search.edit !== true || !permissions.loaded) {
      return;
    }
    if (canEdit) {
      setDraft((current) => current ?? dashboard.model);
    }
    void routeNavigate({ search: (prev) => ({ ...prev, edit: undefined }), replace: true });
  }, [search.edit, permissions.loaded, canEdit, dashboard.model, routeNavigate]);

  const textRange: TextRange =
    draft === null && search.from !== undefined && search.to !== undefined
      ? { from: search.from, to: search.to }
      : model.timeRange;
  const resolved = resolveRange(textRange, clock.now);
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

  const changeDraft = (change: (current: DashboardModel) => DashboardModel) =>
    setDraft((current) => (current === null ? current : change(current)));

  function onRangeChange(range: TextRange) {
    if (draft !== null) {
      changeDraft((m) => ({ ...m, timeRange: range }));
    } else {
      void routeNavigate({
        search: (prev) => ({ ...prev, from: range.from, to: range.to }),
        replace: true,
      });
    }
    setClock((c) => ({ ...c, now: Date.now() }));
  }

  function addPanel() {
    setDialog({
      kind: "panel",
      isNew: true,
      panel: {
        id: newPanelId(),
        type: "timeseries",
        title: "",
        grid: { x: 0, y: bottomRow(model.panels), ...NEW_PANEL_GRID },
        targets: [],
        transformations: [],
        options: {},
        fieldConfig: {},
      },
    });
  }

  function applyPanel(panel: PanelModel, isNew: boolean) {
    changeDraft((m) => ({
      ...m,
      panels: isNew ? [...m.panels, panel] : m.panels.map((p) => (p.id === panel.id ? panel : p)),
    }));
    setDialog(null);
  }

  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(dashboard.model);
  const editActions =
    draft === null
      ? undefined
      : {
          onEdit: (id: string) => {
            const panel = draft.panels.find((p) => p.id === id);
            if (panel !== undefined) {
              setDialog({ kind: "panel", panel, isNew: false });
            }
          },
          onDuplicate: (id: string) =>
            changeDraft((m) => {
              const source = m.panels.find((p) => p.id === id);
              if (source === undefined) {
                return m;
              }
              const copy = { ...structuredClone(source), id: newPanelId() };
              copy.grid.y = source.grid.y + source.grid.h;
              return { ...m, panels: placePanel([...m.panels, copy], copy.id, copy.grid) };
            }),
          onRemove: (id: string) =>
            changeDraft((m) => ({ ...m, panels: m.panels.filter((p) => p.id !== id) })),
          onGrid: (id: string, grid: GridPos) =>
            changeDraft((m) => ({ ...m, panels: placePanel(m.panels, id, grid) })),
        };

  return (
    <div className="dashboard">
      <div className="dashboard__bar">
        <h1 className="dashboard__title truncate" id={headingId}>
          {model.title === "" ? t("dashboards.untitled") : model.title}
        </h1>
        <div className="dashboard__tools">
          {resolved.ok ? null : (
            <span className="field__error">{t(`dashboards.time.error.${resolved.error}`)}</span>
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
          {draft === null ? (
            <>
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
            </>
          ) : (
            <>
              <button type="button" className="button button--secondary" onClick={addPanel}>
                {t("dashboards.addPanel")}
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
                className="button button--secondary"
                onClick={() => (dirty ? setDialog({ kind: "discard" }) : setDraft(null))}
              >
                {dirty ? t("dashboards.discard") : t("dashboards.doneEditing")}
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
      {inTrash ? (
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
      {resolved.ok ? (
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
          {model.panels.length === 0 ? (
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
            <DashboardGrid
              panels={model.panels}
              query={{
                orgId,
                dashboardId: dashboard.id,
                range: resolved.range,
                variables: values,
                saved: dashboard.model.variables,
                source: "stored",
                run: clock.run,
              }}
              storedPanels={dashboard.model.panels}
              edit={editActions}
            />
          )}
        </>
      ) : null}
      {dialog?.kind === "panel" && resolved.ok ? (
        <PanelEditor
          orgId={orgId}
          dashboardId={dashboard.id}
          panel={dialog.panel}
          range={resolved.range}
          variables={values}
          onApply={(panel) => applyPanel(panel, dialog.isNew)}
          onClose={() => setDialog(null)}
        />
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
