import type { DashboardModel, PanelModel } from "./model";

/**
 * Unsaved work on one dashboard, kept in this tab's session storage so a reload (or the panel
 * editor's address opened again in the same tab) comes back to it: the draft, and the panel the
 * editor holds that is not in the draft yet. Only for the version it was made on; a newer saved
 * version starts clean. Storage can be missing or full; then nothing is kept, nothing breaks.
 */
export interface KeptDraft {
  version: number;
  model: DashboardModel;
  /** The open editor: the panel's id, or `new` for one being added, and the panel as edited. */
  editor?: { key: string; panel: PanelModel } | undefined;
}

const key = (dashboardId: string) => `kalzit.draft.${dashboardId}`;

export function readDraft(dashboardId: string, version: number): KeptDraft | null {
  try {
    const raw = window.sessionStorage.getItem(key(dashboardId));
    if (raw === null) {
      return null;
    }
    const kept = JSON.parse(raw) as Partial<KeptDraft> | null;
    if (
      kept === null ||
      typeof kept !== "object" ||
      kept.version !== version ||
      typeof kept.model !== "object" ||
      kept.model === null ||
      !Array.isArray(kept.model.panels)
    ) {
      return null;
    }
    const editor =
      typeof kept.editor === "object" &&
      kept.editor !== null &&
      typeof kept.editor.key === "string" &&
      typeof kept.editor.panel === "object" &&
      kept.editor.panel !== null
        ? kept.editor
        : undefined;
    return { version, model: kept.model, editor };
  } catch {
    return null;
  }
}

/** Keeps `draft` for the dashboard, or forgets it with `null`. */
export function writeDraft(dashboardId: string, draft: KeptDraft | null): void {
  try {
    if (draft === null) {
      window.sessionStorage.removeItem(key(dashboardId));
    } else {
      window.sessionStorage.setItem(key(dashboardId), JSON.stringify(draft));
    }
  } catch {
    // Not kept for a reload; the draft still lives on this page.
  }
}
