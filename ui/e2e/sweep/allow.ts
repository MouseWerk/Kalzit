import type { Allowed } from "../support/audit";

/**
 * Known exceptions of the UI sweep, each with its reason. An entry holds for a check, for the
 * elements its selector matches (the finding's element or one it lies in) and, when `page` is
 * given, for the pages of that name only. Allowed findings stay in the report, in a list of their
 * own, so an exception is never out of sight. Keep this list short: an entry is for what is right
 * as it is, not for what nobody got to yet.
 */
export const ALLOWED: readonly Allowed[] = [
  {
    check: "clipped-text",
    selector: ".cm-editor",
    reason: "the query editor scrolls its own lines; CodeMirror measures and clips them itself",
  },
  {
    check: "overlap",
    selector: ".cm-editor",
    reason: "the editor's content and its scroller are one control",
  },
  {
    check: "overlap",
    selector: ".nav-group__toggle",
    reason:
      "the toggle of a navigation group sits on the right end of its link by design: one row, the link opens the page, the chevron folds the group",
  },
  {
    check: "target-size",
    selector: ".splitter",
    reason:
      "a splitter is a 12 px line between two panes; it is as long as the pane and moves with the arrow keys",
  },
];
