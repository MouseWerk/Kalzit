/**
 * Web Mercator, as map images use it (so they can lie under the data later): the world is a square of side 1 with the origin top left
 * (`x` east, `y` south). Everything on the map is placed in these world units; the view turns
 * them into pixels.
 */

/** Beyond this latitude the square ends. */
export const MAX_LATITUDE = 85.0511287798066;
/** The side of the world in pixels at zoom 0. */
export const TILE_SIZE = 256;
export const MIN_ZOOM = 0;
/** Outlines are simplified for country and region scale; beyond this they stop helping. */
export const MAX_ZOOM = 12;
/** A fit never zooms closer than this, so one single point does not fill the panel with nothing. */
export const MAX_FIT_ZOOM = 9;

export interface World {
  x: number;
  y: number;
}

export interface View {
  /** The world point in the middle of the panel. */
  center: World;
  /** Continuous; the world is `TILE_SIZE * 2 ** zoom` pixels wide. */
  zoom: number;
}

export interface Size {
  width: number;
  height: number;
}

export function isCoordinate(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
  );
}

export function project(lat: number, lon: number): World {
  const clamped = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat));
  const sin = Math.sin((clamped * Math.PI) / 180);
  return { x: (lon + 180) / 360, y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI) };
}

export function unproject(world: World): { lat: number; lon: number } {
  const n = Math.PI * (1 - 2 * world.y);
  return { lat: (Math.atan(Math.sinh(n)) * 180) / Math.PI, lon: world.x * 360 - 180 };
}

/** Pixels the whole world is wide at `zoom`. */
export function worldPixels(zoom: number): number {
  return TILE_SIZE * 2 ** zoom;
}

export function toScreen(world: World, view: View, size: Size): { x: number; y: number } {
  const scale = worldPixels(view.zoom);
  return {
    x: (world.x - view.center.x) * scale + size.width / 2,
    y: (world.y - view.center.y) * scale + size.height / 2,
  };
}

export function toWorld(screen: { x: number; y: number }, view: View, size: Size): World {
  const scale = worldPixels(view.zoom);
  return {
    x: view.center.x + (screen.x - size.width / 2) / scale,
    y: view.center.y + (screen.y - size.height / 2) / scale,
  };
}

export function clampZoom(zoom: number, max = MAX_ZOOM): number {
  return Math.max(MIN_ZOOM, Math.min(max, zoom));
}

/** Keeps the middle of the panel on the world. */
export function clampView(view: View, maxZoom = MAX_ZOOM): View {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  return {
    center: { x: clamp(view.center.x), y: clamp(view.center.y) },
    zoom: clampZoom(view.zoom, maxZoom),
  };
}

/** The whole world, as large as it fits. */
export function worldView(size: Size): View {
  const zoom = Math.log2(Math.max(1, Math.min(size.width, size.height)) / TILE_SIZE);
  return { center: { x: 0.5, y: 0.5 }, zoom: clampZoom(zoom) };
}

/**
 * The view that shows all `points` with `padding` pixels around them; the whole world when there
 * are none.
 */
export function fitView(points: readonly World[], size: Size, padding = 28): View {
  if (points.length === 0) {
    return worldView(size);
  }
  let [minX, minY, maxX, maxY] = [1, 1, 0, 0];
  for (const { x, y } of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const width = Math.max(1, size.width - 2 * padding);
  const height = Math.max(1, size.height - 2 * padding);
  const span = Math.max((maxX - minX) / width, (maxY - minY) / height);
  const zoom = span <= 0 ? MAX_FIT_ZOOM : Math.log2(1 / (span * TILE_SIZE));
  return {
    center: { x: (minX + maxX) / 2, y: (minY + maxY) / 2 },
    zoom: Math.max(MIN_ZOOM, Math.min(MAX_FIT_ZOOM, zoom)),
  };
}

/** Zooms by `delta` levels while the world point under `anchor` stays under it. */
export function zoomAt(
  view: View,
  size: Size,
  anchor: { x: number; y: number },
  delta: number,
  maxZoom = MAX_ZOOM,
): View {
  const zoom = clampZoom(view.zoom + delta, maxZoom);
  const fixed = toWorld(anchor, view, size);
  const scale = worldPixels(zoom);
  return clampView(
    {
      center: {
        x: fixed.x - (anchor.x - size.width / 2) / scale,
        y: fixed.y - (anchor.y - size.height / 2) / scale,
      },
      zoom,
    },
    maxZoom,
  );
}

export function panBy(view: View, dx: number, dy: number, maxZoom = MAX_ZOOM): View {
  const scale = worldPixels(view.zoom);
  return clampView(
    { center: { x: view.center.x - dx / scale, y: view.center.y - dy / scale }, zoom: view.zoom },
    maxZoom,
  );
}

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;

/** Metres one pixel covers at the latitude of the view's middle. */
export function metresPerPixel(view: View): number {
  const { lat } = unproject(view.center);
  return (EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180)) / worldPixels(view.zoom);
}

/** A scale bar of a round length (1, 2 or 5 times a power of ten) at most `maxPixels` wide. */
export function scaleBar(view: View, maxPixels = 96): { metres: number; pixels: number } {
  const perPixel = metresPerPixel(view);
  const most = perPixel * maxPixels;
  const power = 10 ** Math.floor(Math.log10(most));
  const metres = ([5, 2, 1].find((step) => step * power <= most) ?? 1) * power;
  return { metres, pixels: metres / perPixel };
}
