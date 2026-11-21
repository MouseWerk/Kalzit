import { codeMirrorKey } from "../../../shortcuts/keyNames";
import { bindingsOf, shortcutText } from "../../../shortcuts/registry";

/**
 * The query editors' keys as the hint under each editor names them, from the registry, so they
 * are right on every platform ("Strg+Eingabe" on Windows, Cmd and Return on a Mac).
 */
export function editorHintKeys(): { run: string; suggest: string } {
  return { run: shortcutText("explore.run"), suggest: shortcutText("editor.suggest") };
}

/**
 * CodeMirror's names for a shortcut of the registry ("Mod-Shift-z"), so the editors' key map is
 * built from the same definitions as the help: redo takes both of its combinations everywhere.
 */
export function codeMirrorKeys(id: string): string[] {
  return bindingsOf(id).flatMap((binding) =>
    binding.kind === "combo" ? [codeMirrorKey(binding)] : [],
  );
}
