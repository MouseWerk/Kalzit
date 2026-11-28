import { useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { useElementSize } from "../useElementSize";
import { OUTLINE_UNITS } from "./outlines";
import { TILE_SIZE } from "./projection";
import { useMapInfo } from "./source";
import { TileLayer, visibleTiles } from "./tiles";
import { useOutlines } from "./useOutlines";
import "./map.css";

/** Region borders join the outlines from this zoom on, as on the map panel. */
const REGIONS_FROM_ZOOM = 3;

/**
 * The map under a graph laid out as "Karte" (board Graph081.dc.html, frames 13 and 15): the same
 * drawing as the map panel's, under the graph canvas, which stays as it is (style rules,
 * selection, search, history). The canvas hands over where the world lies on the stage after each
 * frame; the map follows. Map images when the server has them, else the bundled outlines; the
 * attribution always shows.
 */
export function MapBackdrop({
  northWest,
  worldPx,
}: {
  /** Where the world's north-west corner is on the stage, in px. */
  northWest: { x: number; y: number };
  /** How wide the whole world is on the stage, in px. */
  worldPx: number;
}) {
  const { t } = useI18n();
  const boxRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(boxRef);
  const info = useMapInfo();
  const [tilesFailed, setTilesFailed] = useState(false);
  const tilesDown = info.tiles && (!info.available || tilesFailed);
  const tilesOn = info.tiles && !tilesDown;
  const zoom = Math.log2(Math.max(1, worldPx) / TILE_SIZE);
  const outlines = useOutlines(!tilesOn, zoom >= REGIONS_FROM_ZOOM);
  const tiles = tilesOn ? visibleTiles(northWest, worldPx, size, info.maxZoom) : [];
  const scale = worldPx / OUTLINE_UNITS;
  const transform = `translate(${northWest.x} ${northWest.y}) scale(${scale})`;
  const attribution = tilesOn ? info.attribution : t("map.outlines.note");
  return (
    <div ref={boxRef} className="graph-map" data-testid="graph-map">
      <svg
        className="graph-map__svg"
        width={size.width}
        height={size.height}
        aria-hidden="true"
        focusable="false"
      >
        {tiles.length > 0 ? (
          <TileLayer
            tiles={tiles}
            width={size.width}
            height={size.height}
            onFailed={() => setTilesFailed(true)}
          />
        ) : null}
        {outlines.world === null ? null : (
          <g transform={transform} data-testid="map-outlines">
            <path className="map__land" d={outlines.world.land} />
            <path className="map__lake" d={outlines.world.lake} />
            {outlines.regions === null ? null : (
              <path className="map__region" d={outlines.regions.region} />
            )}
            <path className="map__country" d={outlines.world.country} />
          </g>
        )}
      </svg>
      <div className="graph-map__corner">
        <p className="map__attribution">{attribution}</p>
        {tilesDown ? (
          <p className="map__notice" role="status">
            <Icon name="alert" />
            <span>
              <b>{t("map.tiles.failedTitle")}</b> {t("map.tiles.failedText")}
            </span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
