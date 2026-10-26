import { useId, useState } from "react";
import { FormAlert } from "../../components/FormAlert";
import { TextField } from "../../components/TextField";
import { useI18n } from "../../i18n/i18n";
import type { Folder } from "../dashboards/api";
import { Dialog } from "../dashboards/ui/Dialog";
import { KindMark } from "../datasources/kindMarks";
import { MAX_DESCRIPTION_CHARS, MAX_TITLE_CHARS } from "./api";
import { placeGroups, visibilityHint } from "./places";
import "./analyses.css";

/**
 * Save: a new analysis (name, location, description, the range); Save as: the same for a copy;
 * Rename: name and description; Move: the location alone.
 */
export type SaveMode = "save" | "saveAs" | "rename" | "move";

export interface SaveValues {
  title: string;
  description: string;
  folderId: string | null;
  /** Keep the time range in use; off follows whatever range is in use when it is opened. */
  keepRange: boolean;
}

/** What goes into the analysis, shown under the fields. */
export interface SaveSummary {
  sourceName: string;
  sourceKind: string;
  queries: number;
  steps: number;
  /** The visualization's name, translated. */
  visualization: string;
}

interface SaveAnalysisDialogProps {
  mode: SaveMode;
  initial: SaveValues;
  folders: readonly Folder[];
  /** Whether the top level of the organization may hold it (the org-wide write). */
  canTop: boolean;
  summary?: SaveSummary | undefined;
  /** The range in use, as the time picker names it ("Last 7 days"). */
  rangeLabel?: string | undefined;
  busy?: boolean;
  /** From a failed attempt. */
  error?: string | undefined;
  onSubmit: (values: SaveValues) => void;
  onClose: () => void;
}

const TITLES: Record<
  SaveMode,
  "analyses.save.title" | "analyses.saveAs.title" | "analyses.rename.title" | "analyses.move.title"
> = {
  save: "analyses.save.title",
  saveAs: "analyses.saveAs.title",
  rename: "analyses.rename.title",
  move: "analyses.move.title",
};

export function SaveAnalysisDialog({
  mode,
  initial,
  folders,
  canTop,
  summary,
  rangeLabel,
  busy = false,
  error,
  onSubmit,
  onClose,
}: SaveAnalysisDialogProps) {
  const { t } = useI18n();
  const formId = useId();
  const [values, setValues] = useState(initial);
  const [titleError, setTitleError] = useState<string | undefined>(undefined);
  const groups = placeGroups(t, folders, canTop);
  // The current place stays choosable even where the caller may not save anew (a move keeps it).
  const known = groups.some((group) => group.places.some((place) => place.id === values.folderId));
  const naming = mode !== "move";
  const placing = mode !== "rename";
  const full = mode === "save" || mode === "saveAs";
  const set = (patch: Partial<SaveValues>) => setValues((current) => ({ ...current, ...patch }));

  function submit() {
    const title = values.title.trim();
    if (naming && title === "") {
      setTitleError(t("analyses.save.nameRequired"));
      return;
    }
    onSubmit({ ...values, title, description: values.description.trim() });
  }

  return (
    <Dialog
      title={t(TITLES[mode])}
      onClose={onClose}
      actions={
        <>
          {full ? (
            <span className="analysis-save__keys" aria-hidden="true">
              {mode === "save" ? t("analyses.keys.save") : t("analyses.keys.saveAs")}
            </span>
          ) : null}
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("analyses.dialog.cancel")}
          </button>
          <button type="submit" form={formId} className="button button--primary" disabled={busy}>
            {mode === "move"
              ? t("analyses.move.submit")
              : mode === "rename"
                ? t("analyses.rename.submit")
                : t("analyses.save.submit")}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="form analysis-save"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        {mode === "save" ? <p className="analysis-save__lead">{t("analyses.save.lead")}</p> : null}
        <FormAlert>{error}</FormAlert>
        {naming ? (
          <TextField
            label={t("analyses.save.name")}
            value={values.title}
            maxLength={MAX_TITLE_CHARS}
            onValueChange={(title) => {
              set({ title });
              setTitleError(undefined);
            }}
            error={titleError}
            data-autofocus
            autoComplete="off"
          />
        ) : null}
        {placing ? (
          <div className="field">
            <label className="field__label" htmlFor={`${formId}-place`}>
              {t("analyses.save.place")}
            </label>
            <select
              id={`${formId}-place`}
              className="select"
              value={values.folderId ?? ""}
              aria-describedby={`${formId}-visible`}
              onChange={(event) =>
                set({
                  folderId: event.currentTarget.value === "" ? null : event.currentTarget.value,
                })
              }
              data-autofocus={naming ? undefined : true}
            >
              {known ? null : (
                <option value={values.folderId ?? ""}>
                  {values.folderId === null
                    ? t("analyses.place.top")
                    : (folders.find((f) => f.id === values.folderId)?.name ?? "")}
                </option>
              )}
              {groups.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.places.map((place) => (
                    <option key={place.id ?? ""} value={place.id ?? ""}>
                      {place.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <p className="field__hint" id={`${formId}-visible`}>
              {visibilityHint(t, folders, values.folderId)}
              {summary === undefined
                ? null
                : ` ${t("analyses.place.queryRight", { source: summary.sourceName })}`}
            </p>
          </div>
        ) : null}
        {naming ? (
          <div className="field">
            <label className="field__label" htmlFor={`${formId}-description`}>
              {t("analyses.save.description")}{" "}
              <span className="analysis-save__optional">{t("analyses.save.optional")}</span>
            </label>
            <textarea
              id={`${formId}-description`}
              className="input analysis-save__description"
              rows={2}
              value={values.description}
              maxLength={MAX_DESCRIPTION_CHARS}
              placeholder={t("analyses.save.descriptionPlaceholder")}
              onChange={(event) => set({ description: event.currentTarget.value })}
            />
          </div>
        ) : null}
        {full && summary !== undefined ? (
          <div className="analysis-save__summary">
            <span className="analysis-save__caption">{t("analyses.save.summary")}</span>
            <span className="analysis-save__parts">
              <span className="analysis-save__source">
                <KindMark kind={summary.sourceKind} small />
                {summary.sourceName}
              </span>
              <span>
                {t(summary.queries === 1 ? "analyses.queriesOne" : "analyses.queriesMany", {
                  count: summary.queries,
                })}
              </span>
              <span>
                {t(summary.steps === 1 ? "analyses.stepsOne" : "analyses.stepsMany", {
                  count: summary.steps,
                })}
              </span>
              <span>{t("analyses.save.visualization", { name: summary.visualization })}</span>
            </span>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={values.keepRange}
                onChange={(event) => set({ keepRange: event.currentTarget.checked })}
              />
              {t("analyses.save.keepRange")}
              {rangeLabel === undefined ? null : (
                <span className="analysis-save__muted">
                  {t("analyses.save.keepRangeValue", { range: rangeLabel })}
                </span>
              )}
            </label>
          </div>
        ) : null}
      </form>
    </Dialog>
  );
}
