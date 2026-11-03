import { useEffect, useId, useRef, useState } from "react";
import type { DownloadedFile } from "../api/client";
import type { ExportFormat, ExportLanguage } from "../api/generated/shapes";
import { FormAlert } from "../components/FormAlert";
import { Dialog } from "../features/dashboards/ui/Dialog";
import { errorMessage } from "../features/dashboards/ui/errors";
import { useI18n } from "../i18n/i18n";
import { saveFile } from "./api";
import type { StepsRun } from "./steps";
import "../features/dashboards/ui/shared.css";
import "./analysis.css";

export interface ExportChoice {
  format: ExportFormat;
  language: ExportLanguage;
  /** The result to export, by reference id; absent when there is only one. */
  frame?: string;
}

/** The shape a result has after the steps; it decides the formats a file can have. */
export type ExportShape = "frame" | "documents" | "graph";

/** One result after the steps that can be exported, by the reference id of its query. */
export interface ExportResult {
  name: string;
  shape: ExportShape;
}

/**
 * The formats of each shape, as the server writes them (docs/api/datasources.md, "Export"). A
 * format never turns one shape into another: a table of documents or of a graph is a step.
 */
export const EXPORT_FORMATS: Readonly<Record<ExportShape, readonly ExportFormat[]>> = {
  frame: ["csv", "xlsx", "json"],
  documents: ["ndjson", "json"],
  graph: ["graphml", "json"],
};

/**
 * The results the steps left, in the order the server picks from when the request names none:
 * the tables, then the documents no projection read, then the graphs no step made a table of.
 */
export function exportResults(
  run: Pick<StepsRun, "frames" | "documents" | "graphs">,
): ExportResult[] {
  return [
    ...run.frames.map((f) => ({ name: f.name, shape: "frame" as const })),
    ...run.documents.map((d) => ({ name: d.name, shape: "documents" as const })),
    ...run.graphs.map((g) => ({ name: g.name, shape: "graph" as const })),
  ];
}

const LANGUAGES: readonly ExportLanguage[] = ["de", "en"];

interface ExportDialogProps {
  /** The results after the steps, to choose from when there are several. */
  results: readonly ExportResult[];
  /** A note under the choices, such as that the saved panel is exported. */
  note?: string | undefined;
  /** Asks the server for the file; the server decides whether the caller may export. */
  run: (choice: ExportChoice, signal: AbortSignal) => Promise<DownloadedFile>;
  onClose: () => void;
}

/** Choose result, format and number style, then download the file the server makes. */
export function ExportDialog({ results, note, run, onClose }: ExportDialogProps) {
  const { t, language } = useI18n();
  const id = useId();
  const [frame, setFrame] = useState(results[0]?.name ?? "");
  const shape = results.find((r) => r.name === frame)?.shape ?? results[0]?.shape ?? "frame";
  const formats = EXPORT_FORMATS[shape];
  const [picked, setFormat] = useState<ExportFormat>(formats[0] ?? "csv");
  // A format the chosen result cannot have falls back to the result's first one.
  const format = formats.includes(picked) ? picked : (formats[0] ?? "csv");
  const [numbers, setNumbers] = useState<ExportLanguage>(language === "de" ? "de" : "en");
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
      if (results.length > 1 && frame !== "") choice.frame = frame;
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
        {results.length > 1 ? (
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
              {results.map((r) => (
                <option key={r.name} value={r.name}>
                  {t("analysis.export.result", {
                    name: r.name,
                    shape: t(`analysis.export.shape.${r.shape}`),
                  })}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <fieldset className="radio-group">
          <legend className="field__label">{t("analysis.export.format")}</legend>
          {formats.map((f) => (
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
        <p className="field__hint">
          {shape === "frame" ? t("analysis.export.hint") : t("analysis.export.hintShape")}
        </p>
        {note === undefined ? null : <p className="field__hint">{note}</p>}
        {error === null ? null : <FormAlert>{errorMessage(t, error)}</FormAlert>}
      </div>
    </Dialog>
  );
}
