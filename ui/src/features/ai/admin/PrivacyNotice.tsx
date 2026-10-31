import { useId, useState } from "react";
import { useI18n } from "../../../i18n/i18n";
import type { Setting } from "../../admin/api";
import { settingText } from "../../admin/catalog";
import { Dialog } from "../../admin/components/Dialog";
import { type Changes, lockedBadge, lockHint, RowFrame } from "../../settings/rows";
import "./ai-admin.css";

/** The longest addition the server takes (`ai.notice_text`). */
const MAX_NOTICE_CHARS = 2000;

/**
 * "Which data leaves the server" (board frame 7): what each function sends, built from the
 * rules rather than typed, so it cannot drift from what the server does; below it the
 * administrators' own addition (`ai.notice_text`).
 */
export function PrivacyNotice({
  maxRows,
  noticeText,
  changes,
  found,
  rowId,
}: {
  maxRows: number;
  noticeText: Setting | undefined;
  changes: Changes;
  found: boolean;
  rowId: string;
}) {
  const { t, language } = useI18n();
  const titleId = useId();
  const rows = new Intl.NumberFormat(language).format(maxRows);
  const functions = [
    { name: t("ai.admin.privacy.explain"), text: t("ai.admin.privacy.explainText") },
    { name: t("ai.admin.privacy.draft"), text: t("ai.admin.privacy.draftText") },
    { name: t("ai.admin.privacy.summarize"), text: t("ai.admin.privacy.summarizeText", { rows }) },
    { name: t("ai.admin.privacy.never"), text: t("ai.admin.privacy.neverText") },
  ];
  return (
    <section className="settings-card" aria-labelledby={titleId}>
      <div className="ai-card__head">
        <div className="ai-card__title">
          <h3 id={titleId}>{t("ai.admin.privacy.title")}</h3>
          <p className="settings-hint">{t("ai.admin.privacy.lead")}</p>
        </div>
        <span className="ai-chip">{t("ai.admin.privacy.forEveryone")}</span>
      </div>
      <div className="ai-table-wrap">
        <table className="ai-table ai-table--plain">
          <tbody>
            {functions.map((row) => (
              <tr key={row.name}>
                <th scope="row" className="ai-table__label">
                  {row.name}
                </th>
                <td>{row.text}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {noticeText === undefined ? null : (
        <NoticeTextRow setting={noticeText} changes={changes} found={found} rowId={rowId} />
      )}
    </section>
  );
}

/** The administrators' paragraph under the notice, edited in a dialog and applied with undo. */
function NoticeTextRow({
  setting,
  changes,
  found,
  rowId,
}: {
  setting: Setting;
  changes: Changes;
  found: boolean;
  rowId: string;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const current = typeof setting.value === "string" ? setting.value : "";
  const [draft, setDraft] = useState(current);
  const text = settingText(t, setting);
  const badge = lockedBadge(t, setting, true);
  const lock = lockHint(t, setting);
  const error = changes.rejected?.key === setting.key ? changes.rejected.message : undefined;
  const tooLong = Array.from(draft).length > MAX_NOTICE_CHARS;
  return (
    <RowFrame
      id={rowId}
      title={text.label ?? setting.key}
      titleId={titleId}
      description={text.description}
      note={current === "" ? t("ai.admin.privacy.noAddition") : current}
      badge={badge}
      lock={lock}
      error={error}
      errorId={`${titleId}-error`}
      found={found}
    >
      {/* A text set in kalzit.toml or the environment keeps the button, turned off. */}
      <button
        type="button"
        className="button button--secondary button--small"
        aria-describedby={lock === undefined ? titleId : `${titleId} ${titleId}-lock`}
        disabled={lock !== undefined}
        onClick={() => {
          setDraft(current);
          setOpen(true);
        }}
      >
        {t("ai.admin.privacy.editAddition")}
      </button>
      <Dialog
        open={open}
        title={t("ai.admin.privacy.additionTitle")}
        onClose={() => setOpen(false)}
        footer={
          <>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => setOpen(false)}
            >
              {t("ai.admin.dialog.cancel")}
            </button>
            <button
              type="button"
              className="button button--primary"
              aria-disabled={tooLong}
              onClick={() => {
                if (tooLong) return;
                setOpen(false);
                if (draft.trim() !== current) {
                  changes.apply(setting, draft.trim());
                }
              }}
            >
              {t("ai.admin.privacy.apply")}
            </button>
          </>
        }
      >
        <div className="field">
          <label className="field__label" htmlFor={fieldId}>
            {text.label ?? setting.key}
          </label>
          <textarea
            id={fieldId}
            className="input settings-textarea"
            rows={6}
            value={draft}
            aria-invalid={tooLong ? true : undefined}
            aria-describedby={`${fieldId}-hint`}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
          <p
            className={tooLong ? "field__error" : "field__hint"}
            id={`${fieldId}-hint`}
            role={tooLong ? "alert" : undefined}
          >
            {t("ai.admin.privacy.additionHint", {
              count: Array.from(draft).length,
              max: MAX_NOTICE_CHARS,
            })}
          </p>
        </div>
      </Dialog>
    </RowFrame>
  );
}
