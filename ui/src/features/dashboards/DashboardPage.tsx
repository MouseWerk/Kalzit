import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { isApiError } from "../../api/client";
import { EmptyState } from "../../components/EmptyState";
import { FormAlert } from "../../components/FormAlert";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import { AccessButton } from "./accessIntegration";
import {
  type Dashboard,
  DASHBOARDS_KEY,
  dashboardQuery,
  deleteDashboard,
  fetchDashboard,
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
    />
  );
}

function DashboardView({ orgId, dashboard }: { orgId: string; dashboard: Dashboard }) {
  const { t } = useI18n();
  const permissions = useOrgPermissions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const search = dashboardRoute.useSearch();
  const routeNavigate = dashboardRoute.useNavigate();
  const headingId = useId();
  const canEdit = dashboard.canEdit && permissions.has("dashboards:write");

  const [draft, setDraft] = useState<DashboardModel | null>(() =>
    search.edit === true && dashboard.canEdit ? dashboard.model : null,
  );
  const model = draft ?? dashboard.model;
  const [values, setValues] = useState(() => initialVariables(dashboard.model.variables));
  const [refresh, setRefresh] = useState(dashboard.model.refreshSeconds ?? 0);
  const [clock, setClock] = useState(() => ({ now: Date.now(), run: 0 }));
  const [dialog, setDialog] = useState<
    | { kind: "panel"; panel: PanelModel; isNew: boolean }
    | { kind: "settings" }
    | { kind: "save" }
    | { kind: "conflict"; current: Dashboard }
    | { kind: "discard" }
    | { kind: "delete" }
    | null
  >(null);

  // "?edit" opens edit mode once; it must not reopen it after a save remounts the view.
  useEffect(() => {
    if (search.edit === true) {
      void routeNavigate({ search: (prev) => ({ ...prev, edit: undefined }), replace: true });
    }
  }, [search.edit, routeNavigate]);

  const textRange: TextRange =
    draft === null && search.from !== undefined && search.to !== undefined
      ? { from: search.from, to: search.to }
      : model.timeRange;
  const resolved = resolveRange(textRange, clock.now);
  const tick = () => setClock((c) => ({ now: Date.now(), run: c.run + 1 }));

  useEffect(() => {
    if (refresh <= 0) {
      return;
    }
    const timer = window.setInterval(
      () => setClock((c) => ({ now: Date.now(), run: c.run + 1 })),
      refresh * 1000,
    );
    return () => window.clearInterval(timer);
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
    onError: async (error) => {
      if (isApiError(error, "version_conflict")) {
        // The answer carries the stored dashboard, but the client keeps only the error code;
        // reading it again gives the same thing.
        const current = await fetchDashboard(orgId, dashboard.id).catch(() => null);
        if (current !== null) {
          save.reset();
          setDialog({ kind: "conflict", current });
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
    setClock((c) => ({ now: Date.now(), run: c.run }));
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
                resource={{ kind: "dashboard", id: dashboard.id, name: dashboard.title }}
              />
              {permissions.has("dashboards:delete") && dashboard.canEdit ? (
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
            range={resolved.range}
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
                source: draft === null ? "stored" : "draft",
                run: clock.run,
              }}
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
              ? errorMessage(t, save.error)
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
          error={save.isError ? errorMessage(t, save.error) : undefined}
          onOverwrite={() =>
            save.mutate({
              next: draft,
              version: dialog.current.version,
              message: t("dashboards.conflict.overwriteMessage"),
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
        <FormAlert>{errorMessage(t, save.error)}</FormAlert>
      ) : null}
    </div>
  );
}
