import { useMutation, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { isApiError } from "../../api/client";
import { FormAlert } from "../../components/FormAlert";
import { TextField } from "../../components/TextField";
import { useI18n } from "../../i18n/i18n";
import { useOrgPermissions } from "../../org/useOrg";
import {
  type Dashboard,
  type Folder,
  fetchDashboard,
  fetchDashboards,
  foldersQuery,
  saveDashboard,
} from "./api";
import {
  fetchLibraryPanels,
  fetchLibraryUses,
  LIBRARY_PANELS_KEY,
  type LibraryPanel,
  validateModel,
} from "./featuresApi";
import { sectionBottom } from "./layout";
import {
  type DashboardModel,
  newPanelId,
  type PanelModel,
  type RowModel,
  type VariableModel,
} from "./model";
import { ConfirmDialog, Dialog } from "./ui/Dialog";
import { errorMessage } from "./ui/errors";
import "./dashboardTools.css";

/** Folders a dashboard or library panel may go into: those the caller may write in. */
export function FolderPicker({
  folders,
  value,
  onChange,
  label,
  topLevel,
}: {
  folders: readonly Folder[];
  value: string | null;
  onChange: (id: string | null) => void;
  label: string;
  /** May write at the top level, outside every folder. */
  topLevel: boolean;
}) {
  const { t } = useI18n();
  const id = useId();
  const writable = folders.filter((f) => f.access?.write ?? true);
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="select"
        value={value ?? ""}
        onChange={(event) =>
          onChange(event.currentTarget.value === "" ? null : event.currentTarget.value)
        }
      >
        {topLevel ? <option value="">{t("dashboards.folders.none")}</option> : null}
        {writable.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A row's title and repeat. */
export function RowDialog({
  row,
  variables,
  onApply,
  onClose,
}: {
  row: RowModel;
  variables: readonly VariableModel[];
  onApply: (row: RowModel) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const formId = useId();
  const [title, setTitle] = useState(row.title);
  const [repeat, setRepeat] = useState(row.repeat?.variable ?? "");
  const multi = variables.filter((v) => v.multi === true);
  return (
    <Dialog
      title={t("dashboardTools.rows.dialogTitle")}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("dashboards.dialog.cancel")}
          </button>
          <button type="submit" form={formId} className="button button--primary">
            {t("dashboards.editor.apply")}
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
          const next: RowModel = { ...row, title: title.trim() };
          if (repeat === "") {
            delete next.repeat;
          } else {
            next.repeat = { variable: repeat };
          }
          onApply(next);
        }}
      >
        <TextField
          label={t("dashboardTools.rows.titleField")}
          value={title}
          onValueChange={setTitle}
          autoComplete="off"
          data-autofocus
        />
        <div className="field">
          <label className="field__label" htmlFor={`${formId}-repeat`}>
            {t("dashboardTools.repeat.rowVariable")}
          </label>
          <p className="field__hint" id={`${formId}-hint`}>
            {t("dashboardTools.repeat.rowHint")}
          </p>
          <select
            id={`${formId}-repeat`}
            className="select"
            aria-describedby={`${formId}-hint`}
            value={repeat}
            onChange={(event) => setRepeat(event.currentTarget.value)}
          >
            <option value="">{t("dashboardTools.repeat.none")}</option>
            {multi.map((v) => (
              <option key={v.name} value={v.name}>
                {v.label ?? v.name}
              </option>
            ))}
          </select>
        </div>
      </form>
    </Dialog>
  );
}

/** "Save as": the dashboard as it is shown (unsaved changes included) as a new dashboard. */
export function SaveAsDialog({
  orgId,
  model,
  folderId,
  onSave,
  onClose,
}: {
  orgId: string;
  model: DashboardModel;
  folderId: string | null;
  onSave: (input: { title: string; folderId: string | null }) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const formId = useId();
  const permissions = useOrgPermissions();
  const folders = useQuery(foldersQuery(orgId));
  const [title, setTitle] = useState(
    t("dashboardTools.saveAs.defaultTitle", { title: model.title }),
  );
  const [folder, setFolder] = useState(folderId);
  const save = useMutation({ mutationFn: () => onSave({ title: title.trim(), folderId: folder }) });
  return (
    <Dialog
      title={t("dashboardTools.saveAs.title")}
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
            disabled={save.isPending || title.trim() === ""}
          >
            {t("dashboardTools.saveAs.submit")}
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
          if (title.trim() !== "") save.mutate();
        }}
      >
        <FormAlert>{save.isError ? errorMessage(t, save.error) : undefined}</FormAlert>
        <TextField
          label={t("dashboards.new.titleLabel")}
          value={title}
          onValueChange={setTitle}
          autoComplete="off"
          data-autofocus
        />
        <FolderPicker
          folders={folders.data ?? []}
          value={folder}
          onChange={setFolder}
          label={t("dashboards.column.folder")}
          topLevel={permissions.has("dashboards:write")}
        />
      </form>
    </Dialog>
  );
}

/**
 * Copies one panel to another dashboard the caller may edit: it is added at the bottom, outside
 * every row, and saved there as a new version right away.
 */
export function CopyPanelDialog({
  orgId,
  currentId,
  panel,
  onDone,
  onClose,
}: {
  orgId: string;
  currentId: string;
  panel: PanelModel;
  onDone: (target: Dashboard) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const formId = useId();
  const [q, setQ] = useState("");
  const [target, setTarget] = useState<string | null>(null);
  const list = useQuery({
    queryKey: ["dashboards", orgId, "copy-targets", q],
    queryFn: ({ signal }) => fetchDashboards(orgId, { q }, signal),
  });
  const choices = (list.data?.items ?? []).filter(
    (d) => d.id !== currentId && d.access?.write !== false,
  );
  const copy = useMutation({
    mutationFn: async (id: string) => {
      const dashboard = await fetchDashboard(orgId, id);
      const rows = dashboard.model.rows ?? [];
      const { rowId: _row, repeat, ...rest } = panel;
      const known = dashboard.model.variables.some(
        (v) => v.name === repeat?.variable && v.multi === true,
      );
      const copied: PanelModel = {
        ...structuredClone(rest),
        ...(repeat !== undefined && known ? { repeat } : {}),
        id: newPanelId(),
        grid: { ...panel.grid, x: 0, y: sectionBottom(dashboard.model.panels, null, rows) },
      };
      const model = { ...dashboard.model, panels: [...dashboard.model.panels, copied] };
      await saveDashboard(orgId, id, {
        model,
        version: dashboard.version,
        message: t("dashboardTools.copy.message", { title: panel.title }),
      });
      return dashboard;
    },
    onSuccess: onDone,
  });
  return (
    <Dialog
      title={t("dashboardTools.copy.title")}
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
            disabled={target === null || copy.isPending}
          >
            {t("dashboardTools.copy.submit")}
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
          if (target !== null) copy.mutate(target);
        }}
      >
        <FormAlert>
          {copy.isError
            ? isApiError(copy.error, "version_conflict")
              ? t("dashboardTools.copy.changed")
              : errorMessage(t, copy.error)
            : undefined}
        </FormAlert>
        <TextField
          label={t("dashboards.search")}
          type="search"
          value={q}
          onValueChange={setQ}
          autoComplete="off"
          data-autofocus
        />
        <fieldset className="tool-choices">
          <legend className="field__label">{t("dashboardTools.copy.target")}</legend>
          {choices.length === 0 && !list.isPending ? (
            <p className="field__hint">{t("dashboardTools.copy.none")}</p>
          ) : null}
          {choices.map((d) => (
            <label key={d.id} className="radio">
              <input
                type="radio"
                name={`${formId}-target`}
                value={d.id}
                checked={target === d.id}
                onChange={() => setTarget(d.id)}
              />
              <span>{d.title}</span>
            </label>
          ))}
        </fieldset>
      </form>
    </Dialog>
  );
}

/** The dashboard model as JSON, checked by the server before it replaces the draft. */
export function JsonModelDialog({
  orgId,
  model,
  readOnly,
  onApply,
  onClose,
}: {
  orgId: string;
  model: DashboardModel;
  readOnly: boolean;
  onApply: (model: DashboardModel) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [original] = useState(() => JSON.stringify(model, null, 2));
  const [text, setText] = useState(original);
  const [problem, setProblem] = useState<string | null>(null);
  // Escape, the close button and Cancel ask before typed changes are lost.
  const [confirming, setConfirming] = useState(false);
  const close = () => (!readOnly && text !== original ? setConfirming(true) : onClose());
  const check = useMutation({
    mutationFn: async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new SyntaxError(error instanceof Error ? error.message : "JSON");
      }
      return validateModel(orgId, parsed);
    },
    onSuccess: (checked) => onApply(checked),
    onError: (error) =>
      setProblem(
        error instanceof SyntaxError
          ? t("dashboardTools.json.syntax", { detail: error.message })
          : isApiError(error, "validation")
            ? t("dashboards.save.modelInvalid", { detail: error.message })
            : errorMessage(t, error),
      ),
  });
  return (
    <Dialog
      title={t("dashboardTools.json.title")}
      onClose={close}
      size="large"
      escapeKeepsInput={false}
      actions={
        <>
          <button type="button" className="button button--secondary" onClick={close}>
            {readOnly ? t("dashboards.dialog.close") : t("dashboards.dialog.cancel")}
          </button>
          {readOnly ? null : (
            <button
              type="button"
              className="button button--primary"
              disabled={check.isPending}
              onClick={() => {
                setProblem(null);
                check.mutate();
              }}
            >
              {t("dashboardTools.json.apply")}
            </button>
          )}
        </>
      }
    >
      <div className="field">
        <label className="field__label" htmlFor={id}>
          {t("dashboardTools.json.label")}
        </label>
        <p className="field__hint" id={`${id}-hint`}>
          {readOnly ? t("dashboardTools.json.readOnlyHint") : t("dashboardTools.json.hint")}
        </p>
        <textarea
          id={id}
          className="input input--mono json-editor"
          value={text}
          readOnly={readOnly}
          spellCheck={false}
          aria-describedby={`${id}-hint`}
          onChange={(event) => setText(event.currentTarget.value)}
          data-autofocus
        />
      </div>
      {problem === null ? null : (
        <p className="notice notice--danger" role="alert">
          {problem}
        </p>
      )}
      {confirming ? (
        <ConfirmDialog
          title={t("dashboardTools.json.discardTitle")}
          confirmLabel={t("dashboards.discard.confirm")}
          onCancel={() => setConfirming(false)}
          onConfirm={onClose}
        >
          {t("dashboardTools.json.discardText")}
        </ConfirmDialog>
      ) : null}
    </Dialog>
  );
}

/** Asks for the name and folder of a new library panel made from a panel. */
export function MakeLibraryDialog({
  orgId,
  panel,
  onCreate,
  onClose,
}: {
  orgId: string;
  panel: PanelModel;
  onCreate: (input: { name: string; folderId: string | null }) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const formId = useId();
  const permissions = useOrgPermissions();
  const folders = useQuery(foldersQuery(orgId));
  const [name, setName] = useState(panel.title);
  const [folder, setFolder] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => onCreate({ name: name.trim(), folderId: folder }),
  });
  return (
    <Dialog
      title={t("libraryPanels.makeTitle")}
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
            disabled={create.isPending || name.trim() === ""}
          >
            {t("libraryPanels.makeSubmit")}
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
          if (name.trim() !== "") create.mutate();
        }}
      >
        <p className="field__hint">{t("libraryPanels.makeHint")}</p>
        <FormAlert>{create.isError ? errorMessage(t, create.error) : undefined}</FormAlert>
        <TextField
          label={t("libraryPanels.name")}
          value={name}
          onValueChange={setName}
          autoComplete="off"
          data-autofocus
        />
        <FolderPicker
          folders={folders.data ?? []}
          value={folder}
          onChange={setFolder}
          label={t("dashboards.column.folder")}
          topLevel={permissions.has("dashboards:write")}
        />
      </form>
    </Dialog>
  );
}

/** Picks a library panel to add to the dashboard. */
export function LibraryPickerDialog({
  orgId,
  onPick,
  onClose,
}: {
  orgId: string;
  onPick: (panel: LibraryPanel) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const formId = useId();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const list = useQuery({
    queryKey: [LIBRARY_PANELS_KEY, orgId, "list", q],
    queryFn: ({ signal }) => fetchLibraryPanels(orgId, q, signal),
  });
  const items = list.data ?? [];
  return (
    <Dialog
      title={t("libraryPanels.pickTitle")}
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
            disabled={picked === null}
          >
            {t("libraryPanels.pickSubmit")}
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
          const panel = items.find((p) => p.id === picked);
          if (panel !== undefined) onPick(panel);
        }}
      >
        <TextField
          label={t("libraryPanels.search")}
          type="search"
          value={q}
          onValueChange={setQ}
          autoComplete="off"
          data-autofocus
        />
        <fieldset className="tool-choices">
          <legend className="field__label">{t("libraryPanels.title")}</legend>
          {items.length === 0 && !list.isPending ? (
            <p className="field__hint">{t("libraryPanels.empty")}</p>
          ) : null}
          {items.map((p) => (
            <label key={p.id} className="radio">
              <input
                type="radio"
                name={`${formId}-panel`}
                value={p.id}
                checked={picked === p.id}
                onChange={() => setPicked(p.id)}
              />
              <span>{p.name}</span>
              <span className="field__hint">{t("libraryPanels.uses", { count: p.uses })}</span>
            </label>
          ))}
        </fieldset>
      </form>
    </Dialog>
  );
}

/**
 * Before a library panel's new content is saved: every dashboard showing it changes, so the
 * editor names how many do.
 */
export function LibrarySaveDialog({
  orgId,
  libraryId,
  name,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  orgId: string;
  libraryId: string;
  name: string;
  busy: boolean;
  error: string | undefined;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const uses = useQuery({
    queryKey: [LIBRARY_PANELS_KEY, orgId, "uses", libraryId],
    queryFn: ({ signal }) => fetchLibraryUses(orgId, libraryId, signal),
  });
  const count = uses.data === undefined ? null : uses.data.items.length;
  return (
    <Dialog
      title={t("libraryPanels.saveTitle")}
      onClose={onClose}
      actions={
        <>
          <button
            type="button"
            className="button button--secondary"
            onClick={onClose}
            data-autofocus
          >
            {t("dashboards.dialog.cancel")}
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={onConfirm}
            disabled={busy}
          >
            {t("libraryPanels.saveConfirm")}
          </button>
        </>
      }
    >
      <p role="status">
        {count === null ? t("common.loading") : t("libraryPanels.saveWarning", { name, count })}
      </p>
      {uses.data === undefined || uses.data.items.length === 0 ? null : (
        <ul className="tool-list">
          {uses.data.items.map((d) => (
            <li key={d.id}>{d.title}</li>
          ))}
        </ul>
      )}
      <FormAlert>{error}</FormAlert>
    </Dialog>
  );
}
