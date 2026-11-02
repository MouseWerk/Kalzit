import { useEffect, useId, useRef, useState } from "react";
import { saveFile } from "../../../analysis/api";
import type { ExportLanguage } from "../../../api/generated/shapes";
import { useI18n } from "../../../i18n/i18n";
import { errorMessage } from "../../dashboards/ui/errors";
import { type AuditExportFormat, type AuditFilter, exportAudit } from "../api";
import { Dialog } from "./Dialog";
import "../../dashboards/ui/shared.css";

const FORMATS: readonly AuditExportFormat[] = ["csv", "json"];
const LANGUAGES: readonly ExportLanguage[] = ["de", "en"];

/**
 * Exports the audit log with the filters the list shows, every page of it, as CSV or JSON. The
 * server checks the right to read the log and records the export there.
 */
export function AuditExportDialog({
  orgId,
  filter,
  onClose,
}: {
  orgId: string | null;
  filter: AuditFilter;
  onClose: () => void;
}) {
  const { t, language } = useI18n();
  const id = useId();
  const [format, setFormat] = useState<AuditExportFormat>("csv");
  const [numbers, setNumbers] = useState<ExportLanguage>(language === "de" ? "de" : "en");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // Closing the dialog or leaving the page cancels the export.
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);

  function close() {
    running.current?.abort();
    onClose();
  }

  async function submit() {
    setBusy(true);
    setError(null);
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    try {
      saveFile(await exportAudit(orgId, filter, format, numbers, controller.signal));
      running.current = null;
      onClose();
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(e);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={t("admin.audit.export.title")}
      onClose={close}
      footer={
        <>
          <button type="button" className="button button--secondary" onClick={close}>
            {t("admin.common.cancel")}
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={() => void submit()}
            disabled={busy}
          >
            {busy ? t("admin.audit.export.working") : t("admin.audit.export.submit")}
          </button>
        </>
      }
    >
      <div className="form">
        <fieldset className="radio-group">
          <legend className="field__label">{t("admin.audit.export.format")}</legend>
          {FORMATS.map((f) => (
            <label key={f} className="radio">
              <input
                type="radio"
                name={`${id}-format`}
                value={f}
                checked={format === f}
                onChange={() => setFormat(f)}
              />
              <span>{t(`admin.audit.export.format.${f}`)}</span>
            </label>
          ))}
        </fieldset>
        {format === "csv" ? (
          <fieldset className="radio-group">
            <legend className="field__label">{t("analysis.export.language")}</legend>
            {LANGUAGES.map((l) => (
              <label key={l} className="radio">
                <input
                  type="radio"
                  name={`${id}-language`}
                  value={l}
                  checked={numbers === l}
                  onChange={() => setNumbers(l)}
                />
                <span>{t(`analysis.export.language.${l}`)}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
        <p className="field__hint">{t("admin.audit.export.hint")}</p>
        {error === null ? null : (
          <p className="admin-error" role="alert">
            {errorMessage(t, error)}
          </p>
        )}
      </div>
    </Dialog>
  );
}
