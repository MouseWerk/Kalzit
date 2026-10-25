import type { ReactNode } from "react";
import type { DocumentSet, Frame, GraphSet, Shape } from "../api/generated/shapes";
import type { MessageKey } from "../i18n/i18n";
import type { FieldConfig } from "./fieldConfig/fieldConfig";

/**
 * The contract of a panel type (docs/ARCHITECTURE.md, "UI structure"): each folder in
 * `ui/src/panels/<type>/` exports one of these, and `registry.ts` lists them.
 */
export interface PanelPlugin<Options = Record<string, unknown>> {
  type: string;
  /** Catalog key of the name shown in the panel picker. */
  name: MessageKey;
  /** Catalog key of the one-line description in the panel picker. */
  description?: MessageKey;
  /** Result shapes the panel can show; the picker offers matching panels first. */
  shapes: readonly Shape[];
  /** Fills in defaults for options stored by an older version or by hand. */
  options: (stored: unknown) => Options;
  Panel: (props: PanelProps<Options>) => ReactNode;
  Editor: (props: PanelEditorProps<Options>) => ReactNode;
  /**
   * Which of the shared field options (`fieldConfig`) the panel uses; the panel editor shows
   * those under the panel's own options. Absent: the panel uses none.
   */
  fieldOptions?: readonly FieldOptionGroup[];
  /** The panel draws without a query (text); it gets no frames. */
  standalone?: boolean;
  /** A small drawing for the panel picker, made of palette classes only. */
  Preview?: () => ReactNode;
}

/**
 * Groups of the field options editor, so each panel shows only what it uses. `graphStyle` is how
 * series are drawn, the time series' graph style (`fieldConfig/graphStyle.ts`).
 */
export type FieldOptionGroup =
  | "graphStyle"
  | "standard"
  | "range"
  | "thresholds"
  | "mappings"
  | "color"
  /** The time series' colours: scheme, free colours, per-series rows (`ColorsEditor`). */
  | "colors"
  | "table"
  | "overrides";

/**
 * A panel of any options type, as the registry holds them. Callers keep the pairing intact by
 * passing a panel only the options its own `options()` returned.
 */
// biome-ignore lint/suspicious/noExplicitAny: each panel has its own options type; the list erases it
export type AnyPanelPlugin = PanelPlugin<any>;

export interface PanelProps<Options> {
  /** Frames of every target that answered, in target order. */
  frames: readonly Frame[];
  options: Options;
  /** The resolved time range, Unix ms, for axes that should span it even with sparse data. */
  timeRange: { from: number; to: number };
  /** Accessible name of the visualization: the panel title. */
  title: string;
  /** The panel's field options, parsed; absent means none are set. */
  fieldConfig?: FieldConfig;
  /** Current values of the dashboard variables, for panels that show text. */
  variables?: Readonly<Record<string, string>>;
  /** Graphs of every target that answered with one, in target order (graph panels). */
  graphs?: readonly PanelGraph[] | undefined;
  /** Document sets of every target that answered with documents, in target order. */
  documents?: readonly DocumentSet[] | undefined;
  /**
   * Click-to-filter on a value of document set `index`: there where the query can change
   * (Explore, the panel editor), absent on dashboards, where viewers only read.
   */
  onFilter?: ((filter: DocumentFilter) => void) | undefined;
  /**
   * Changes when another result arrives (a run, a page loaded after it); panels that keep a place
   * in the result, such as a drilldown, start over then.
   */
  revision?: string | number | undefined;
}

/** One target's graph, with the source it came from (explorer mode queries it again). */
export interface PanelGraph {
  refId: string;
  datasourceId: string;
  graph: GraphSet;
}

export interface DocumentFilter {
  /** Index into `documents`. */
  index: number;
  /** A filter path without array indexes (`items.price`). */
  path: string;
  value: unknown;
}

export interface PanelEditorProps<Options> {
  options: Options;
  onChange: (options: Options) => void;
}
