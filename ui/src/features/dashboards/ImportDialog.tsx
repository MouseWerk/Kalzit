import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { isApiError } from "../../api/client";
import { FormAlert } from "../../components/FormAlert";
import { useI18n } from "../../i18n/i18n";
import { useOrgPermissions } from "../../org/useOrg";
import { datasourcesQuery } from "../datasources/api";
import { createDashboard, DASHBOARDS_KEY, foldersQuery } from "./api";
import {
  type ExportedSource,
  readImport,
  referencedSources,
  remapSources,
  suggestMapping,
} from "./exportImport";
import { validateModel } from "./featuresApi";
import type { DashboardModel } from "./model";
import { FolderPicker } from "./ToolDialogs";
import { Dialog } from "./ui/Dialog";
import { errorMessage } from "./ui/errors";
import "./dashboardTools.css";

/**
 * Imports a dashboard from a JSON file or pasted text. The server checks the model first; then
 * each data source the dashboard uses is mapped to one of this organization's, preselected by kind
 * and name, and the user confirms the mapping before the dashboard is created.
 */
export function ImportDialog({
  orgId,
  folderId,
  onClose,
}: {
  orgId: string;
  folderId: string | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const formId = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const permissions = useOrgPermissions();
  const folders = useQuery(foldersQuery(orgId));
  const sources = useQuery(datasourcesQuery(orgId));
  const [text, setText] = useState("");
  const [checked, setChecked] = useState<{
    model: DashboardModel;
    sources: ExportedSource[];
  } | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [folder, setFolder] = useState(folderId);
  const [problem, setProblem] = useState<string | null>(null);
  const available = (sources.data ?? []).map((s) => ({ id: s.id, kind: s.kind, name: s.name }));

  const check = useMutation({
    mutationFn: async () => {
      const read = readImport(text);
      if (read === null) {
        throw new SyntaxError("json");
      }
      const model = await validateModel(orgId, read.model);
      const used = referencedSources(model).map(
        (id) => read.sources.find((s) => s.id === id) ?? { id },
      );
      return { model, sources: used };
    },
    onSuccess: (result) => {
      setChecked(result);
      setMapping(suggestMapping(result.sources, available));
    },
    onError: (error) =>
      setProblem(
        error instanceof SyntaxError
          ? t("dashboardTools.import.notJson")
          : isApiError(error, "validation")
            ? t("dashboards.save.modelInvalid", { detail: error.message })
            : errorMessage(t, error),
      ),
  });
  const create = useMutation({
    mutationFn: async () => {
      if (checked === null) return null;
      return createDashboard(orgId, {
        folderId: folder,
        model: remapSources(checked.model, mapping),
      });
    },
    onSuccess: async (created) => {
      if (created === null) return;
      await queryClient.invalidateQueries({ queryKey: [DASHBOARDS_KEY, orgId] });
      onClose();
      await navigate({ to: "/dashboards/$dashboardId", params: { dashboardId: created.id } });
    },
  });
  const unmapped = checked?.sources.some((s) => (mapping[s.id] ?? "") === "") === true;

  async function readFile(file: File | undefined) {
    if (file !== undefined) {
      setText(await file.text());
      setChecked(null);
    }
  }

  return (
    <Dialog
      title={t("dashboardTools.import.title")}
      onClose={onClose}
      size="large"
      actions={
        <>
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("dashboards.dialog.cancel")}
          </button>
          {checked === null ? (
            <button
              type="submit"
              form={formId}
              className="button button--primary"
              disabled={text.trim() === "" || check.isPending}
            >
              {t("dashboardTools.import.check")}
            </button>
          ) : (
            <button
              type="submit"
              form={formId}
              className="button button--primary"
              disabled={unmapped || create.isPending}
            >
              {t("dashboardTools.import.confirm")}
            </button>
          )}
        </>
      }
    >
      <form
        id={formId}
        className="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setProblem(null);
          if (checked === null) {
            check.mutate();
          } else if (!unmapped) {
            create.mutate();
          }
        }}
      >
        <FormAlert>
          {create.isError ? errorMessage(t, create.error) : (problem ?? undefined)}
        </FormAlert>
        {checked === null ? (
          <>
            <div className="field">
              <label className="field__label" htmlFor={`${formId}-file`}>
                {t("dashboardTools.import.file")}
              </label>
              <input
                id={`${formId}-file`}
                type="file"
                accept="application/json,.json"
                className="input"
                onChange={(event) => void readFile(event.currentTarget.files?.[0])}
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor={`${formId}-text`}>
                {t("dashboardTools.import.text")}
              </label>
              <textarea
                id={`${formId}-text`}
                className="input input--mono json-editor"
                value={text}
                spellCheck={false}
                onChange={(event) => {
                  setText(event.currentTarget.value);
                  setChecked(null);
                }}
                data-autofocus
              />
            </div>
          </>
        ) : (
          <>
            <p>{t("dashboardTools.import.checked", { title: checked.model.title })}</p>
            <FolderPicker
              folders={folders.data ?? []}
              value={folder}
              onChange={setFolder}
              label={t("dashboards.column.folder")}
              topLevel={permissions.has("dashboards:write")}
            />
            {checked.sources.length === 0 ? (
              <p className="field__hint">{t("dashboardTools.import.noSources")}</p>
            ) : (
              <fieldset className="settings__group">
                <legend className="section-title">{t("dashboardTools.import.mapping")}</legend>
                <p className="field__hint">{t("dashboardTools.import.mappingHint")}</p>
                {checked.sources.map((source) => {
                  const label =
                    source.name === undefined
                      ? source.id
                      : t("dashboardTools.import.sourceLabel", {
                          name: source.name,
                          kind: source.kind ?? "",
                        });
                  return (
                    <div key={source.id} className="field">
                      <label className="field__label" htmlFor={`${formId}-${source.id}`}>
                        {label}
                      </label>
                      <select
                        id={`${formId}-${source.id}`}
                        className="select"
                        value={mapping[source.id] ?? ""}
                        onChange={(event) => {
                          const value = event.currentTarget.value;
                          setMapping((current) => ({ ...current, [source.id]: value }));
                        }}
                      >
                        <option value="">{t("dashboardTools.import.pick")}</option>
                        {available
                          .filter((a) => source.kind === undefined || a.kind === source.kind)
                          .map((a) => (
                            <option key={a.id} value={a.id}>
                              {a.name}
                            </option>
                          ))}
                      </select>
                    </div>
                  );
                })}
              </fieldset>
            )}
          </>
        )}
      </form>
    </Dialog>
  );
}
