import type { DashboardModel, PanelModel } from "./model";

/**
 * Unsaved work on one dashboard, kept in this tab's session storage so a reload (or the panel
 * editor's address opened again in the same tab) comes back to it: the draft, and the panel the
 * editor holds that is not in the draft yet. Kept per account, organization and dashboard, and
 * only for the version it was made on; a newer saved version starts clean. Signing out forgets
 * every kept draft (`forgetDrafts`), so the next person in the tab never sees one. Only the few
 * latest drafts are kept. Storage can be missing or full; then nothing is kept, nothing breaks.
 */
export interface KeptDraft {
  version: number;
  model: DashboardModel;
  /** The open editor: the panel's id, or `new` for one being added, and the panel as edited. */
  editor?: { key: string; panel: PanelModel } | undefined;
}

/** Whose draft it is: the account and organization it was made in. */
export interface DraftOwner {
  userId: string;
  orgId: string;
}

const PREFIX = "kalzit.draft.";
/** Drafts kept at most; the oldest go first. */
export const MAX_KEPT_DRAFTS = 5;

const key = (owner: DraftOwner, dashboardId: string) =>
  `${PREFIX}${owner.userId}.${owner.orgId}.${dashboardId}`;

interface Stored extends KeptDraft {
  userId: string;
  orgId: string;
  /** When it was written, for keeping only the latest. */
  at: number;
}

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function keys(store: Storage): string[] {
  const found: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const name = store.key(i);
    if (name?.startsWith(PREFIX)) {
      found.push(name);
    }
  }
  return found;
}

export function readDraft(
  owner: DraftOwner,
  dashboardId: string,
  version: number,
): KeptDraft | null {
  try {
    const raw = storage()?.getItem(key(owner, dashboardId)) ?? null;
    if (raw === null) {
      return null;
    }
    const kept = JSON.parse(raw) as Partial<Stored> | null;
    if (
      kept === null ||
      typeof kept !== "object" ||
      // Written by this account in this organization, for this version.
      kept.userId !== owner.userId ||
      kept.orgId !== owner.orgId ||
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
export function writeDraft(owner: DraftOwner, dashboardId: string, draft: KeptDraft | null): void {
  const store = storage();
  if (store === null) {
    return;
  }
  try {
    if (draft === null) {
      store.removeItem(key(owner, dashboardId));
      return;
    }
    const stored: Stored = { ...draft, userId: owner.userId, orgId: owner.orgId, at: Date.now() };
    store.setItem(key(owner, dashboardId), JSON.stringify(stored));
    // Only the latest few: this one and the newest others; older drafts of this tab go.
    const mine = key(owner, dashboardId);
    const ages = keys(store)
      .filter((name) => name !== mine)
      .map((name) => {
        try {
          return { name, at: (JSON.parse(store.getItem(name) ?? "{}") as Partial<Stored>).at ?? 0 };
        } catch {
          return { name, at: 0 };
        }
      });
    ages.sort((a, b) => b.at - a.at);
    for (const old of ages.slice(MAX_KEPT_DRAFTS - 1)) {
      store.removeItem(old.name);
    }
  } catch {
    // Not kept for a reload; the draft still lives on this page.
  }
}

/** Forgets every kept draft of this tab: on signing out or in as someone else. */
export function forgetDrafts(): void {
  const store = storage();
  if (store === null) {
    return;
  }
  try {
    for (const name of keys(store)) {
      store.removeItem(name);
    }
  } catch {
    // Nothing more to do.
  }
}
