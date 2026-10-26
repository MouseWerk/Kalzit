import type { Translate } from "../../i18n/i18n";
import { getPanel } from "../../panels/registry";

/** The panel type's name, for lists, dialogs and the picker; an unknown type as stored. */
export function visualizationName(t: Translate, type: string): string {
  const plugin = getPanel(type);
  return plugin === undefined ? type : t(plugin.name);
}
