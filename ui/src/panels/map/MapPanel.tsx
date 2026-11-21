import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { countText } from "../graph/plural";
import { EmptyPanel } from "../shared";
import type { PanelProps } from "../types";
import { useElementSize } from "../useElementSize";
import {
  bundledWidth,
  type Cluster,
  type ClusterEdge,
  clusterEdges,
  clusterPoints,
  clusterRadius,
} from "./cluster";
import type { MapOptions } from "./options";
import { loadOutlines, OUTLINE_UNITS, type OutlinePaths } from "./outlines";
import { MAX_POINTS, type MapData, mapData } from "./points";
import {
  fitView,
  MAX_ZOOM,
  panBy,
  type Size,
  scaleBar,
  toScreen,
  toWorld,
  unproject,
  type View,
  visibleTiles,
  worldPixels,
  worldView,
  zoomAt,
} from "./projection";
import { MapEndpointsContext, type MapInfo, useMapInfo } from "./source";
import "../graph/graph.css";
import "./map.css";

/** Names of nodes without a place shown in the strip; more are a count with the list in its title. */
const MISSING_SHOWN = 5;
/** Region borders join the outlines from this zoom on; below, they would be a grey mass. */
const REGIONS_FROM_ZOOM = 3;
/** Up to this many single points get their name written next to them. */
const NAMED_POINTS = 24;
/**
 * Map images that failed in a row before the map gives up on them and draws outlines. One that
 * fails alone is an empty place (the source has no such image).
 */
const FAILED_TILES = 8;
/** Up to this many drawn points and bundles can be reached with Tab; more are read in the table. */
const FOCUSABLE_MARKS = 60;
const PAN_STEP = 48;
/** How much of the background lies over the map images, so the data stays in front. */
const VEIL = 0.45;

type Mode = "map" | "table";

/**
 * The map panel (board Graph081.dc.html, frames 15 and 16): rows, documents and graph nodes with
 * coordinates as points, a graph's edges as lines between them, near points bundled. Without map
 * images (the state after installation) the points lie over the bundled outlines and a graticule
 * and no request leaves this server; with map images the pictures come through this server and
 * lie pale under the data, with the attribution of the setting.
 */
export function MapPanel({
  frames,
  documents,
  graphs,
  options,
  title,
  revision,
}: PanelProps<MapOptions>) {
  const { t, language } = useI18n();
  const [mode, setMode] = useState<Mode>("map");
  const [selected, setSelected] = useState<string | null>(null);
  const info = useMapInfo();
  const [tilesFailed, setTilesFailed] = useState(false);
  const data = mapData({ frames, documents, graphs: graphs?.map((g) => g.graph) }, options);
  const number = new Intl.NumberFormat(language);

  if (data.total === 0) {
    return <EmptyPanel reason="noData" />;
  }
  if (data.points.length === 0) {
    return (
      <div className="panel-empty map-nothing">
        <div>
          <p className="map-nothing__title">{t("map.nothing.title")}</p>
          <p>
            {t(data.kind === "graph" ? "map.nothing.nodes" : "map.nothing.rows", {
              total: number.format(data.total),
            })}
          </p>
        </div>
      </div>
    );
  }

  // The server says when its source failed lately: the map then draws outlines at once.
  const tilesDown = info.tiles && (!info.available || tilesFailed);
  const tilesOn = info.tiles && !tilesDown;
  const selectedPoint = data.points.find((p) => p.id === selected);
  const placed = data.total - data.missing.length;
  const counts =
    data.kind === "graph"
      ? t("map.status.nodes", {
          shown: number.format(placed),
          total: number.format(data.total),
          edges: countText(t, language, "edge", data.edges.length),
        })
      : t("map.status.rows", { shown: number.format(placed), total: number.format(data.total) });
  const notes = [
    data.missing.length > 0
      ? t("map.status.missing", { count: number.format(data.missing.length) })
      : null,
    placed > data.points.length ? t("map.status.cut", { max: number.format(MAX_POINTS) }) : null,
    selectedPoint === undefined ? null : t("map.status.selection", { name: selectedPoint.name }),
    t(tilesOn ? "map.status.tiles" : "map.status.noTiles"),
  ].filter((note) => note !== null);

  return (
    <div className="map-panel">
      <div className="map-panel__head">
        <p className="map-panel__status" role="status">
          {counts} <span className="map-panel__notes">{notes.join(" · ")}</span>
        </p>
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would add a frame and legend to two buttons */}
        <div className="graph__segmented" role="group" aria-label={t("map.view.label")}>
          {(["map", "table"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className="graph__segment"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {t(value === "map" ? "map.view.map" : "map.view.table")}
            </button>
          ))}
        </div>
      </div>
      {mode === "map" ? (
        <MapCanvas
          // A new result or another way to fit starts from the fitted view again.
          key={`${options.fit}:${revision ?? ""}`}
          data={data}
          options={options}
          title={title}
          info={info}
          tilesOn={tilesOn}
          tilesFailed={tilesDown}
          onTilesFailed={() => setTilesFailed(true)}
          selected={selected}
          onSelect={setSelected}
        />
      ) : (
        <MapTable data={data} selected={selected} onSelect={setSelected} />
      )}
      <MapLegend data={data} />
    </div>
  );
}

function MapLegend({ data }: { data: MapData }) {
  const { t, language } = useI18n();
  const number = new Intl.NumberFormat(language);
  // Rows of one frame or set have nothing to tell apart.
  if (data.kind !== "graph" && data.legend.length < 2) {
    return null;
  }
  return (
    <ul className="map-legend" aria-label={t("map.legend")}>
      {data.legend.map(({ label, tone, count }) => (
        <li key={label} className="map-legend__item">
          <span
            className={`map-legend__swatch ${tone === null ? "" : `series-${tone}`}`}
            aria-hidden="true"
          />
          <span>
            {data.kind === "graph"
              ? label === ""
                ? t("map.legend.unlabelled")
                : label
              : t("map.legend.query", { number: number.format(Number(label) + 1) })}
          </span>
          <span className="map-legend__count">{number.format(count)}</span>
        </li>
      ))}
    </ul>
  );
}

/** The same places as a table: the equal alternative to the drawing, with the places that are missing. */
function MapTable({
  data,
  selected,
  onSelect,
}: {
  data: MapData;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { t, language } = useI18n();
  const degrees = new Intl.NumberFormat(language, { maximumFractionDigits: 5 });
  const graph = data.kind === "graph";
  return (
    <div className="map-table">
      <table className="map-table__table">
        <thead>
          <tr>
            <th scope="col">{t("map.table.name")}</th>
            {graph ? <th scope="col">{t("map.table.label")}</th> : null}
            <th scope="col" className="map-table__number">
              {t("map.table.latitude")}
            </th>
            <th scope="col" className="map-table__number">
              {t("map.table.longitude")}
            </th>
          </tr>
        </thead>
        <tbody>
          {data.points.map((point) => (
            <tr key={point.id} aria-selected={point.id === selected ? true : undefined}>
              <th scope="row">
                <button
                  type="button"
                  className="map-table__name"
                  aria-pressed={point.id === selected}
                  onClick={() => onSelect(point.id === selected ? null : point.id)}
                >
                  {point.name}
                </button>
              </th>
              {graph ? <td>{point.label}</td> : null}
              <td className="map-table__number">{degrees.format(point.lat)}</td>
              <td className="map-table__number">{degrees.format(point.lon)}</td>
            </tr>
          ))}
          {data.missing.map((entry) => (
            <tr key={entry.id}>
              <th scope="row">{entry.name}</th>
              {graph ? <td>{entry.label}</td> : null}
              <td className="map-table__none" colSpan={2}>
                {t("map.table.noPlace")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function useOutlines(wanted: boolean, regions: boolean) {
  const [world, setWorld] = useState<OutlinePaths | null>(null);
  const [regionPaths, setRegionPaths] = useState<OutlinePaths | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let current = true;
    loadOutlines("world").then(
      (paths) => {
        if (current) setWorld(paths);
      },
      // Without outlines the graticule still carries the points.
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [wanted]);
  useEffect(() => {
    if (!wanted || !regions) return;
    let current = true;
    loadOutlines("regions").then(
      (paths) => {
        if (current) setRegionPaths(paths);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [wanted, regions]);
  return { world: wanted ? world : null, regions: wanted && regions ? regionPaths : null };
}

/** Degrees between two lines of the graticule at a zoom. */
function graticuleStep(zoom: number): number {
  if (zoom < 2) return 30;
  if (zoom < 4) return 10;
  if (zoom < 6) return 5;
  if (zoom < 8) return 1;
  return 0.5;
}

function Graticule({ view, size }: { view: View; size: Size }) {
  const step = graticuleStep(view.zoom);
  const topLeft = unproject(toWorld({ x: 0, y: 0 }, view, size));
  const bottomRight = unproject(toWorld({ x: size.width, y: size.height }, view, size));
  const lines: { key: string; x1: number; y1: number; x2: number; y2: number }[] = [];
  const from = (value: number) => Math.ceil(value / step) * step;
  for (
    let lon = from(Math.max(-180, topLeft.lon));
    lon <= Math.min(180, bottomRight.lon);
    lon += step
  ) {
    const x = toScreen({ x: (lon + 180) / 360, y: 0 }, view, size).x;
    lines.push({ key: `v${lon}`, x1: x, y1: 0, x2: x, y2: size.height });
  }
  for (
    let lat = from(Math.max(-80, bottomRight.lat));
    lat <= Math.min(80, topLeft.lat);
    lat += step
  ) {
    const sin = Math.sin((lat * Math.PI) / 180);
    const y = toScreen(
      { x: 0, y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI) },
      view,
      size,
    ).y;
    lines.push({ key: `h${lat}`, x1: 0, y1: y, x2: size.width, y2: y });
  }
  return (
    <g className="map__graticule">
      {lines.map(({ key, ...line }) => (
        <line key={key} {...line} />
      ))}
    </g>
  );
}

function scaleText(metres: number, language: string): string {
  const [value, unit] = metres >= 1000 ? [metres / 1000, "kilometer"] : [metres, "meter"];
  return new Intl.NumberFormat(language, { style: "unit", unit, unitDisplay: "short" }).format(
    value,
  );
}

function MapCanvas({
  data,
  options,
  title,
  info,
  tilesOn,
  tilesFailed,
  onTilesFailed,
  selected,
  onSelect,
}: {
  data: MapData;
  options: MapOptions;
  title: string;
  info: MapInfo;
  tilesOn: boolean;
  tilesFailed: boolean;
  onTilesFailed: () => void;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const { t, language } = useI18n();
  const endpoints = useContext(MapEndpointsContext);
  const boxRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(boxRef);
  const [moved, setMoved] = useState<View | null>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const number = new Intl.NumberFormat(language);
  // With map images the map stops where the source's pictures stop; two levels of enlarging
  // them are still readable.
  const maxZoom = tilesOn ? Math.min(MAX_ZOOM + 6, info.maxZoom + 2) : MAX_ZOOM;
  const fitted =
    options.fit === "world"
      ? worldView(size)
      : fitView(
          data.points.map((p) => p.world),
          size,
        );
  const view = moved ?? { ...fitted, zoom: Math.min(fitted.zoom, maxZoom) };
  const setView = (next: View) => setMoved(next);

  const showOutlines = !tilesOn && options.outlines !== "none";
  const outlines = useOutlines(
    showOutlines,
    options.outlines === "regions" && view.zoom >= REGIONS_FROM_ZOOM,
  );

  // The wheel zooms around the pointer. Registered by hand: React's wheel listener is passive
  // and could not keep the page from scrolling along.
  const wheel = useRef<(event: WheelEvent) => void>(() => undefined);
  useEffect(() => {
    wheel.current = (event) => {
      const box = boxRef.current?.getBoundingClientRect();
      if (box === undefined) return;
      event.preventDefault();
      const anchor = { x: event.clientX - box.left, y: event.clientY - box.top };
      setMoved(zoomAt(view, size, anchor, -event.deltaY / 240, maxZoom));
    };
  });
  useEffect(() => {
    const element = boxRef.current;
    if (element === null) return;
    const listener = (event: WheelEvent) => wheel.current(event);
    element.addEventListener("wheel", listener, { passive: false });
    return () => element.removeEventListener("wheel", listener);
  }, []);

  const clusters = clusterPoints(data.points, view, size, options.clusterDistance);
  const lines = clusterEdges(data.edges, clusters);
  const neighbours = new Set<string>();
  if (selected !== null) {
    neighbours.add(selected);
    for (const edge of data.edges) {
      if (edge.from === selected) neighbours.add(edge.to);
      if (edge.to === selected) neighbours.add(edge.from);
    }
  }
  const lit = (cluster: Cluster) =>
    selected === null || cluster.points.some((p) => neighbours.has(p.id));
  const litLine = (line: ClusterEdge) =>
    selected === null || line.edges.some((e) => e.from === selected || e.to === selected);
  const singles = clusters.filter((c) => c.points.length === 1).length;
  const focusable = clusters.length <= FOCUSABLE_MARKS;

  const centre = { x: size.width / 2, y: size.height / 2 };
  const zoom = (delta: number) => setView(zoomAt(view, size, centre, delta, maxZoom));
  const showAll = () => setMoved(null);

  function activate(cluster: Cluster) {
    const [only] = cluster.points;
    if (cluster.points.length === 1 && only !== undefined) {
      onSelect(only.id === selected ? null : only.id);
    } else {
      // A bundle opens by zooming into it.
      setView(zoomAt(view, size, { x: cluster.x, y: cluster.y }, 2, maxZoom));
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const pan: Record<string, [number, number]> = {
      ArrowLeft: [PAN_STEP, 0],
      ArrowRight: [-PAN_STEP, 0],
      ArrowUp: [0, PAN_STEP],
      ArrowDown: [0, -PAN_STEP],
    };
    const step = pan[event.key];
    if (step !== undefined) {
      setView(panBy(view, step[0], step[1], maxZoom));
    } else if (event.key === "+" || event.key === "=") {
      zoom(1);
    } else if (event.key === "-") {
      zoom(-1);
    } else if (event.key === "0") {
      showAll();
    } else if (event.key === "Escape" && selected !== null) {
      onSelect(null);
    } else {
      return;
    }
    event.preventDefault();
  }

  function onPointerDown(event: ReactPointerEvent<SVGSVGElement>) {
    if (event.button !== 0) return;
    drag.current = { x: event.clientX, y: event.clientY, moved: false };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }
  function onPointerMove(event: ReactPointerEvent<SVGSVGElement>) {
    const from = drag.current;
    if (from === null) return;
    const [dx, dy] = [event.clientX - from.x, event.clientY - from.y];
    if (!from.moved && Math.hypot(dx, dy) < 3) return;
    drag.current = { x: event.clientX, y: event.clientY, moved: true };
    // Dragging moves the map, never a node: its place comes from the data.
    setView(panBy(view, dx, dy, maxZoom));
  }
  function onPointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    const from = drag.current;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (from !== null && !from.moved && event.target === event.currentTarget) {
      onSelect(null);
    }
  }

  const scale = worldPixels(view.zoom) / OUTLINE_UNITS;
  const origin = toScreen({ x: 0, y: 0 }, view, size);
  const outlineTransform = `translate(${origin.x} ${origin.y}) scale(${scale})`;
  const tiles = tilesOn ? visibleTiles(view, size, info.maxZoom) : [];
  // Outlines only when no image has loaded and all of the first view's failed, or after
  // `FAILED_TILES` failures in a row.
  const tileErrors = useRef({ loaded: 0, failed: 0, inRow: 0 });
  const tileFailed = () => {
    const count = tileErrors.current;
    count.failed += 1;
    count.inRow += 1;
    if (count.inRow >= FAILED_TILES || (count.loaded === 0 && count.failed >= tiles.length)) {
      onTilesFailed();
    }
  };
  const tileLoaded = () => {
    tileErrors.current.loaded += 1;
    tileErrors.current.inRow = 0;
  };
  const bar = scaleBar(view);
  const missing = data.missing;

  return (
    <div
      ref={boxRef}
      className="map"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the keys that move the map need its focus
      tabIndex={0}
      role="application"
      aria-label={t("map.canvas.label", { title })}
      onKeyDown={onKeyDown}
    >
      {/* biome-ignore lint/a11y/useSemanticElements: an SVG drawing cannot be a fieldset */}
      <svg
        className="map__svg"
        width={size.width}
        height={size.height}
        viewBox={`0 0 ${size.width} ${size.height}`}
        role="group"
        aria-label={t("map.canvas.drawing", {
          title,
          count: number.format(data.points.length),
        })}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        {tiles.length > 0 ? (
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
                onLoad={tileLoaded}
                onError={tileFailed}
              />
            ))}
            {/* The pictures lie pale under the data: nodes and edges stay in front. */}
            <rect
              className="map__veil"
              width={size.width}
              height={size.height}
              fillOpacity={VEIL}
            />
          </g>
        ) : (
          <>
            {outlines.world === null ? null : (
              <g transform={outlineTransform} data-testid="map-outlines">
                <path className="map__land" d={outlines.world.land} />
                <path className="map__lake" d={outlines.world.lake} />
                {outlines.regions === null ? null : (
                  <path className="map__region" d={outlines.regions.region} />
                )}
                <path className="map__country" d={outlines.world.country} />
              </g>
            )}
            <Graticule view={view} size={size} />
          </>
        )}
        <g className="map__edges">
          {lines.map((line) => {
            const first = line.edges[0];
            return (
              <line
                key={line.id}
                className={`map__edge${litLine(line) ? "" : " map__edge--dimmed"}${
                  line.edges.every((e) => e.dashed) ? " map__edge--dashed" : ""
                }`}
                x1={line.from.x}
                y1={line.from.y}
                x2={line.to.x}
                y2={line.to.y}
                strokeWidth={bundledWidth(first?.width ?? 1, line.edges.length)}
              />
            );
          })}
        </g>
        <g className="map__points">
          {clusters.map((cluster) => {
            const [first] = cluster.points;
            if (first === undefined) return null;
            const count = cluster.points.length;
            const single = count === 1;
            const name = single
              ? first.name
              : t("map.cluster.label", { count: number.format(count) });
            const tones = new Set(cluster.points.map((p) => p.tone));
            const tone = tones.size === 1 ? first.tone : null;
            const isSelected = single && first.id === selected;
            return (
              // biome-ignore lint/a11y/useSemanticElements: an SVG mark cannot be a button element
              <g
                key={cluster.id}
                className={[
                  "map__mark",
                  tone === null ? "" : `series-${tone}`,
                  single ? "" : "map__mark--bundle",
                  lit(cluster) ? "" : "map__mark--dimmed",
                  isSelected ? "map__mark--selected" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                transform={`translate(${cluster.x} ${cluster.y})`}
                role="button"
                tabIndex={focusable ? 0 : -1}
                aria-label={name}
                aria-pressed={single ? isSelected : undefined}
                onPointerDown={(event) => event.stopPropagation()}
                onClick={() => activate(cluster)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    event.stopPropagation();
                    activate(cluster);
                  }
                }}
              >
                <title>{name}</title>
                {isSelected ? <circle className="map__halo" r={first.radius + 5} /> : null}
                <circle className="map__dot" r={single ? first.radius : clusterRadius(count)} />
                {single ? null : (
                  <text className="map__count" dy="0.35em">
                    {number.format(count)}
                  </text>
                )}
                {single && (isSelected || singles <= NAMED_POINTS) ? (
                  <text className="map__name" x={first.radius + 4} dy="0.35em">
                    {first.name}
                  </text>
                ) : null}
              </g>
            );
          })}
        </g>
      </svg>
      <div className="map__tools">
        <button
          type="button"
          className="button button--ghost button--small"
          aria-label={t("map.tools.zoomIn")}
          title={t("map.tools.zoomIn")}
          onClick={() => zoom(1)}
        >
          <Icon name="plus" />
        </button>
        <button
          type="button"
          className="button button--ghost button--small"
          aria-label={t("map.tools.zoomOut")}
          title={t("map.tools.zoomOut")}
          onClick={() => zoom(-1)}
        >
          <Icon name="minus" />
        </button>
        <button
          type="button"
          className="button button--ghost button--small"
          aria-label={t("map.tools.fit")}
          title={t("map.tools.fit")}
          onClick={showAll}
        >
          <Icon name="expand" />
        </button>
      </div>
      <div className="map__scale" aria-hidden="true">
        <span className="map__scale-bar" ref={barWidth(bar.pixels)} />
        {scaleText(bar.metres, language)}
      </div>
      <div className="map__corner">
        {missing.length === 0 ? null : (
          <p
            className="map__missing"
            title={
              missing.length > MISSING_SHOWN ? missing.map((m) => m.name).join(", ") : undefined
            }
          >
            <span className="map__missing-label">{t("map.missing.label")}</span>{" "}
            {missing.length > MISSING_SHOWN
              ? number.format(missing.length)
              : missing.map((m) => m.name).join(", ")}
          </p>
        )}
        {tilesOn ? (
          <Attribution text={info.attribution} />
        ) : showOutlines ? (
          <Attribution text={t("map.outlines.note")} />
        ) : null}
      </div>
      {tilesFailed ? (
        <p className="map__notice" role="status">
          <Icon name="alert" />
          <span>
            <b>{t("map.tiles.failedTitle")}</b> {t("map.tiles.failedText")}
          </span>
        </p>
      ) : null}
    </div>
  );
}

/**
 * The attribution in the corner. Narrow panels (frame 16) show only a copyright sign that carries
 * the whole text as its title, so the drawing keeps its room; screen readers always get the text.
 */
function Attribution({ text }: { text: string }) {
  return (
    <p className="map__attribution" title={text}>
      <span className="map__attribution-text">{text}</span>
      <span className="map__attribution-short" aria-hidden="true">
        ©
      </span>
    </p>
  );
}

/** Sets the scale bar's length, a number from the data, as a custom property (styleVars). */
function barWidth(pixels: number) {
  return (element: HTMLSpanElement | null) => {
    element?.style.setProperty("--map-scale", `${Math.round(pixels)}px`);
  };
}
