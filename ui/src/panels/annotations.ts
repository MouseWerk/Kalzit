import { createContext, useContext } from "react";

/**
 * Annotations a time panel draws on its time axis. The dashboard provides them around each panel
 * (manual ones and those of annotation queries); a panel without a provider draws none. Panels
 * read them here instead of through their props, so every panel type with a time axis can show
 * them without a change to the panel contract.
 */
export interface PanelAnnotation {
  key: string;
  time: number;
  /** Set for a span. */
  timeEnd: number | null;
  text: string;
  tags: readonly string[];
  /** 1 to 8: an entry of the chart palette; none draws the neutral annotation color. */
  color?: number | undefined;
}

export interface PanelAnnotations {
  marks: readonly PanelAnnotation[];
  /** Opens one annotation (to read, or to change for those who may). */
  onOpen: (mark: PanelAnnotation) => void;
  /** Present for those who may write: adds one at a time on the axis. */
  onAdd?: ((time: number) => void) | undefined;
}

export const PanelAnnotationsContext = createContext<PanelAnnotations | null>(null);

export function usePanelAnnotations(): PanelAnnotations | null {
  return useContext(PanelAnnotationsContext);
}
