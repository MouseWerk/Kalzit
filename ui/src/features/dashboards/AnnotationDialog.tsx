import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { isApiError } from "../../api/client";
import { TextField } from "../../components/TextField";
import { useI18n } from "../../i18n/i18n";
import type { DashboardMark } from "./annotations";
import {
  ANNOTATIONS_KEY,
  createAnnotation,
  deleteAnnotation,
  updateAnnotation,
} from "./featuresApi";
import { toLocalInput } from "./timeRange";
import { Dialog } from "./ui/Dialog";
import { errorMessage } from "./ui/errors";
import "./dashboardTools.css";

type Props = {
  orgId: string;
  dashboardId: string;
  /** May add, change and delete written annotations. */
  canWrite: boolean;
  onClose: () => void;
} & ({ mode: "add"; time: number; panelId: string | null } | { mode: "open"; mark: DashboardMark });

function fromLocalInput(text: string): number | null {
  const ms = new Date(text).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Adds an annotation at a time (from a click, a key or the panel menu), or shows one. A written
 * annotation can be changed and deleted by those who may write; results of annotation queries are
 * shown read-only, since they live in the data source.
 */
export function AnnotationDialog(props: Props) {
  const { t, language } = useI18n();
  const formId = useId();
  const queryClient = useQueryClient();
  const existing = props.mode === "open" ? props.mark.annotation : undefined;
  const readOnly = props.mode === "open" && (existing === undefined || !props.canWrite);
  const startTime = props.mode === "add" ? props.time : props.mark.time;
  const startEnd = props.mode === "add" ? null : props.mark.timeEnd;
  const [time, setTime] = useState(toLocalInput(startTime));
  const [isSpan, setIsSpan] = useState(startEnd !== null);
  const [end, setEnd] = useState(toLocalInput(startEnd ?? startTime));
  const [text, setText] = useState(props.mode === "add" ? "" : props.mark.text);
  const [tags, setTags] = useState(props.mode === "add" ? "" : props.mark.tags.join(", "));
  const [problem, setProblem] = useState<string | null>(null);

  const done = async () => {
    await queryClient.invalidateQueries({
      queryKey: [ANNOTATIONS_KEY, props.orgId, props.dashboardId],
    });
    props.onClose();
  };
  const save = useMutation({
    mutationFn: async () => {
      const at = fromLocalInput(time);
      const until = isSpan ? fromLocalInput(end) : null;
      const tagList = tags
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag !== "");
      if (at === null || (isSpan && (until === null || until < at))) {
        throw new Error("time");
      }
      const input = { time: at, timeEnd: until, text: text.trim(), tags: [...new Set(tagList)] };
      if (existing === undefined) {
        await createAnnotation(props.orgId, props.dashboardId, {
          ...input,
          panelId: props.mode === "add" ? props.panelId : null,
        });
      } else {
        await updateAnnotation(props.orgId, props.dashboardId, existing.id, {
          ...input,
          version: existing.version,
        });
      }
    },
    onSuccess: done,
    onError: (error) =>
      setProblem(
        error instanceof Error && error.message === "time"
          ? t("annotations.timeInvalid")
          : isApiError(error, "version_conflict")
            ? t("annotations.changed")
            : errorMessage(t, error),
      ),
  });
  const remove = useMutation({
    mutationFn: () => deleteAnnotation(props.orgId, props.dashboardId, existing?.id ?? ""),
    onSuccess: done,
    onError: (error) => setProblem(errorMessage(t, error)),
  });

  if (readOnly && props.mode === "open") {
    const mark = props.mark;
    return (
      <Dialog title={t("annotations.title")} onClose={props.onClose}>
        <dl className="ann-details">
          <dt>{t("annotations.time")}</dt>
          <dd>
            {new Date(mark.time).toLocaleString(language)}
            {mark.timeEnd === null ? "" : ` – ${new Date(mark.timeEnd).toLocaleString(language)}`}
          </dd>
          <dt>{t("annotations.text")}</dt>
          <dd className="ann-details__text">{mark.text}</dd>
          {mark.tags.length === 0 ? null : (
            <>
              <dt>{t("annotations.tags")}</dt>
              <dd>{mark.tags.join(", ")}</dd>
            </>
          )}
        </dl>
        {existing === undefined ? (
          <p className="field__hint">{t("annotations.fromQuery")}</p>
        ) : null}
      </Dialog>
    );
  }

  return (
    <Dialog
      title={existing === undefined ? t("annotations.addTitle") : t("annotations.editTitle")}
      onClose={props.onClose}
      actions={
        <>
          {existing === undefined ? null : (
            <button
              type="button"
              className="button button--danger"
              onClick={() => remove.mutate()}
              disabled={remove.isPending}
            >
              {t("annotations.delete")}
            </button>
          )}
          <button type="button" className="button button--secondary" onClick={props.onClose}>
            {t("dashboards.dialog.cancel")}
          </button>
          <button
            type="submit"
            form={formId}
            className="button button--primary"
            disabled={save.isPending}
          >
            {t("annotations.save")}
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
          setProblem(null);
          if (text.trim() === "") {
            setProblem(t("annotations.textRequired"));
            return;
          }
          save.mutate();
        }}
      >
        <TextField
          label={t("annotations.time")}
          type="datetime-local"
          value={time}
          onValueChange={setTime}
        />
        <label className="checkbox">
          <input
            type="checkbox"
            checked={isSpan}
            onChange={(e) => setIsSpan(e.currentTarget.checked)}
          />
          {t("annotations.span")}
        </label>
        {isSpan ? (
          <TextField
            label={t("annotations.end")}
            type="datetime-local"
            value={end}
            onValueChange={setEnd}
          />
        ) : null}
        <div className="field">
          <label className="field__label" htmlFor={`${formId}-text`}>
            {t("annotations.text")}
          </label>
          <textarea
            id={`${formId}-text`}
            className="input ann-text"
            value={text}
            maxLength={2000}
            onChange={(event) => setText(event.currentTarget.value)}
            data-autofocus
          />
        </div>
        <TextField
          label={t("annotations.tags")}
          hint={t("annotations.tagsHint")}
          value={tags}
          onValueChange={setTags}
          autoComplete="off"
        />
        {problem === null ? null : (
          <p className="notice notice--danger" role="alert">
            {problem}
          </p>
        )}
      </form>
    </Dialog>
  );
}
