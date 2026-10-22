import { useEffect, useId, useRef, useState } from "react";
import type { DownloadedFile } from "../api/client";
import type { ExportFormat, ExportLanguage } from "../api/generated/shapes";
import { FormAlert } from "../components/FormAlert";
import { Dialog } from "../features/dashboards/ui/Dialog";
import { errorMessage } from "../features/dashboards/ui/errors";
import { useI18n } from "../i18n/i18n";
import { saveFile } from "./api";
import "../features/dashboards/ui/shared.css";
import "./analysis.css";

export interface ExportChoice {
  format: ExportFormat;
  language: ExportLanguage;
  /** The table to export, by reference id; absent for the first. */
  frame?: string;
}

const FORMATS: readonly ExportFormat[] = ["csv", "xlsx", "json"];
const LANGUAGES: readonly ExportLanguage[] = ["de", "en"];

interface ExportDialogProps {
  /** The tables after the steps, by reference id, to choose from when there are several. */
  frames: readonly string[];
  /** A note under the choices, such as that the saved panel is exported. */
  note?: string | undefined;
  /** Asks the server for the file; the server decides whether the caller may export. */
  run: (choice: ExportChoice, signal: AbortSignal) => Promise<DownloadedFile>;
  onClose: () => void;
}

/** Choose format, number style and table, then download the file the server makes. */
export function ExportDialog({ frames, note, run, onClose }: ExportDialogProps) {
  const { t, language } = useI18n();
  const id = useId();
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [numbers, setNumbers] = useState<ExportLanguage>(language === "de" ? "de" : "en");
  const [frame, setFrame] = useState(frames[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // The export that runs; closing the dialog or leaving the page cancels it, which also lets the
  // server stop making the file.
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
      const choice: ExportChoice = { format, language: numbers };
      if (frames.length > 1 && frame !== "") choice.frame = frame;
      saveFile(await run(choice, controller.signal));
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
      title={t("analysis.export.title")}
      onClose={close}
      actions={
        <>
          <button type="button" className="button button--secondary" onClick={close}>
            {t("analysis.export.cancel")}
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={() => void submit()}
            disabled={busy}
            data-autofocus
          >
            {busy ? t("analysis.export.working") : t("analysis.export.submit")}
          </button>
        </>
      }
    >
      <div className="export-form">
        <fieldset className="radio-group">
          <legend className="field__label">{t("analysis.export.format")}</legend>
          {FORMATS.map((f) => (
            <label key={f} className="radio">
              <input
                type="radio"
                name={`${id}-format`}
                value={f}
                checked={format === f}
                onChange={() => setFormat(f)}
              />
              <span>{t(`analysis.export.format.${f}`)}</span>
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
        {frames.length > 1 ? (
          <div className="field">
            <label className="field__label" htmlFor={`${id}-frame`}>
              {t("analysis.export.frame")}
            </label>
            <select
              id={`${id}-frame`}
              className="select"
              value={frame}
              onChange={(event) => setFrame(event.currentTarget.value)}
            >
              {frames.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <p className="field__hint">{t("analysis.export.hint")}</p>
        {note === undefined ? null : <p className="field__hint">{note}</p>}
        {error === null ? null : <FormAlert>{errorMessage(t, error)}</FormAlert>}
      </div>
    </Dialog>
  );
}
