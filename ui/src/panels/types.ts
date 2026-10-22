import type { ReactNode } from "react";
import type { DocumentSet, Frame, Shape } from "../api/generated/shapes";
import type { MessageKey } from "../i18n/i18n";

/**
 * The contract of a panel type (docs/ARCHITECTURE.md, "UI structure"): each folder in
 * `ui/src/panels/<type>/` exports one of these, and `registry.ts` lists them.
 */
export interface PanelPlugin<Options = Record<string, unknown>> {
  type: string;
  /** Catalog key of the name shown in the panel picker. */
  name: MessageKey;
  /** Result shapes the panel can show; the picker offers matching panels first. */
  shapes: readonly Shape[];
  /** Fills in defaults for options stored by an older version or by hand. */
  options: (stored: unknown) => Options;
  Panel: (props: PanelProps<Options>) => ReactNode;
  Editor: (props: PanelEditorProps<Options>) => ReactNode;
}

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
