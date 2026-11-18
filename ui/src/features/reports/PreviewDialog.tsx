import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { saveFile } from "../../analysis/api";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { formatBytes } from "../../lib/bytes";
import { Dialog } from "../admin/components/Dialog";
import { previewReport, REPORTS_KEY, type ReportInput } from "./api";
import { reportErrorText } from "./reasons";
import "../alerting/alerting.css";
import "./reports.css";

/**
 * The preview of a draft (board Reports.dc.html, frame 4): the server draws the PDF with the
 * same renderer as a run, with the data of now and the person's own rights, and sends nothing.
 * The file opens in a tab of its own or is saved; its size stands against the largest mail, and
 * the note says what differs from the dashboard on screen.
 */
export function PreviewDialog({
  orgId,
  input,
  maxBytes,
  onClose,
}: {
  orgId: string;
  input: ReportInput;
  maxBytes: number | undefined;
  onClose: () => void;
}) {
  const { t, language } = useI18n();
  const preview = useQuery({
    queryKey: [REPORTS_KEY, orgId, "preview", input],
    queryFn: ({ signal }) => previewReport(orgId, input, signal),
    // Drawn once per opening: a preview costs a run's worth of queries.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
  });
  const file = preview.data;
  // The address of the file for the link; given back when the dialog closes.
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (file === undefined) return;
    const created = URL.createObjectURL(file.blob);
    setUrl(created);
    return () => URL.revokeObjectURL(created);
  }, [file]);
  const tooLarge = file !== undefined && maxBytes !== undefined && file.blob.size > maxBytes;

  return (
    <Dialog
      open
      title={t("reports.preview.title", { name: input.name })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("admin.common.close")}
          </button>
          {file === undefined || url === null ? null : (
            <>
              <button
                type="button"
                className="button button--secondary"
                onClick={() => saveFile(file)}
              >
                <Icon name="download" />
                {t("reports.preview.download")}
              </button>
              <a className="button button--primary" href={url} target="_blank" rel="noreferrer">
                <Icon name="external" />
                {t("reports.preview.open")}
              </a>
            </>
          )}
        </>
      }
    >
      <div className="report-preview" aria-live="polite">
        {preview.isPending ? <p className="loading">{t("reports.preview.loading")}</p> : null}
        {preview.isError ? (
          <p className="field__error" role="alert">
            <Icon name="alert" />
            <span>{reportErrorText(t, preview.error)}</span>
          </p>
        ) : null}
        {file === undefined ? null : (
          <div className="report-file">
            <span className="report-file__mark" aria-hidden="true">
              PDF
            </span>
            <span className="report-file__name" title={file.filename}>
              {file.filename}
            </span>
            <span className={tooLarge ? "alert-warn-text" : "alert-muted"}>
              {maxBytes === undefined
                ? formatBytes(file.blob.size, language)
                : t("reports.preview.size", {
                    size: formatBytes(file.blob.size, language),
                    max: formatBytes(maxBytes, language),
                  })}
            </span>
          </div>
        )}
        {tooLarge ? (
          <p className="alert-warn-text">{t("reports.reason.attachment_too_large")}</p>
        ) : null}
        <p className="alert-note report-note">
          <Icon name="info" />
          <span>{t("reports.preview.note")}</span>
        </p>
      </div>
    </Dialog>
  );
}
