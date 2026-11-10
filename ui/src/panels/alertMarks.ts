import { createContext, useContext } from "react";

/**
 * The limits of the alert rules made from a panel, which a time series draws as dashed lines
 * (board Alerting.dc.html, frame 12). The dashboard provides them around each panel; a panel
 * without a provider draws none, so the panel contract stays as it is.
 */
export interface PanelAlertMarks {
  /** Values on the value axis where a rule's condition changes. */
  limits: readonly number[];
}

export const PanelAlertMarksContext = createContext<PanelAlertMarks | null>(null);

export function usePanelAlertMarks(): PanelAlertMarks | null {
  return useContext(PanelAlertMarksContext);
}
