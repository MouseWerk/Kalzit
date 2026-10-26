import { useId } from "react";
import { FormAlert } from "../../components/FormAlert";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { zoneOption } from "../../lib/timeSettings";
import { Dialog } from "../dashboards/ui/Dialog";
import type { Analysis, AnalysisModel } from "./api";
import { type AnalysisChange, analysisChanges } from "./changes";
import "../dashboards/dashboards.css";
import "./analyses.css";

/** The newer version someone else saved, with who and when as far as the caller may know. */
export interface NewerVersion {
  analysis: Analysis & { model: AnalysisModel };
  /** The author's name from the history; null when unknown. */
  authorName: string | null;
}

function useTimeFormat() {
  const { language, timeZone } = useI18n();
  return new Intl.DateTimeFormat(language, { timeStyle: "short", ...zoneOption(timeZone) });
}

/**
 * Shown in Explore as soon as a newer version arrives, before anything is saved: who saved it,
 * which version the user works on, and the ways on.
 */
export function ConflictNotice({
  newer,
  workingVersion,
  onCompare,
  onLoad,
}: {
  newer: NewerVersion;
  workingVersion: number;
  onCompare: () => void;
  onLoad: () => void;
}) {
  const { t } = useI18n();
  const time = useTimeFormat();
  const at = time.format(newer.analysis.updatedAt);
  return (
    <div className="notice analysis-conflict-notice" role="status">
      <Icon name="alert" />
      <p className="analysis-conflict-notice__text">
        <strong>
          {newer.authorName === null
            ? t("analyses.conflict.noticeSomeone")
            : t("analyses.conflict.notice", { name: newer.authorName })}
        </strong>{" "}
        <span>
          {t("analyses.conflict.noticeDetail", {
            time: at,
            mine: workingVersion,
            current: newer.analysis.version,
          })}
        </span>
      </p>
      <div className="analysis-conflict-notice__actions">
        <button
          type="button"
          className="button button--secondary button--small"
          onClick={onCompare}
        >
          {t("analyses.conflict.compare")}
        </button>
        <button type="button" className="button button--secondary button--small" onClick={onLoad}>
          {t("analyses.conflict.loadNew")}
        </button>
      </div>
    </div>
  );
}

function ChangeList({
  title,
  detail,
  changes,
}: {
  title: string;
  detail: string;
  changes: readonly AnalysisChange[];
}) {
  const { t } = useI18n();
  const id = useId();
  return (
    <section className="conflict__side" aria-labelledby={id}>
      <h3 className="conflict__title" id={id}>
        {title} <span className="analysis-save__muted">{detail}</span>
      </h3>
      {changes.length === 0 ? (
        <p className="field__hint">{t("analyses.conflict.none")}</p>
      ) : (
        <ul className="conflict__list">
          {changes.map((change) => (
            <li key={`${change.key}:${JSON.stringify(change.params ?? {})}`}>
              {t(change.key, change.params ?? {})}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface ConflictDialogProps {
  /** The version the user started from. */
  base: AnalysisModel;
  /** What the user has now, not saved. */
  mine: AnalysisModel;
  newer: NewerVersion;
  /** When the user opened (or last loaded) the analysis. */
  openedAt: number;
  /** Only to compare (from the notice): no overwrite offered before a save was tried. */
  compareOnly?: boolean;
  busy?: boolean;
  error?: string | undefined;
  onOverwrite: () => void;
  onLoad: () => void;
  onSaveCopy: () => void;
  onClose: () => void;
}

/**
 * Someone saved a newer version: both sides' changes against the version the user started from,
 * and the three ways on. Overwriting needs only the right to save; the overwritten version stays
 * in the history.
 */
export function ConflictDialog({
  base,
  mine,
  newer,
  openedAt,
  compareOnly = false,
  busy = false,
  error,
  onOverwrite,
  onLoad,
  onSaveCopy,
  onClose,
}: ConflictDialogProps) {
  const { t } = useI18n();
  const time = useTimeFormat();
  const textId = useId();
  const version = newer.analysis.version;
  const params = {
    title: newer.analysis.title,
    time: time.format(newer.analysis.updatedAt),
    opened: time.format(openedAt),
  };
  return (
    <Dialog
      title={t("analyses.conflict.title")}
      onClose={onClose}
      size="large"
      describedBy={textId}
      actions={
        <>
          {compareOnly ? null : (
            <button
              type="button"
              className="button button--ghost analysis-conflict__overwrite"
              onClick={onOverwrite}
              disabled={busy}
            >
              {t("analyses.conflict.overwrite")}
            </button>
          )}
          <button type="button" className="button button--secondary" onClick={onLoad}>
            {t("analyses.conflict.load", { version })}
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={onSaveCopy}
            data-autofocus
          >
            {t("analyses.conflict.saveCopy")}
          </button>
        </>
      }
    >
      <p id={textId}>
        {newer.authorName === null
          ? t("analyses.conflict.textSomeone", params)
          : t("analyses.conflict.text", { ...params, name: newer.authorName })}
      </p>
      <FormAlert>{error}</FormAlert>
      <div className="conflict">
        <ChangeList
          title={t("analyses.conflict.theirs", { version })}
          detail={time.format(newer.analysis.updatedAt)}
          changes={analysisChanges(t, base, newer.analysis.model)}
        />
        <ChangeList
          title={t("analyses.conflict.mine")}
          detail={t("analyses.conflict.notSaved")}
          changes={analysisChanges(t, base, mine)}
        />
      </div>
      <p className="field__hint">{t("analyses.conflict.kept", { version })}</p>
    </Dialog>
  );
}
