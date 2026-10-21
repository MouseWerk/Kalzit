import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { FormAlert } from "../../components/FormAlert";
import { TextField } from "../../components/TextField";
import { useI18n } from "../../i18n/i18n";
import {
  createDashboard,
  DASHBOARDS_KEY,
  fetchDashboard,
  fetchDashboards,
  foldersQuery,
  saveDashboard,
} from "../dashboards/api";
import { bottomRow, emptyModel, newPanelId, type PanelModel } from "../dashboards/model";
import type { TextRange } from "../dashboards/timeRange";
import { Dialog } from "../dashboards/ui/Dialog";
import { errorMessage } from "../dashboards/ui/errors";

/** A panel from Explore spans the full width; it is the one thing the user just looked at. */
const PANEL_GRID = { x: 0, w: 24, h: 9 };

interface AddToDashboardDialogProps {
  orgId: string;
  panel: PanelModel;
  range: TextRange;
  onClose: () => void;
}

/** Puts the Explore query into an existing dashboard (as a new version) or a new one. */
export function AddToDashboardDialog({ orgId, panel, range, onClose }: AddToDashboardDialogProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const formId = useId();
  const pickId = useId();
  const folderId = useId();
  const [target, setTarget] = useState<"existing" | "new">("existing");
  const [dashboardId, setDashboardId] = useState("");
  const [title, setTitle] = useState("");
  const [folder, setFolder] = useState("");
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const dashboards = useQuery({
    queryKey: [DASHBOARDS_KEY, orgId, "pick"],
    queryFn: () => fetchDashboards(orgId, {}),
  });
  const folders = useQuery(foldersQuery(orgId));

  const add = useMutation({
    mutationFn: async (): Promise<string> => {
      const newPanel = { ...structuredClone(panel), id: newPanelId() };
      if (target === "new") {
        const model = emptyModel(title.trim());
        model.timeRange = range;
        model.panels = [{ ...newPanel, grid: { ...PANEL_GRID, y: 0 } }];
        const created = await createDashboard(orgId, {
          title: title.trim(),
          folderId: folder === "" ? null : folder,
          model,
        });
        return created.id;
      }
      const existing = await fetchDashboard(orgId, dashboardId);
      const y = bottomRow(existing.model.panels);
      await saveDashboard(orgId, dashboardId, {
        model: {
          ...existing.model,
          panels: [...existing.model.panels, { ...newPanel, grid: { ...PANEL_GRID, y } }],
        },
        version: existing.version,
        message: t("explore.add.message"),
      });
      return dashboardId;
    },
    onSuccess: async (id) => {
      await queryClient.invalidateQueries({ queryKey: [DASHBOARDS_KEY, orgId] });
      onClose();
      await navigate({ to: "/dashboards/$dashboardId", params: { dashboardId: id }, search: {} });
    },
  });

  return (
    <Dialog
      title={t("explore.add.title")}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("dashboards.dialog.cancel")}
          </button>
          <button
            type="submit"
            form={formId}
            className="button button--primary"
            disabled={add.isPending}
          >
            {t("explore.add.submit")}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (target === "new" && title.trim() === "") {
            setProblem(t("dashboards.new.titleRequired"));
            return;
          }
          if (target === "existing" && dashboardId === "") {
            setProblem(t("explore.add.pickRequired"));
            return;
          }
          setProblem(undefined);
          add.mutate();
        }}
      >
        <FormAlert>{add.isError ? errorMessage(t, add.error) : null}</FormAlert>
        <fieldset className="radio-group">
          <legend className="field__label">{t("explore.add.where")}</legend>
          <label className="radio">
            <input
              type="radio"
              name={`${formId}-target`}
              checked={target === "existing"}
              onChange={() => setTarget("existing")}
              data-autofocus
            />
            {t("explore.add.existing")}
          </label>
          <label className="radio">
            <input
              type="radio"
              name={`${formId}-target`}
              checked={target === "new"}
              onChange={() => setTarget("new")}
            />
            {t("explore.add.new")}
          </label>
        </fieldset>
        {target === "existing" ? (
          <div className="field">
            <label className="field__label" htmlFor={pickId}>
              {t("explore.add.dashboard")}
            </label>
            <select
              id={pickId}
              className="select"
              value={dashboardId}
              onChange={(event) => {
                setDashboardId(event.currentTarget.value);
                setProblem(undefined);
              }}
              aria-invalid={problem === undefined ? undefined : true}
              aria-describedby={problem === undefined ? undefined : `${pickId}-error`}
            >
              <option value="">{t("explore.add.pick")}</option>
              {(dashboards.data?.items ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title === "" ? t("dashboards.untitled") : d.title}
                </option>
              ))}
            </select>
            {problem === undefined ? null : (
              <p className="field__error" id={`${pickId}-error`}>
                {problem}
              </p>
            )}
          </div>
        ) : (
          <>
            <TextField
              label={t("dashboards.new.titleLabel")}
              value={title}
              onValueChange={(value) => {
                setTitle(value);
                setProblem(undefined);
              }}
              error={problem}
              autoComplete="off"
            />
            <div className="field">
              <label className="field__label" htmlFor={folderId}>
                {t("dashboards.column.folder")}
              </label>
              <select
                id={folderId}
                className="select"
                value={folder}
                onChange={(event) => setFolder(event.currentTarget.value)}
              >
                <option value="">{t("dashboards.folders.none")}</option>
                {(folders.data ?? []).map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </div>
          </>
        )}
      </form>
    </Dialog>
  );
}
