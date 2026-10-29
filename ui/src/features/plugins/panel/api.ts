import { queryOptions } from "@tanstack/react-query";
import { expectShape, isRecord, request } from "../../../api/client";
import type { Shape } from "../../../api/generated/shapes";
import { type PanelOption, parsePanelOption } from "./options";

/**
 * The panel plugins of an organization (docs/api/plugins.md, "Panel plugins"): the panel types
 * its members may use, with the options each declares, and the address of a panel's frame.
 */

export interface PanelPluginInfo {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** As the manifest names it: a neutral badge, not a verified identity. */
  publisher?: string;
  /** `kalzit`, `publisher` or `unsigned`. */
  signer: string;
  shapes: Shape[];
  /** The panel message API version the bundle speaks. */
  api: number;
  options: PanelOption[];
}

const SHAPES: readonly Shape[] = ["frame", "documents", "graph"];

function parseInfo(raw: unknown): PanelPluginInfo | null {
  if (!isRecord(raw) || typeof raw.id !== "string" || typeof raw.name !== "string") {
    return null;
  }
  const info: PanelPluginInfo = {
    id: raw.id,
    name: raw.name,
    version: typeof raw.version === "string" ? raw.version : "",
    signer: typeof raw.signer === "string" ? raw.signer : "unsigned",
    shapes: Array.isArray(raw.shapes)
      ? SHAPES.filter((shape) => (raw.shapes as unknown[]).includes(shape))
      : [],
    api: typeof raw.api === "number" ? raw.api : 0,
    options: Array.isArray(raw.options)
      ? raw.options.flatMap((o) => {
          const option = parsePanelOption(o);
          return option === null ? [] : [option];
        })
      : [],
  };
  if (typeof raw.description === "string") {
    info.description = raw.description;
  }
  if (typeof raw.publisher === "string") {
    info.publisher = raw.publisher;
  }
  return info;
}

function isList(value: unknown): value is { items: unknown[] } {
  return isRecord(value) && Array.isArray(value.items);
}

export async function fetchPanelPlugins(
  orgId: string,
  signal?: AbortSignal,
): Promise<PanelPluginInfo[]> {
  const answer = expectShape(
    await request("GET", `/api/orgs/${encodeURIComponent(orgId)}/panel-plugins`, undefined, {
      signal,
    }),
    isList,
    "panel plugins",
  );
  // A panel of an API version this UI does not speak is left out.
  return answer.items.flatMap((item) => {
    const info = parseInfo(item);
    return info === null || info.api !== 1 ? [] : [info];
  });
}

export const PANEL_PLUGINS_KEY = "panel-plugins";

export function panelPluginsQuery(orgId: string) {
  return queryOptions({
    queryKey: [PANEL_PLUGINS_KEY, orgId],
    queryFn: ({ signal }) => fetchPanelPlugins(orgId, signal),
    staleTime: 60_000,
  });
}

/**
 * Where a panel's frame document is served. With the dashboard it is drawn on; without one for
 * a new dashboard that is not saved yet. The version makes a new version load afresh.
 */
export function frameUrl(orgId: string, info: PanelPluginInfo, dashboardId?: string): string {
  const search = new URLSearchParams();
  if (dashboardId !== undefined) {
    search.set("dashboard", dashboardId);
  }
  search.set("v", info.version);
  return `/api/orgs/${encodeURIComponent(orgId)}/panel-plugins/${encodeURIComponent(info.id)}/frame?${search}`;
}
