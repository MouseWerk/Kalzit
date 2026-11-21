import { lazy, type RefObject, Suspense } from "react";
import type { ExportFormat } from "../../../api/generated/shapes";
import { ToolbarMenu, type ToolbarMenuEntry } from "../../../components/ToolbarMenu";
import { useI18n } from "../../../i18n/i18n";
import { usePanelHost } from "../../host";
import type { GraphPalette, RampName } from "../colors";
import type { GraphModel } from "../model";
import type { PropertyPaint } from "../paint";
import type { NodeShape } from "../shapes";
import type { GraphView, Visibility } from "../view";
import type { Scene } from "./scene";
import "./graphExport.css";

/**
 * The export menu of a graph panel (Graph081 board, frame 18): one menu, three groups. Pictures
 * (PNG, SVG, PDF) are made in the browser from what the panel shows, so everyone who sees the
 * panel may have them. GraphML, JSON and the two CSV files are data: the server makes them and
 * asks for `data:export`; without that right the menu says what is missing instead of offering
 * them. The dialogs, with everything that writes a file, load when one is opened.
 */

export type ImageFormat = "png" | "svg" | "pdf";
export type DataFormat = Extract<ExportFormat, "graphml" | "json" | "csvNodes" | "csvEdges">;

/** What the panel's legend shows, for the legend of a picture. */
export interface ExportLegend {
  labels: readonly { label: string; group: number; shape: NodeShape; count: number }[];
  /** Labels whose nodes the legend hides. */
  hidden: ReadonlySet<string>;
  /** Whether labels carry their colors (colors by label). */
  swatches: boolean;
  property: PropertyPaint | null;
  ramp: RampName;
  propertyName: string;
  sizeNote: string | null;
}

/** What the export reads from the panel: the dialogs take this. */
export interface ExportSource {
  title: string;
  /** Reads the drawing as it is now; null where nothing is drawn (the table view). */
  scene: (() => Scene | null) | null;
  /** The panel's element: the light palette is read inside it. */
  root: RefObject<HTMLElement | null>;
  palette: GraphPalette | null;
  model: GraphModel;
  view: GraphView;
  visibility: Visibility;
  /** The selected view nodes. */
  selected: ReadonlySet<number>;
  legend: ExportLegend;
}

export interface GraphExportProps extends ExportSource {
  /** The dialog that is open, kept by the panel so its context menus can open one too. */
  open: ExportOpen;
  onOpen: (open: ExportOpen) => void;
}

const LazyDialogs = lazy(() => import("./ExportDialogs"));

export type ExportOpen =
  | { kind: "image"; format: ImageFormat }
  | { kind: "data"; format: DataFormat }
  | null;

export function GraphExport(props: GraphExportProps) {
  const { t } = useI18n();
  const host = usePanelHost();
  const { open, onOpen: setOpen, ...dialogProps } = props;
  const drawn = props.scene !== null && props.palette !== null;
  const image = (format: ImageFormat, label: string): ToolbarMenuEntry => ({
    key: format,
    label,
    description: drawn ? t(`graph.export.${format}.hint`) : t("graph.export.notDrawn"),
    disabled: !drawn,
    onSelect: () => setOpen({ kind: "image", format }),
  });
  const data = (format: DataFormat): ToolbarMenuEntry => ({
    key: format,
    label: t(`graph.export.${format}`),
    description: t(`graph.export.${format}.hint`),
    onSelect: () => setOpen({ kind: "data", format }),
  });
  const entries: ToolbarMenuEntry[] = [
    { kind: "heading", key: "image-heading", label: t("graph.export.group.image") },
    image("png", t("graph.export.png")),
    image("svg", t("graph.export.svg")),
    image("pdf", t("graph.export.pdf")),
  ];
  const exportData = host.exportData;
  if (exportData?.allowed === true) {
    entries.push(
      { kind: "separator", key: "graph-rule" },
      { kind: "heading", key: "graph-heading", label: t("graph.export.group.graph") },
      data("graphml"),
      data("json"),
      { kind: "separator", key: "tables-rule" },
      { kind: "heading", key: "tables-heading", label: t("graph.export.group.tables") },
      data("csvNodes"),
      data("csvEdges"),
    );
  } else if (exportData !== undefined) {
    // Without the right the data formats are one entry that says what is missing.
    entries.push(
      { kind: "separator", key: "data-rule" },
      {
        key: "data-locked",
        label: t("graph.export.dataLocked"),
        description: t("graph.export.dataLockedHint"),
        shortcut: t("graph.export.dataLockedNote"),
        disabled: true,
        onSelect: () => {},
      },
    );
  }
  return (
    <>
      <ToolbarMenu
        label={t("graph.export.button")}
        icon="download"
        entries={entries}
        className="graph-export__button"
      />
      {open === null ? null : (
        <Suspense fallback={null}>
          <LazyDialogs {...dialogProps} open={open} onClose={() => setOpen(null)} />
        </Suspense>
      )}
    </>
  );
}
