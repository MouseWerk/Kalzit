import { createContext, useContext, useEffect, useState } from "react";
import { isRecord, request } from "../../api/client";
import { withBase } from "../../lib/basePath";

/**
 * Where a map gets its map images from. Always this server (docs/api/map.md): the browser never
 * talks to a map service. Signed-in pages use the routes of the session; the page of a public
 * link uses the link's own routes, which serve only links that show a map; a page without either
 * (a public snapshot) has no map images and draws outlines.
 */
export interface MapEndpoints {
  /** The path that says whether there are map images; null where there are none to ask for. */
  info: string | null;
  tile: (z: number, x: number, y: number) => string;
}

export const SESSION_MAP: MapEndpoints = {
  info: "/api/map",
  tile: (z, x, y) => withBase(`/api/map/tiles/${z}/${x}/${y}`),
};

export const NO_MAP_IMAGES: MapEndpoints = { info: null, tile: () => "" };

export function publicLinkMap(token: string): MapEndpoints {
  const base = `/api/public/dashboards/${encodeURIComponent(token)}/map`;
  return { info: base, tile: (z, x, y) => withBase(`${base}/tiles/${z}/${x}/${y}`) };
}

export const MapEndpointsContext = createContext<MapEndpoints>(SESSION_MAP);

export interface MapInfo {
  tiles: boolean;
  /** The attribution the server setting names; shown on every map with map images. */
  attribution: string;
  maxZoom: number;
  /** False while the server's source failed lately: the map draws outlines without asking. */
  available: boolean;
}

export const NO_TILES: MapInfo = { tiles: false, attribution: "", maxZoom: 0, available: false };

/** How long an answer is reused before a map asks again. */
const INFO_TTL_MS = 60_000;

const answers = new Map<string, { at: number; info: Promise<MapInfo> }>();

function parseInfo(value: unknown): MapInfo {
  if (
    isRecord(value) &&
    value.tiles === true &&
    typeof value.attribution === "string" &&
    typeof value.maxZoom === "number"
  ) {
    return {
      tiles: true,
      attribution: value.attribution,
      maxZoom: value.maxZoom,
      available: value.available !== false,
    };
  }
  return NO_TILES;
}

function loadInfo(path: string): Promise<MapInfo> {
  const kept = answers.get(path);
  if (kept !== undefined && Date.now() - kept.at < INFO_TTL_MS) {
    return kept.info;
  }
  // A map without an answer draws outlines: the data never waits for the map images.
  const info = request("GET", path).then(parseInfo, () => NO_TILES);
  answers.set(path, { at: Date.now(), info });
  return info;
}

/** After the setting changed (Verwaltung > Karte), and between tests. */
export function forgetMapInfo(): void {
  answers.clear();
}

/** Whether this page has map images, and what to write under them; none until the answer is in. */
export function useMapInfo(): MapInfo {
  const { info: path } = useContext(MapEndpointsContext);
  const [info, setInfo] = useState<{ path: string | null; info: MapInfo }>({
    path: null,
    info: NO_TILES,
  });
  useEffect(() => {
    if (path === null) {
      return;
    }
    let current = true;
    void loadInfo(path).then((loaded) => {
      if (current) {
        setInfo({ path, info: loaded });
      }
    });
    return () => {
      current = false;
    };
  }, [path]);
  return info.path === path ? info.info : NO_TILES;
}
