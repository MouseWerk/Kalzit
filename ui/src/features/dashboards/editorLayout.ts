import { readPreference, writePreference } from "../../lib/storage";

/**
 * The panel editor's splits as each user left them: the options pane's width, the preview's
 * height and whether the options pane is collapsed. Kept in this browser per account (there is
 * no server preference for it); anything unreadable falls back to the defaults.
 */
export interface EditorLayout {
  /** Width of the options pane in px; absent for the default. */
  options?: number;
  /** Height of the preview in px; absent for half the editor. */
  preview?: number;
  /** The options pane is folded away. */
  collapsed?: boolean;
}

export const EDITOR_LAYOUT_KEY = "kalzit.editor.layout";

function readAll(): Record<string, EditorLayout> {
  const raw = readPreference(EDITOR_LAYOUT_KEY);
  if (raw === null || raw === "") {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, EditorLayout>)
      : {};
  } catch {
    return {};
  }
}

const size = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : undefined;

/** The layout `userId` left the editor in; only well-formed values are taken. */
export function readEditorLayout(userId: string): EditorLayout {
  const stored = readAll()[userId];
  if (typeof stored !== "object" || stored === null) {
    return {};
  }
  const layout: EditorLayout = {};
  const options = size(stored.options);
  const preview = size(stored.preview);
  if (options !== undefined) layout.options = options;
  if (preview !== undefined) layout.preview = preview;
  if (stored.collapsed === true) layout.collapsed = true;
  return layout;
}

/** Remembers `layout` for `userId`, leaving the other accounts' layouts as they are. */
export function writeEditorLayout(userId: string, layout: EditorLayout): void {
  writePreference(EDITOR_LAYOUT_KEY, JSON.stringify({ ...readAll(), [userId]: layout }));
}
