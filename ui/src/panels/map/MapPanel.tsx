import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { isComposingKey } from "../../lib/ime";
import { matchesShortcut, shortcutProps } from "../../shortcuts/registry";
import {
  DEFAULT_THRESHOLDS,
  displayText,
  displayValue,
  EMPTY_FIELD_CONFIG,
  type FieldConfig,
} from "../fieldConfig/fieldConfig";
import { HEAT_STEPS } from "../heatmap/index";
import { usePanelHost } from "../host";
import { Readout, type ReadoutItem, type ReadoutRow } from "../readout";
import { EmptyPanel } from "../shared";
import type { PanelProps } from "../types";
import { useElementSize } from "../useElementSize";
import { type Cluster, clusterEdges, clusterPoints, clusterRadius } from "./cluster";
import { type CountryIndex, countryName, loadCountries } from "./countries";
import { toneClass } from "./graphStyle";
import type { MapLayer, MapOptions } from "./options";
import { loadOutlines, OUTLINE_UNITS, type OutlinePaths } from "./outlines";
import {
  type LayerData,
  MAX_POINTS,
  type MapArea,
  type MissingRow,
  mapLayers,
  needsCountries,
  placeCandidates,
} from "./points";
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
  type World,
  worldPixels,
  worldView,
  zoomAt,
} from "./projection";
import "./map.css";

/** Region borders join the outlines from this zoom on; below, they would be a grey mass. */
const REGIONS_FROM_ZOOM = 3;
/** Up to this many single points get their name written next to them. */
const NAMED_POINTS = 24;
/** Rows listed in the "without a place" list; more are a count. */
const MISSING_LISTED = 100;
/** Places named in a bundle's tooltip, the largest first (board frame 5). */
const BUNDLE_NAMED = 3;
const EMPTY_INDEX: CountryIndex = { countries: [], byCode: new Map() };

type Mode = "map" | "table";

/**
 * The map panel (board XYMapTrend.dc.html, frames 3 to 5 and 8): up to four layers over the
 * outlines that ship with Kalzit. Points come from coordinates, a point value, a geohash or a
 * country code; areas fill countries by their code. No request leaves this server: there are no
 * map images in this version, only the bundled outlines and a graticule. Every row without a
 * place is counted with its reason, and the table view is the equal way to read the same places.
 */
export function MapPanel({
  frames,
  documents,
  graphs,
  options,
  title,
  revision,
  fieldConfig = EMPTY_FIELD_CONFIG,
}: PanelProps<MapOptions>) {
  const { t, language } = useI18n();
  const [mode, setMode] = useState<Mode>("map");
  const input = { frames, documents, graphs: graphs?.map((g) => g.graph) };
  const countries = useCountries(needsCountries(options.layers, input));
  const layers = mapLayers(
    input,
    options.layers,
    fieldConfig,
    countries === "failed" ? EMPTY_INDEX : countries,
    options.edges,
  );
  const number = new Intl.NumberFormat(language);
  const total = layers.reduce((sum, l) => sum + l.total, 0);
  const placed = layers.reduce((sum, l) => sum + l.points.length + l.areas.length, 0);
  const waiting = layers.some((l) => l.waiting);

  if (total === 0 && !waiting) {
    return <EmptyPanel reason="noData" />;
  }
  if (placed === 0 && !waiting) {
    return (
      <NothingHint
        options={options}
        frames={frames}
        countries={countries === "failed" ? null : countries}
        total={total}
        graph={layers.some((l) => l.kind === "graph")}
      />
    );
  }

  const missing = layers.flatMap((l) => l.missing);
  const counts = layers.map((l) => layerStatus(t, number, l)).join(" · ");
  const notes = [
    missing.length > 0
      ? t("map.status.missing", { count: number.format(missingRows(layers)) })
      : null,
    layers.some((l) => l.points.length >= MAX_POINTS)
      ? t("map.status.cut", { max: number.format(MAX_POINTS) })
      : null,
    countries === "failed" ? t("map.status.countriesFailed") : null,
    t("map.status.noTiles"),
  ].filter((note) => note !== null);

  return (
    <div className="map-panel">
      <div className="map-panel__head">
        <p className="map-panel__status" role="status">
          {counts} <span className="map-panel__notes">{notes.join(" · ")}</span>
        </p>
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would add a frame and legend to two buttons */}
        <div className="map-panel__switch" role="group" aria-label={t("map.view.label")}>
          {(["map", "table"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className="map-panel__segment"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {t(value === "map" ? "map.view.map" : "map.view.table")}
            </button>
          ))}
        </div>
      </div>
      <CodeHints layers={layers} options={options} />
      <div
        className={
          options.legend.placement === "right"
            ? "map-panel__body map-panel__body--right"
            : "map-panel__body"
        }
      >
      {mode === "map" ? (
        <MapCanvas
          // A new result or another way to fit starts from the fitted view again.
          key={`${options.fit}:${revision ?? ""}`}
          layers={layers}
          options={options}
          fieldConfig={fieldConfig}
          title={title}
        />
      ) : (
        <MapTable layers={layers} fieldConfig={fieldConfig} />
      )}
      {options.legend.mode === "hidden" ? null : (
        <MapLegend layers={layers} fieldConfig={fieldConfig} />
      )}
      </div>
    </div>
  );
}

type Translate = ReturnType<typeof useI18n>["t"];

/** Rows without a place, each once even when several layers read it. */
function missingRows(layers: readonly LayerData[]): number {
  return new Set(layers.flatMap((l) => l.missing.map((m) => m.id))).size;
}

function layerStatus(t: Translate, number: Intl.NumberFormat, layer: LayerData): string {
  if (layer.waiting) {
    return t("map.status.loading");
  }
  if (layer.layer.kind === "areas") {
    return t("map.status.areas", {
      shown: number.format(layer.areas.length),
      total: number.format(layer.areas.length + layer.unknownCodes.length),
    });
  }
  const shown = layer.total - layer.missing.length;
  return t(layer.kind === "graph" ? "map.status.nodes" : "map.status.rows", {
    shown: number.format(shown),
    total: number.format(layer.total),
  });
}

/** The country areas while a layer looks codes up: loading (null), loaded, or failed. */
function useCountries(wanted: boolean): CountryIndex | null | "failed" {
  const [index, setIndex] = useState<CountryIndex | null | "failed">(null);
  useEffect(() => {
    if (!wanted) return;
    let current = true;
    loadCountries().then(
      (loaded) => {
        if (current) setIndex(loaded);
      },
      () => {
        if (current) setIndex("failed");
      },
    );
    return () => {
      current = false;
    };
  }, [wanted]);
  return wanted ? index : EMPTY_INDEX;
}

/** A value of a layer as the field options format it (unit, decimals). */
function formatValue(value: number | null, config: FieldConfig, language: string): string {
  return value === null
    ? ""
    : displayText(displayValue(value, "number", config.defaults, language));
}

/**
 * What the panel shows when no row has a place (board frame 8, "Nichts für die Karte"): the
 * sentence, and in the panel editor one button per way the data offers to place them.
 */
function NothingHint({
  options,
  frames,
  countries,
  total,
  graph,
}: {
  options: MapOptions;
  frames: PanelProps<MapOptions>["frames"];
  countries: CountryIndex | null;
  total: number;
  graph: boolean;
}) {
  const { t, language } = useI18n();
  const host = usePanelHost();
  const number = new Intl.NumberFormat(language);
  const found = placeCandidates(frames, countries);
  const first = options.layers[0];
  const setFirst = (patch: Partial<MapLayer>) => {
    if (first === undefined) return;
    host.editOptions?.({
      ...options,
      layers: [{ ...first, ...patch }, ...options.layers.slice(1)],
    });
  };
  const actions: { label: string; run: () => void }[] = [];
  if (found.coords !== null) {
    const { lat, lon } = found.coords;
    actions.push({
      label: t("map.fix.coords", { lat, lon }),
      run: () => setFirst({ place: "coords", latField: lat, lonField: lon, pointField: "" }),
    });
  }
  if (found.geohash !== null) {
    const field = found.geohash;
    actions.push({
      label: t("map.fix.geohash", { field }),
      run: () => setFirst({ kind: "points", place: "geohash", geohashField: field }),
    });
  }
  if (found.code !== null) {
    const field = found.code;
    actions.push({
      label: t("map.fix.code", { field }),
      run: () => setFirst({ place: "lookup", keyField: field }),
    });
  }
  return (
    <div className="panel-empty map-hint" role="note">
      <div>
        <p className="map-hint__title">{t("map.nothing.title")}</p>
        <p>
          {t(graph ? "map.nothing.nodes" : "map.nothing.rows", { total: number.format(total) })}
        </p>
        {host.editOptions !== undefined && actions.length > 0 ? (
          <div className="map-hint__actions">
            {actions.map((action, i) => (
              <button
                key={action.label}
                type="button"
                className={
                  i === 0
                    ? "button button--secondary button--small"
                    : "button button--ghost button--small"
                }
                onClick={action.run}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : host.editQuery === undefined ? (
          <p className="map-hint__more">{t("map.nothing.editor")}</p>
        ) : (
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={host.editQuery}
          >
            {t("map.nothing.choose")}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Codes no country has (board frame 5, "Nachschlagen"): named with the country they probably
 * mean; in the panel editor a click adds the pair to the layer, where it shows and can go again.
 */
function CodeHints({ layers, options }: { layers: readonly LayerData[]; options: MapOptions }) {
  const { t, language } = useI18n();
  const host = usePanelHost();
  const number = new Intl.NumberFormat(language);
  const unknown = layers.flatMap((l) => l.unknownCodes.map((code) => ({ layer: l, code })));
  if (unknown.length === 0) {
    return null;
  }
  const suggested = unknown.filter((u) => u.code.suggestion !== null);
  const addAll = () => {
    host.editOptions?.({
      ...options,
      layers: options.layers.map((layer, index) => {
        const pairs = suggested.filter((u) => u.layer.index === index);
        if (pairs.length === 0) return layer;
        const aliases = { ...layer.aliases };
        for (const { code } of pairs) {
          if (code.suggestion !== null) aliases[code.key] = code.suggestion.alpha2;
        }
        return { ...layer, aliases };
      }),
    });
  };
  const shown = unknown.slice(0, 3);
  return (
    <div className="map-hint map-hint--compact" role="note">
      <p className="map-hint__title">
        {t("map.codes.title", { count: number.format(unknown.length) })}
      </p>
      <ul className="map-hint__list">
        {shown.map(({ layer, code }) => (
          <li key={`${layer.index}:${code.key}`}>
            {code.suggestion === null
              ? t("map.codes.unknown", { key: code.key })
              : t("map.codes.suggest", {
                  key: code.key,
                  code: code.suggestion.alpha2,
                  name: countryName(code.suggestion.alpha2, language),
                })}
          </li>
        ))}
        {unknown.length > shown.length ? (
          <li>{t("map.codes.more", { count: number.format(unknown.length - shown.length) })}</li>
        ) : null}
      </ul>
      {host.editOptions !== undefined && suggested.length > 0 ? (
        <div className="map-hint__actions">
          <button type="button" className="button button--secondary button--small" onClick={addAll}>
            {suggested.length === 1 && suggested[0]?.code.suggestion
              ? t("map.codes.addOne", {
                  key: suggested[0].code.key,
                  code: suggested[0].code.suggestion.alpha2,
                })
              : t("map.codes.addAll", { count: number.format(suggested.length) })}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function legendName(t: Translate, layer: LayerData): string {
  const kind = t(layer.layer.kind === "areas" ? "map.layer.areas" : "map.layer.points");
  return layer.valueName === ""
    ? kind
    : t(layer.layer.kind === "areas" ? "map.legend.areasBy" : "map.legend.pointsBy", {
        layer: kind,
        field: layer.valueName,
      });
}

/** One entry per layer: its colour, its scale from smallest to largest, or its threshold steps. */
function MapLegend({
  layers,
  fieldConfig,
}: {
  layers: readonly LayerData[];
  fieldConfig: FieldConfig;
}) {
  const { t, language } = useI18n();
  const number = new Intl.NumberFormat(language);
  const entries = layers.flatMap((layer) => {
    if (layer.kind === "graph") {
      return layer.labels.map(({ label, tone, count }) => (
        <li key={`${layer.index}:${label}`} className="map-legend__item">
          <span className={`map-legend__swatch ${toneClass(tone)}`} aria-hidden="true" />
          <span>{label === "" ? t("map.legend.unlabelled") : label}</span>
          <span className="map-legend__count">{number.format(count)}</span>
        </li>
      ));
    }
    const name = legendName(t, layer);
    const { color } = layer.layer;
    if (color === "thresholds") {
      const steps = (fieldConfig.defaults.thresholds ?? DEFAULT_THRESHOLDS).steps;
      return [
        <li key={layer.index} className="map-legend__item">
          <span>{name}</span>
          {steps.map((step, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: steps keep their order
            <span key={i} className="map-legend__step">
              <span
                className={`map-legend__swatch ${toneClass({ tone: step.tone })}`}
                aria-hidden="true"
              />
              {step.value === null
                ? t("map.legend.base")
                : t("map.legend.from", { value: number.format(step.value) })}
            </span>
          ))}
        </li>,
      ];
    }
    if (color === "scale" && layer.range !== null) {
      return [
        <li key={layer.index} className="map-legend__item">
          <span>{name}</span>
          <span className="map-legend__value">
            {formatValue(layer.range.min, fieldConfig, language)}
          </span>
          <span className="map-legend__scale" aria-hidden="true">
            {Array.from({ length: HEAT_STEPS }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: the steps of the scale
              <span key={i} className={`map-legend__swatch heat-${i + 1}`} />
            ))}
          </span>
          <span className="map-legend__value">
            {formatValue(layer.range.max, fieldConfig, language)}
          </span>
        </li>,
      ];
    }
    // One layer in one colour has nothing to tell apart.
    if (layers.length < 2 && layer.valueName === "") {
      return [];
    }
    return [
      <li key={layer.index} className="map-legend__item">
        <span
          className={`map-legend__swatch ${toneClass((layer.index % 8) + 1)}`}
          aria-hidden="true"
        />
        <span>{name}</span>
      </li>,
    ];
  });
  if (entries.length === 0) {
    return null;
  }
  return (
    <ul className="map-legend" aria-label={t("map.legend")}>
      {entries}
    </ul>
  );
}

const REASONS: Record<MissingRow["reason"], Parameters<Translate>[0]> = {
  noPlace: "map.missing.noPlace",
  latRange: "map.missing.latRange",
  lonRange: "map.missing.lonRange",
  geohash: "map.missing.geohash",
  code: "map.missing.code",
};

/** The same places as a table: the equal alternative to the drawing, with the rows that are missing. */
function MapTable({
  layers,
  fieldConfig,
}: {
  layers: readonly LayerData[];
  fieldConfig: FieldConfig;
}) {
  const { t, language } = useI18n();
  const degrees = new Intl.NumberFormat(language, { maximumFractionDigits: 5 });
  const several = layers.length > 1;
  const layerName = (layer: LayerData) =>
    t(layer.layer.kind === "areas" ? "map.layer.areasN" : "map.layer.pointsN", {
      n: String(layer.index + 1),
    });
  return (
    <div className="map-table">
      <table className="map-table__table">
        <thead>
          <tr>
            {several ? <th scope="col">{t("map.table.layer")}</th> : null}
            <th scope="col">{t("map.table.name")}</th>
            <th scope="col" className="map-table__number">
              {t("map.table.latitude")}
            </th>
            <th scope="col" className="map-table__number">
              {t("map.table.longitude")}
            </th>
            <th scope="col" className="map-table__number">
              {t("map.table.value")}
            </th>
          </tr>
        </thead>
        <tbody>
          {layers.flatMap((layer) => [
            ...layer.points.map((point) => (
              <tr key={`${layer.index}:${point.id}`}>
                {several ? <td>{layerName(layer)}</td> : null}
                <th scope="row">{point.name}</th>
                <td className="map-table__number">{degrees.format(point.lat)}</td>
                <td className="map-table__number">{degrees.format(point.lon)}</td>
                <td className="map-table__number">
                  {formatValue(point.value, fieldConfig, language)}
                </td>
              </tr>
            )),
            ...layer.areas.map((area) => (
              <tr key={area.id}>
                {several ? <td>{layerName(layer)}</td> : null}
                <th scope="row">
                  {countryName(area.country.alpha2, language)} ({area.key})
                </th>
                <td className="map-table__number">{degrees.format(area.country.lat)}</td>
                <td className="map-table__number">{degrees.format(area.country.lon)}</td>
                <td className="map-table__number">
                  {formatValue(area.value, fieldConfig, language)}
                </td>
              </tr>
            )),
            ...layer.missing.map((row) => (
              <tr key={`${layer.index}:${row.id}`}>
                {several ? <td>{layerName(layer)}</td> : null}
                <th scope="row">{row.name}</th>
                <td className="map-table__none" colSpan={3}>
                  {t(REASONS[row.reason], { value: row.detail })}
                </td>
              </tr>
            )),
          ])}
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

/** One thing the keyboard and the tooltip read: a point, a bundle or an area, west to east. */
type Mark =
  | { kind: "cluster"; layer: LayerData; cluster: Cluster; x: number }
  | { kind: "area"; layer: LayerData; area: MapArea; x: number };

function MapCanvas({
  layers,
  options,
  fieldConfig,
  title,
}: {
  layers: readonly LayerData[];
  options: MapOptions;
  fieldConfig: FieldConfig;
  title: string;
}) {
  const { t, language } = useI18n();
  const boxRef = useRef<HTMLDivElement>(null);
  const size = useElementSize(boxRef);
  const [moved, setMoved] = useState<View | null>(null);
  const [listOpen, setListOpen] = useState(false);
  const listId = useId();
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const number = new Intl.NumberFormat(language);
  const everything: World[] = layers.flatMap((l) => [
    ...l.points.map((p) => p.world),
    ...l.areas.map((a) => a.country.world),
  ]);
  const fitted = options.fit === "world" ? worldView(size) : fitView(everything, size);
  const view = moved ?? fitted;
  const setView = (next: View) => setMoved(next);

  const showOutlines = options.outlines !== "none";
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
      setMoved(zoomAt(view, size, anchor, -event.deltaY / 240, MAX_ZOOM));
    };
  });
  useEffect(() => {
    const element = boxRef.current;
    if (element === null) return;
    const listener = (event: WheelEvent) => wheel.current(event);
    element.addEventListener("wheel", listener, { passive: false });
    return () => element.removeEventListener("wheel", listener);
  }, []);

  // Front layers are drawn last; the first layer of the list lies on top.
  const back = [...layers].reverse();
  const clustered = back.map((layer) => {
    const clusters = clusterPoints(layer.points, view, size, options.clusterDistance);
    return { layer, clusters, lines: clusterEdges(layer.edges, clusters) };
  });
  const marks: Mark[] = [
    ...clustered.flatMap(({ layer, clusters }) =>
      clusters.map((cluster) => ({ kind: "cluster" as const, layer, cluster, x: cluster.x })),
    ),
    ...layers.flatMap((layer) =>
      layer.areas.map((area) => ({
        kind: "area" as const,
        layer,
        area,
        x: toScreen(area.country.world, view, size).x,
      })),
    ),
  ].sort((a, b) => a.x - b.x);
  const singles = clustered.reduce(
    (n, { clusters }) => n + clusters.filter((c) => c.points.length === 1).length,
    0,
  );
  const value = (v: number | null) => formatValue(v, fieldConfig, language);
  const items: ReadoutItem[] = marks.map((mark) => {
    const valueName = mark.layer.valueName;
    if (mark.kind === "area") {
      return {
        label: `${countryName(mark.area.country.alpha2, language)} (${mark.area.key})`,
        rows:
          mark.area.value === null
            ? []
            : [
                {
                  name: valueName,
                  value: value(mark.area.value),
                  colorClass: toneClass(mark.area.tone),
                },
              ],
      };
    }
    const points = mark.cluster.points;
    const [first] = points;
    if (points.length === 1 && first !== undefined) {
      return {
        label: first.name,
        rows:
          first.value === null
            ? []
            : [{ name: valueName, value: value(first.value), colorClass: toneClass(first.tone) }],
      };
    }
    // A bundle: the sum and its largest places.
    const valued = points.filter((p) => p.value !== null);
    const rows: ReadoutRow[] = [];
    if (valued.length > 0) {
      rows.push({
        name: t("map.cluster.sum", { field: valueName }),
        value: value(valued.reduce((sum, p) => sum + (p.value ?? 0), 0)),
      });
    }
    const largest = [...(valued.length > 0 ? valued : points)]
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
      .slice(0, BUNDLE_NAMED);
    for (const point of largest) {
      rows.push({ name: point.name, value: value(point.value) });
    }
    return { label: t("map.cluster.label", { count: number.format(points.length) }), rows };
  });

  const centre = { x: size.width / 2, y: size.height / 2 };
  const zoom = (delta: number) => setView(zoomAt(view, size, centre, delta, MAX_ZOOM));
  const showAll = () => setMoved(null);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (isComposingKey(event)) return;
    if (matchesShortcut("map.zoomIn", event)) {
      zoom(1);
    } else if (matchesShortcut("map.zoomOut", event)) {
      zoom(-1);
    } else if (matchesShortcut("map.zoomReset", event)) {
      showAll();
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
    setView(panBy(view, dx, dy, MAX_ZOOM));
  }
  function onPointerUp(event: ReactPointerEvent<SVGSVGElement>) {
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  const scale = worldPixels(view.zoom) / OUTLINE_UNITS;
  const origin = toScreen({ x: 0, y: 0 }, view, size);
  const outlineTransform = `translate(${origin.x} ${origin.y}) scale(${scale})`;
  const bar = scaleBar(view);
  const missing = layers.flatMap((l) => l.missing);
  const indexOf = new Map(marks.map((mark, i) => [mark, i]));
  const markOf = new Map<object, Mark>(
    marks.map((mark) => [mark.kind === "area" ? mark.area : mark.cluster, mark]),
  );

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: plus, minus and 0 bubble up from the focused map inside (the Readout)
    <div className="map" onKeyDown={onKeyDown}>
      <Readout
        title={t("map.canvas.label", { title })}
        items={items}
        tooltip={options.tooltip.mode}
        className="map__stage"
      >
        {(active, hover) => {
          const activeMark = active === null ? undefined : marks[active];
          const hoverProps = (mark: Mark) => ({
            onPointerEnter: () => hover(indexOf.get(mark) ?? null),
            onPointerLeave: () => hover(null),
          });
          return (
            <div ref={boxRef} className="map__box">
              <svg
                className="map__svg"
                width={size.width}
                height={size.height}
                viewBox={`0 0 ${size.width} ${size.height}`}
                aria-hidden="true"
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={() => {
                  drag.current = null;
                }}
              >
                {outlines.world === null ? null : (
                  <g transform={outlineTransform} data-testid="map-outlines">
                    <path className="map__land" d={outlines.world.land} />
                    <path className="map__lake" d={outlines.world.lake} />
                  </g>
                )}
                <Graticule view={view} size={size} />
                {back.map((layer) =>
                  layer.areas.length === 0 ? null : (
                    <g
                      key={`areas-${layer.index}`}
                      transform={outlineTransform}
                      className="map__areas"
                      data-testid="map-areas"
                    >
                      {layer.areas.map((area) => {
                        const mark = markOf.get(area);
                        return (
                          <path
                            key={area.id}
                            className={[
                              "map__area",
                              toneClass(area.tone),
                              area.value === null ? "map__area--empty" : "",
                              activeMark?.kind === "area" && activeMark.area === area
                                ? "map__area--active"
                                : "",
                            ]
                              .filter(Boolean)
                              .join(" ")}
                            d={area.country.path}
                            {...(mark === undefined ? {} : hoverProps(mark))}
                          />
                        );
                      })}
                    </g>
                  ),
                )}
                {outlines.world === null ? null : (
                  <g transform={outlineTransform} className="map__borders">
                    {outlines.regions === null ? null : (
                      <path className="map__region" d={outlines.regions.region} />
                    )}
                    <path className="map__country" d={outlines.world.country} />
                  </g>
                )}
                {clustered.map(({ layer, clusters, lines }) => (
                  <g key={`points-${layer.index}`} className="map__layer">
                    <g className="map__edges">
                      {lines.map((line) => (
                        <line
                          key={line.id}
                          className="map__edge"
                          x1={line.from.x}
                          y1={line.from.y}
                          x2={line.to.x}
                          y2={line.to.y}
                          strokeWidth={Math.min(8, 1.25 * (1 + Math.log2(line.edges.length)))}
                        />
                      ))}
                    </g>
                    {clusters.map((cluster) => {
                      const [first] = cluster.points;
                      if (first === undefined) return null;
                      const count = cluster.points.length;
                      const single = count === 1;
                      const tones = new Set(cluster.points.map((p) => toneClass(p.tone)));
                      const tone = tones.size === 1 ? toneClass(first.tone) : "";
                      const mark = markOf.get(cluster);
                      const isActive =
                        activeMark?.kind === "cluster" && activeMark.cluster === cluster;
                      const radius = single ? first.radius : clusterRadius(count);
                      return (
                        // biome-ignore lint/a11y/noStaticElementInteractions: a click on a bundle zooms in, as plus does from the keyboard
                        <g
                          key={cluster.id}
                          className={[
                            "map__mark",
                            tone,
                            single ? "" : "map__mark--bundle",
                            isActive ? "map__mark--active" : "",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          transform={`translate(${cluster.x} ${cluster.y})`}
                          {...(mark === undefined ? {} : hoverProps(mark))}
                          onPointerDown={(event) => {
                            if (!single) event.stopPropagation();
                          }}
                          onClick={() => {
                            // A bundle opens by zooming into it.
                            if (!single) {
                              setView(
                                zoomAt(view, size, { x: cluster.x, y: cluster.y }, 2, MAX_ZOOM),
                              );
                            }
                          }}
                        >
                          {isActive ? <circle className="map__ring" r={radius + 4} /> : null}
                          <circle className="map__dot" r={radius} />
                          {single ? null : (
                            <text className="map__count" dy="0.35em">
                              {number.format(count)}
                            </text>
                          )}
                          {single && (isActive || singles <= NAMED_POINTS) ? (
                            <text className="map__name" x={radius + 4} dy="0.35em">
                              {first.name}
                            </text>
                          ) : null}
                        </g>
                      );
                    })}
                  </g>
                ))}
              </svg>
            </div>
          );
        }}
      </Readout>
      <div className="map__tools">
        <button
          type="button"
          className="button button--ghost button--small"
          aria-label={t("map.tools.zoomIn")}
          title={t("map.tools.zoomIn")}
          {...shortcutProps("map.zoomIn")}
          onClick={() => zoom(1)}
        >
          <Icon name="plus" />
        </button>
        <button
          type="button"
          className="button button--ghost button--small"
          aria-label={t("map.tools.zoomOut")}
          title={t("map.tools.zoomOut")}
          {...shortcutProps("map.zoomOut")}
          onClick={() => zoom(-1)}
        >
          <Icon name="minus" />
        </button>
        <button
          type="button"
          className="button button--ghost button--small"
          aria-label={t("map.tools.fit")}
          title={t("map.tools.fit")}
          {...shortcutProps("map.zoomReset")}
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
          <button
            type="button"
            className="map__missing"
            aria-expanded={listOpen}
            aria-controls={listId}
            onClick={() => setListOpen((open) => !open)}
          >
            {t("map.missing.strip", { count: number.format(missingRows(layers)) })}
          </button>
        )}
        {showOutlines ? <Attribution text={t("map.outlines.note")} /> : null}
      </div>
      {listOpen && missing.length > 0 ? (
        <section
          id={listId}
          className="map__missing-list"
          aria-label={t("map.missing.title", { count: number.format(missingRows(layers)) })}
        >
          <div className="map__missing-head">
            <p className="map__missing-title">
              {t("map.missing.title", { count: number.format(missingRows(layers)) })}
            </p>
            <button
              type="button"
              className="button button--ghost button--small"
              aria-label={t("map.missing.close")}
              title={t("map.missing.close")}
              onClick={() => setListOpen(false)}
            >
              <Icon name="close" />
            </button>
          </div>
          <ul>
            {missing.slice(0, MISSING_LISTED).map((row) => (
              <li key={`${row.id}:${row.reason}`}>
                <span className="map__missing-name">{row.name}</span>{" "}
                <span className="map__missing-reason">
                  {t(REASONS[row.reason], { value: row.detail })}
                </span>
              </li>
            ))}
          </ul>
          {missing.length > MISSING_LISTED ? (
            <p className="map__missing-more">
              {t("map.missing.more", { count: number.format(missing.length - MISSING_LISTED) })}
            </p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/**
 * The attribution in the corner. Narrow panels show only a copyright sign that carries the whole
 * text as its title, so the drawing keeps its room; screen readers always get the text.
 */
function Attribution({ text }: { text: string }) {
  return (
    <p className="map__attribution" title={text}>
      <span className="map__attribution-text">{text}</span>
      <span className="map__attribution-short" aria-hidden="true">
        {"©"}
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
