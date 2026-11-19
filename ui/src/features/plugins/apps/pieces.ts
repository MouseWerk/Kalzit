import { pieceSource } from "../../../components/LazyPiece";
import { loadArea } from "../../../i18n/i18n";
import type { Plugin, PluginDetail } from "../api";

/**
 * What the plugin pages show of an app, each with the texts of the app area: they load when an
 * app is looked at, since most servers have none.
 */
export const APP_GRANTS = pieceSource<{ plugin: Plugin }>(() =>
  loadArea("apps")
    .then(() => import("./parts"))
    .then((module) => ({ default: module.PluginAppGrants })),
);

export const APP_CAPS = pieceSource<{ capabilities: readonly string[] }>(() =>
  loadArea("apps")
    .then(() => import("./parts"))
    .then((module) => ({ default: module.CapabilityList })),
);

export const APP_CARD = pieceSource<{ plugin: PluginDetail; now: number }>(() =>
  loadArea("apps")
    .then(() => import("./PluginAppCard"))
    .then((module) => ({ default: module.PluginAppCard })),
);
