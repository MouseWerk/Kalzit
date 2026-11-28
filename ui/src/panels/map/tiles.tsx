import { useContext, useRef } from "react";
import { MapEndpointsContext } from "./source";
import "./map.css";

/**
 * Map images under a map (docs/api/map.md): the pictures of the source the server setting names,
 * always fetched through this server. Used by the map panel and by the graph layout "Karte"; both
 * hand over where the world's top left corner is on the stage and how wide the world is in px.
 */

/** The side of one map image in px at its own zoom level. */
const IMAGE_SIZE = 256;
/** Failed pictures in a row after which a map gives up on them and draws the outlines. */
export const FAILED_TILES = 8;
/** At most this many pictures are asked for at once; more would be a view far too large. */
const MAX_TILES = 400;

export interface Tile {
  z: number;
  x: number;
  y: number;
  /** Where the picture lies on the stage, in px. */
  left: number;
  top: number;
  size: number;
}

/**
 * The pictures that cover a stage of `width` x `height` px when the world (Web Mercator, a square)
 * starts at `origin` and is `worldPx` wide: the zoom level nearest to the view, at most
 * `maxZoom`, so beyond it the largest pictures are drawn larger.
 */
export function visibleTiles(
  origin: { x: number; y: number },
  worldPx: number,
  size: { width: number; height: number },
  maxZoom: number,
): Tile[] {
  if (!(worldPx > 0) || size.width <= 0 || size.height <= 0) return [];
  const wanted = Math.round(Math.log2(worldPx / IMAGE_SIZE));
  const z = Math.max(0, Math.min(Math.floor(maxZoom), wanted));
  const count = 2 ** z;
  const tileSize = worldPx / count;
  const first = (edge: number) => Math.max(0, Math.floor(-edge / tileSize));
  // A picture that would start exactly at the stage's far edge shows nothing.
  const last = (edge: number, extent: number) =>
    Math.min(count - 1, Math.ceil((extent - edge) / tileSize) - 1);
  const tiles: Tile[] = [];
  for (let y = first(origin.y); y <= last(origin.y, size.height); y++) {
    for (let x = first(origin.x); x <= last(origin.x, size.width); x++) {
      if (tiles.length >= MAX_TILES) return tiles;
      tiles.push({
        z,
        x,
        y,
        left: origin.x + x * tileSize,
        top: origin.y + y * tileSize,
        size: tileSize,
      });
    }
  }
  return tiles;
}

/**
 * The pictures as an SVG group with a pale veil over them. A map gives up on them (`onFailed`)
 * after `FAILED_TILES` failures in a row, or when every picture of the first view failed; the map
 * then draws the outlines and says so.
 */
export function TileLayer({
  tiles,
  width,
  height,
  onFailed,
}: {
  tiles: readonly Tile[];
  width: number;
  height: number;
  onFailed: () => void;
}) {
  const endpoints = useContext(MapEndpointsContext);
  const count = useRef({ loaded: 0, failed: 0, inRow: 0 });
  const failed = () => {
    const now = count.current;
    now.failed += 1;
    now.inRow += 1;
    if (now.inRow >= FAILED_TILES || (now.loaded === 0 && now.failed >= tiles.length)) {
      onFailed();
    }
  };
  const loaded = () => {
    count.current.loaded += 1;
    count.current.inRow = 0;
  };
  return (
    <g className="map__tiles" data-testid="map-tiles">
      {tiles.map((tile) => (
        <image
          key={`${tile.z}/${tile.x}/${tile.y}`}
          href={endpoints.tile(tile.z, tile.x, tile.y)}
          x={tile.left}
          y={tile.top}
          // Half a pixel over the neighbours, so no seam shows between scaled pictures.
          width={tile.size + 0.5}
          height={tile.size + 0.5}
          preserveAspectRatio="none"
          onLoad={loaded}
          onError={failed}
        />
      ))}
      {/* The pictures lie pale under the data: points, nodes and edges stay in front. */}
      <rect className="map__veil" width={width} height={height} />
    </g>
  );
}
