import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { saveFile } from "../../../analysis/api";
import type { ExportLanguage } from "../../../api/generated/shapes";
import { FormAlert } from "../../../components/FormAlert";
import { Dialog } from "../../../features/dashboards/ui/Dialog";
import { errorMessage } from "../../../features/dashboards/ui/errors";
import { type Language, type Translate, useI18n } from "../../../i18n/i18n";
import { getTimeSettings, zoneOption } from "../../../lib/timeSettings";
import { type PanelHost, usePanelHost } from "../../host";
import { embeddedFonts, imageFileName } from "../../image";
import type { GraphPalette } from "../colors";
import { countText } from "../plural";
import { type DataScope, exportScope, type ScopeCounts, scopeCounts } from "./dataScope";
import type { DataFormat, ExportLegend, ExportSource, ImageFormat } from "./GraphExport";
import { firstFamily, lightPalette, paletteColors } from "./palettes";
import { picturePdf } from "./pdf";
import { composePicture, type PictureLegend } from "./picture";
import { measureForPdf, measureIn, picturePng, textImage } from "./raster";
import { frameScene, type ImageScope, recolorScene, type Scene } from "./scene";
import { pictureSvg } from "./svg";
import "../../../features/dashboards/ui/shared.css";
import "../graph.css";
import "./graphExport.css";

/**
 * The two dialogs of a graph's export menu (Graph081 board, frame 18): a picture asks for its
 * format, how much of the drawing it holds, its background and what goes with it; a data file
 * asks only how much of the graph it holds.
 */

type Open = { kind: "image"; format: ImageFormat } | { kind: "data"; format: DataFormat };

export default function ExportDialogs(
  props: ExportSource & { open: Open; onClose: () => void },
) {
  const { open, onClose } = props;
  return open.kind === "image" ? (
    <ImageDialog {...props} format={open.format} onClose={onClose} />
  ) : (
    <DataDialog {...props} format={open.format} onClose={onClose} />
  );
}

/** One choice of a few, as a row of buttons: a radio group with one Tab stop and arrow keys. */
function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    const at = options.findIndex((option) => option.value === value);
    const next = options[(at + step + options.length) % options.length];
    if (next === undefined) return;
    onChange(next.value);
    ref.current?.querySelector<HTMLElement>(`[data-value="${next.value}"]`)?.focus();
  }
  return (
    <div
      ref={ref}
      className="graph__segmented graph-export__segmented"
      role="radiogroup"
      aria-label={label}
      onKeyDown={onKeyDown}
    >
      {options.map((option) => (
        // biome-ignore lint/a11y/useSemanticElements: a segmented choice, drawn as buttons
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          className="graph__segment"
          data-value={option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

const IMAGE_FORMATS: readonly ImageFormat[] = ["png", "svg", "pdf"];
const BACKGROUNDS = ["shown", "light", "transparent"] as const;
type Background = (typeof BACKGROUNDS)[number];
type PdfPage = "fit" | "a4";

const MIME: Record<ImageFormat, string> = {
  png: "image/png",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

/** The legend of a picture: the labels that are not hidden, in the palette's colors. */
export function pictureLegend(
  legend: ExportLegend,
  palette: GraphPalette,
  t: Translate,
  language: Language,
): PictureLegend | null {
  const number = new Intl.NumberFormat(language);
  const entries = legend.labels
    .filter((entry) => !legend.hidden.has(entry.label))
    .map((entry) => ({
      name: entry.label === "" ? t("graph.cluster.unlabelled") : entry.label,
      shape: entry.shape,
      color:
        legend.swatches && entry.group >= 0
          ? (palette.series[entry.group % palette.series.length] ?? palette.neutral)
          : palette.neutral,
      count: number.format(entry.count),
    }));
  const notes: string[] = [];
  let ramp: PictureLegend["ramp"] = null;
  const property = legend.property;
  if (property !== null) {
    if (property.values.length > 0) {
      notes.push(
        t("graph.legend.values", { name: legend.propertyName, count: property.values.length }),
      );
    } else if (property.min !== null && property.max !== null) {
      const range = t("graph.legend.range", {
        min: number.format(property.min),
        max: number.format(property.max),
      });
      ramp = { colors: palette.ramps[legend.ramp], text: `${legend.propertyName}: ${range}` };
    }
    if (property.missing > 0) {
      notes.push(t("graph.legend.missing", { count: number.format(property.missing) }));
    }
  }
  if (legend.sizeNote !== null) notes.push(legend.sizeNote);
  // The panel shows its legend only for more than one label, a property or a size note.
  return entries.length > 1 || ramp !== null || notes.length > 0 ? { entries, ramp, notes } : null;
}

/** The lines under a picture's title: the data sources and the time range. */
function captionLines(about: ReturnType<NonNullable<PanelHost["about"]>>, language: Language) {
  const lines: string[] = [];
  if (about.source !== undefined && about.source !== "") lines.push(about.source);
  if (about.range !== undefined) {
    const format = new Intl.DateTimeFormat(language, {
      dateStyle: "short",
      timeStyle: "short",
      ...zoneOption(getTimeSettings().timeZone),
    });
    lines.push(`${format.format(about.range.from)} – ${format.format(about.range.to)}`);
  }
  return lines;
}

/** The line under a picture: how many of the graph's nodes it shows. */
function shownLine(t: Translate, language: Language, shown: number, counts: ScopeCounts): string {
  if (shown >= counts.total) {
    return t("graph.export.shownAll", {
      nodes: countText(t, language, "node", counts.total),
      edges: countText(t, language, "edge", counts.edges),
    });
  }
  return t("graph.export.shownOf", {
    shown: new Intl.NumberFormat(language).format(shown),
    total: countText(t, language, "node", counts.total),
  });
}

interface ImageChoices {
  format: ImageFormat;
  scope: ImageScope;
  background: Background;
  legend: boolean;
  caption: boolean;
  page: PdfPage;
}

/** The file of a picture, from the drawing as it is at this moment. */
async function makeImage(
  scene: Scene,
  palette: GraphPalette,
  root: HTMLElement | null,
  choices: ImageChoices,
  parts: {
    title: string;
    lines: string[];
    note: string;
    legend: (palette: GraphPalette) => PictureLegend | null;
  },
): Promise<Blob> {
  await document.fonts?.ready;
  // A light picture takes the panel's colors of the light scheme, whatever the page shows.
  const light = choices.background === "light" && root !== null ? lightPalette(root) : null;
  const colors = light ?? palette;
  const colored =
    light === null ? scene : recolorScene(scene, paletteColors(palette), paletteColors(light));
  const measure =
    choices.format === "pdf"
      ? measureForPdf(scene.font, scene.boldWeight)
      : measureIn(scene.font, scene.boldWeight);
  const framed = frameScene(colored, choices.scope, (text, bold) =>
    measure(text, scene.labelSize, bold),
  );
  const picture = composePicture(
    framed,
    {
      background: choices.background === "transparent" ? null : colored.colors.background,
      caption: choices.caption ? { title: parts.title, lines: parts.lines } : null,
      legend: choices.legend ? parts.legend(colors) : null,
      note: parts.note,
      title: parts.title,
    },
    measure,
  );
  if (choices.format === "png") return await picturePng(picture);
  if (choices.format === "pdf") {
    const bytes = await picturePdf(picture, {
      page: choices.page,
      rasterText: (op) => textImage(op, scene.font, scene.boldWeight),
    });
    return new Blob([bytes as BlobPart], { type: MIME.pdf });
  }
  // The label font's own files go into the SVG, so it reads the same without the font installed.
  const fonts = await embeddedFonts(firstFamily(scene.font)).catch(() => "");
  return new Blob([pictureSvg(picture, fonts)], { type: MIME.svg });
}

function ImageDialog({
  title,
  scene,
  root,
  palette,
  model,
  view,
  visibility,
  selected,
  legend,
  format: first,
  onClose,
}: ExportSource & { format: ImageFormat; onClose: () => void }) {
  const { t, language } = useI18n();
  const host = usePanelHost();
  const id = useId();
  const counts = scopeCounts(model, view, visibility, selected);
  const [format, setFormat] = useState<ImageFormat>(first);
  const [picked, setScope] = useState<ImageScope>("view");
  const scope = picked === "selection" && counts.selected === 0 ? "view" : picked;
  const [background, setBackground] = useState<Background>("shown");
  const [withLegend, setWithLegend] = useState(true);
  const [withCaption, setWithCaption] = useState(true);
  const [page, setPage] = useState<PdfPage>("fit");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const about = host.about?.() ?? {};
  const lines = captionLines(about, language);
  const shown = scope === "selection" ? counts.selected : counts.visible;
  const name = t(`graph.export.${format}`);

  async function save() {
    const drawing = scene?.() ?? null;
    if (drawing === null || palette === null) {
      setFailed(true);
      return;
    }
    setBusy(true);
    setFailed(false);
    try {
      const blob = await makeImage(
        drawing,
        palette,
        root.current,
        { format, scope, background, legend: withLegend, caption: withCaption, page },
        {
          title,
          lines,
          note: shownLine(t, language, shown, counts),
          legend: (colors) => pictureLegend(legend, colors, t, language),
        },
      );
      saveFile({ blob, filename: imageFileName(title).replace(/\.png$/, `.${format}`) });
      onClose();
    } catch {
      setFailed(true);
      setBusy(false);
    }
  }

  const scopes: { value: ImageScope; label: string; count?: string; disabled?: boolean }[] = [
    { value: "view", label: t("graph.export.scope.view") },
    {
      value: "all",
      label: t("graph.export.scope.all"),
      count: t("graph.export.scope.visibleCount", {
        nodes: countText(t, language, "node", counts.visible),
      }),
    },
    {
      value: "selection",
      label: t("graph.export.scope.selection"),
      count: countText(t, language, "node", counts.selected),
      disabled: counts.selected === 0,
    },
  ];

  return (
    <Dialog
      title={t("graph.export.image.title")}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("analysis.export.cancel")}
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={() => void save()}
            disabled={busy}
            data-autofocus
          >
            {busy
              ? t("graph.export.image.working")
              : t("graph.export.image.save", { format: name })}
          </button>
        </>
      }
    >
      <div className="graph-export__form">
        <div className="field">
          <span className="field__label">{t("analysis.export.format")}</span>
          <Segmented
            label={t("analysis.export.format")}
            value={format}
            options={IMAGE_FORMATS.map((f) => ({ value: f, label: t(`graph.export.${f}`) }))}
            onChange={setFormat}
          />
        </div>
        <fieldset className="radio-group">
          <legend className="field__label">{t("graph.export.scope")}</legend>
          {scopes.map((option) => (
            <label key={option.value} className="radio">
              <input
                type="radio"
                name={`${id}-scope`}
                value={option.value}
                checked={scope === option.value}
                disabled={option.disabled === true}
                onChange={() => setScope(option.value)}
              />
              <span>{option.label}</span>
              {option.count === undefined ? null : (
                <span className="graph-export__count">{option.count}</span>
              )}
            </label>
          ))}
        </fieldset>
        <div className="field">
          <span className="field__label">{t("graph.export.background")}</span>
          <Segmented
            label={t("graph.export.background")}
            value={background}
            options={BACKGROUNDS.map((b) => ({
              value: b,
              label: t(`graph.export.background.${b}`),
            }))}
            onChange={setBackground}
          />
        </div>
        {format === "pdf" ? (
          <fieldset className="radio-group">
            <legend className="field__label">{t("graph.export.page")}</legend>
            {(["fit", "a4"] as const).map((value) => (
              <label key={value} className="radio">
                <input
                  type="radio"
                  name={`${id}-page`}
                  value={value}
                  checked={page === value}
                  onChange={() => setPage(value)}
                />
                <span>{t(`graph.export.page.${value}`)}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
        <div className="radio-group">
          <label className="checkbox">
            <input
              type="checkbox"
              checked={withLegend}
              onChange={(event) => setWithLegend(event.target.checked)}
            />
            <span>{t("graph.export.withLegend")}</span>
          </label>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={withCaption}
              onChange={(event) => setWithCaption(event.target.checked)}
            />
            <span>
              {lines.length === 0 ? t("graph.export.withTitle") : t("graph.export.withCaption")}
            </span>
          </label>
        </div>
        <p className="graph-export__note">
          {shown >= counts.total
            ? t("graph.export.image.noteAll", {
                nodes: countText(t, language, "node", counts.total),
              })
            : t("graph.export.image.notePart", {
                shown: new Intl.NumberFormat(language).format(shown),
                total: countText(t, language, "node", counts.total),
              })}
        </p>
        {failed ? <FormAlert>{t("graph.export.image.failed")}</FormAlert> : null}
      </div>
    </Dialog>
  );
}

const LANGUAGES: readonly ExportLanguage[] = ["de", "en"];

function DataDialog({
  scene,
  model,
  view,
  visibility,
  selected,
  format,
  onClose,
}: ExportSource & { format: DataFormat; onClose: () => void }) {
  const { t, language } = useI18n();
  const host = usePanelHost();
  const id = useId();
  const counts = scopeCounts(model, view, visibility, selected);
  const [picked, setScope] = useState<DataScope>("loaded");
  const scope = picked === "selection" && counts.selected === 0 ? "loaded" : picked;
  const [numbers, setNumbers] = useState<ExportLanguage>(language === "de" ? "de" : "en");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  // The export that runs; closing the dialog cancels it, which lets the server stop too.
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);
  const csv = format === "csvNodes" || format === "csvEdges";

  function close() {
    running.current?.abort();
    onClose();
  }

  async function submit() {
    const run = host.exportData?.run;
    if (run === undefined) return;
    setBusy(true);
    setError(null);
    running.current?.abort();
    const controller = new AbortController();
    running.current = controller;
    try {
      // Only GraphML holds positions; the other formats are sent none.
      const drawing = format === "graphml" ? (scene?.() ?? null) : null;
      const graph = exportScope(scope, model, view, visibility, selected, drawing);
      saveFile(
        await run(
          { format, language: numbers, ...(graph === undefined ? {} : { graph }) },
          controller.signal,
        ),
      );
      running.current = null;
      onClose();
    } catch (e) {
      if (controller.signal.aborted) return;
      setError(e);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  const scopes: { value: DataScope; label: string; count: string; disabled?: boolean }[] = [
    {
      value: "loaded",
      label: t("graph.export.data.loaded"),
      count: countText(t, language, "node", counts.total),
    },
    {
      value: "visible",
      label: t("graph.export.data.visible"),
      count: countText(t, language, "node", counts.visible),
    },
    {
      value: "selection",
      label: t("graph.export.scope.selection"),
      count: countText(t, language, "node", counts.selected),
      disabled: counts.selected === 0,
    },
  ];

  return (
    <Dialog
      title={t("graph.export.data.title", { format: t(`graph.export.${format}`) })}
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
      <div className="graph-export__form">
        <fieldset className="radio-group">
          <legend className="field__label">{t("graph.export.scope")}</legend>
          {scopes.map((option) => (
            <label key={option.value} className="radio">
              <input
                type="radio"
                name={`${id}-scope`}
                value={option.value}
                checked={scope === option.value}
                disabled={option.disabled === true}
                onChange={() => setScope(option.value)}
              />
              <span>{option.label}</span>
              <span className="graph-export__count">{option.count}</span>
            </label>
          ))}
        </fieldset>
        {csv ? (
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
        <p className="field__hint">{t("graph.export.data.hint")}</p>
        {model.truncated || model.cut ? (
          <p className="graph-export__note">{t("graph.export.data.truncated")}</p>
        ) : null}
        {host.exportData?.stored === true ? (
          <p className="field__hint">{t("analysis.export.stored")}</p>
        ) : null}
        {error === null ? null : <FormAlert>{errorMessage(t, error)}</FormAlert>}
      </div>
    </Dialog>
  );
}
