import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { isApiError } from "../../api/client";
import { TextField } from "../../components/TextField";
import { useI18n } from "../../i18n/i18n";
import { wallOf } from "../../lib/zonedTime";
import type { DashboardMark } from "./annotations";
import {
  ANNOTATIONS_KEY,
  type Annotation,
  createAnnotation,
  deleteAnnotation,
  parseAnnotation,
  updateAnnotation,
} from "./featuresApi";
import { resolveTime, toLocalInput } from "./timeRange";
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

/** A typed time as wall-clock time in the zone in effect, the zone the input was filled in. */
function fromLocalInput(text: string): number | null {
  return text.includes("T") ? resolveTime(text, Date.now()) : null;
}

/**
 * Wall-clock time with seconds, in the zone in effect, for a datetime-local input with
 * `step="1"`: "2026-10-20T08:00:05". Browsers report a value on a full minute without ":00".
 */
export function toLocalInputSeconds(ms: number): string {
  const seconds = String(wallOf(ms).second).padStart(2, "0");
  return `${toLocalInput(ms)}:${seconds}`;
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
  // The stored annotation this dialog changes; a version conflict replaces it with the newer one.
  const [existing, setExisting] = useState<Annotation | undefined>(
    props.mode === "open" ? props.mark.annotation : undefined,
  );
  const readOnly = props.mode === "open" && (existing === undefined || !props.canWrite);
  // The exact times the dialog started from: the inputs show seconds, and a time nobody touched
  // is sent (or left out of a change) with its full precision.
  const [base, setBase] = useState(() => ({
    time: props.mode === "add" ? props.time : props.mark.time,
    end: props.mode === "add" ? null : props.mark.timeEnd,
  }));
  const [time, setTime] = useState(toLocalInputSeconds(base.time));
  const [isSpan, setIsSpan] = useState(base.end !== null);
  const [end, setEnd] = useState(toLocalInputSeconds(base.end ?? base.time));
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
      const timeChanged = time !== toLocalInputSeconds(base.time);
      const at = timeChanged ? fromLocalInput(time) : base.time;
      const endChanged =
        isSpan !== (base.end !== null) ||
        (isSpan && end !== toLocalInputSeconds(base.end ?? base.time));
      const until = !isSpan ? null : endChanged ? fromLocalInput(end) : base.end;
      const tagList = tags
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag !== "");
      if (at === null || (isSpan && (until === null || until < at))) {
        throw new Error("time");
      }
      const fields = { text: text.trim(), tags: [...new Set(tagList)] };
      if (existing === undefined) {
        await createAnnotation(props.orgId, props.dashboardId, {
          ...fields,
          time: at,
          timeEnd: until,
          panelId: props.mode === "add" ? props.panelId : null,
        });
      } else {
        // Times go along only when changed, so a stored time keeps its milliseconds.
        await updateAnnotation(props.orgId, props.dashboardId, existing.id, {
          ...fields,
          version: existing.version,
          ...(timeChanged ? { time: at } : {}),
          ...(endChanged ? { timeEnd: until } : {}),
        });
      }
    },
    onSuccess: done,
    onError: (error) => {
      if (isApiError(error, "version_conflict")) {
        // Show what is stored now; saving again changes that version.
        const current = parseAnnotation(error.current);
        if (current !== null) {
          setExisting(current);
          setBase({ time: current.time, end: current.timeEnd });
          setTime(toLocalInputSeconds(current.time));
          setIsSpan(current.timeEnd !== null);
          setEnd(toLocalInputSeconds(current.timeEnd ?? current.time));
          setText(current.text);
          setTags(current.tags.join(", "));
        }
        setProblem(t("annotations.changed"));
        return;
      }
      setProblem(
        error instanceof Error && error.message === "time"
          ? t("annotations.timeInvalid")
          : errorMessage(t, error),
      );
    },
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
          step="1"
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
            step="1"
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
