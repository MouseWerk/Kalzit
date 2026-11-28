import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { LegendTooltipEditor } from "../fieldConfig/LegendTooltipEditor";
import { NumberField, SelectField, TextField } from "../shared";
import type { PanelEditorProps } from "../types";
import {
  CLUSTER_DISTANCE,
  type ColorMode,
  type EdgeMode,
  type FitMode,
  type LayerKind,
  MAX_FIELD_CHARS,
  MAX_LAYERS,
  type MapLayer,
  type MapOptions,
  newLayer,
  type OutlineMode,
  type PlaceMode,
  POINT_SIZE,
} from "./options";
import "./map.css";

/** Results a layer can be set to read, besides all of them. */
const RESULT_CHOICES = 4;

/**
 * The options of the map panel (board XYMapTrend.dc.html, frame 3): the layers, top first, each
 * with where its places come from and how it draws them; then the view, the outlines and the
 * legend and tooltip.
 */
export function MapEditor({ options, onChange }: PanelEditorProps<MapOptions>) {
  const { t } = useI18n();
  const set = (patch: Partial<MapOptions>) => onChange({ ...options, ...patch });
  const setLayer = (index: number, layer: MapLayer) =>
    set({ layers: options.layers.map((l, i) => (i === index ? layer : l)) });
  const move = (index: number, by: number) => {
    const layers = [...options.layers];
    const [layer] = layers.splice(index, 1);
    if (layer === undefined) return;
    layers.splice(index + by, 0, layer);
    set({ layers });
  };
  const add = (kind: LayerKind) => set({ layers: [newLayer(kind), ...options.layers] });
  const full = options.layers.length >= MAX_LAYERS;
  return (
    <div className="map-editor">
      <section className="map-editor__layers" aria-label={t("map.editor.layers")}>
        <h4 className="field__label">{t("map.editor.layers")}</h4>
        <p className="field__hint">{t("map.editor.layersHint")}</p>
        {options.layers.map((layer, index) => (
          <LayerEditor
            // biome-ignore lint/suspicious/noArrayIndexKey: layers have no id; their place is who they are
            key={index}
            layer={layer}
            index={index}
            count={options.layers.length}
            onChange={(next) => setLayer(index, next)}
            onMove={(by) => move(index, by)}
            onRemove={() => set({ layers: options.layers.filter((_, i) => i !== index) })}
          />
        ))}
        <div className="map-editor__add">
          <button
            type="button"
            className="button button--secondary button--small"
            disabled={full}
            onClick={() => add("points")}
          >
            <Icon name="plus" />
            {t("map.editor.addPoints")}
          </button>
          <button
            type="button"
            className="button button--secondary button--small"
            disabled={full}
            onClick={() => add("areas")}
          >
            <Icon name="plus" />
            {t("map.editor.addAreas")}
          </button>
        </div>
        {full ? <p className="field__hint">{t("map.editor.layersFull")}</p> : null}
      </section>
      <SelectField<FitMode>
        label={t("map.editor.fit")}
        value={options.fit}
        choices={[
          ["data", t("map.editor.fit.data")],
          ["world", t("map.editor.fit.world")],
        ]}
        onChange={(fit) => set({ fit })}
      />
      <SelectField<OutlineMode>
        label={t("map.editor.outlines")}
        value={options.outlines}
        choices={[
          ["regions", t("map.editor.outlines.regions")],
          ["countries", t("map.editor.outlines.countries")],
          ["none", t("map.editor.outlines.none")],
        ]}
        onChange={(outlines) => set({ outlines })}
        hint={t("map.editor.outlinesHint")}
      />
      <p className="field__hint map-editor__images">
        <b>{t("map.editor.images")}</b> {t("map.editor.imagesOff")}
      </p>
      <NumberField
        label={t("map.editor.cluster")}
        value={options.clusterDistance}
        onChange={(value) =>
          set({
            clusterDistance:
              value === undefined
                ? CLUSTER_DISTANCE.default
                : Math.max(CLUSTER_DISTANCE.min, Math.min(CLUSTER_DISTANCE.max, Math.round(value))),
          })
        }
        min={CLUSTER_DISTANCE.min}
        max={CLUSTER_DISTANCE.max}
        step={1}
        hint={t("map.editor.clusterHint")}
      />
      <SelectField<EdgeMode>
        label={t("map.editor.edges")}
        value={options.edges}
        choices={[
          ["straight", t("map.editor.edges.straight")],
          ["none", t("map.editor.edges.none")],
        ]}
        onChange={(edges) => set({ edges })}
        hint={t("map.editor.edgesHint")}
      />
      <LegendTooltipEditor
        legend={options.legend}
        tooltip={options.tooltip}
        withValues={false}
        onChange={(legend, tooltip) => set({ legend, tooltip })}
      />
    </div>
  );
}

function LayerEditor({
  layer,
  index,
  count,
  onChange,
  onMove,
  onRemove,
}: {
  layer: MapLayer;
  index: number;
  count: number;
  onChange: (layer: MapLayer) => void;
  onMove: (by: number) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<MapLayer>) => onChange({ ...layer, ...patch });
  const areas = layer.kind === "areas";
  const place: PlaceMode = areas ? "lookup" : layer.place;
  const name = t(areas ? "map.layer.areasN" : "map.layer.pointsN", { n: String(index + 1) });
  const aliases = Object.entries(layer.aliases);
  return (
    <fieldset className="map-editor__layer">
      <legend className="map-editor__layer-name">{name}</legend>
      <div className="map-editor__layer-tools">
        <button
          type="button"
          className="button button--ghost button--small"
          disabled={index === 0}
          onClick={() => onMove(-1)}
        >
          {t("map.editor.up")}
        </button>
        <button
          type="button"
          className="button button--ghost button--small"
          disabled={index === count - 1}
          onClick={() => onMove(1)}
        >
          {t("map.editor.down")}
        </button>
        <button
          type="button"
          className="button button--ghost button--small"
          disabled={count === 1}
          onClick={onRemove}
        >
          {t("map.editor.remove")}
        </button>
      </div>
      <SelectField<LayerKind>
        label={t("map.editor.kind")}
        value={layer.kind}
        choices={[
          ["points", t("map.layer.points")],
          ["areas", t("map.layer.areas")],
        ]}
        onChange={(kind) =>
          set({
            kind,
            place: kind === "areas" ? "lookup" : layer.place,
            color: kind === "areas" && layer.color === "single" ? "scale" : layer.color,
          })
        }
        hint={t(areas ? "map.editor.kindAreasHint" : "map.editor.kindPointsHint")}
      />
      <SelectField
        label={t("map.editor.result")}
        value={String(layer.result)}
        choices={[
          ["0", t("map.editor.result.all")],
          ...Array.from(
            { length: Math.max(RESULT_CHOICES, layer.result) },
            (_, i) => [String(i + 1), t("map.editor.result.n", { n: String(i + 1) })] as const,
          ),
        ]}
        onChange={(result) => set({ result: Number(result) })}
      />
      {areas ? null : (
        <SelectField<PlaceMode>
          label={t("map.editor.place")}
          value={place}
          choices={[
            ["auto", t("map.editor.place.auto")],
            ["coords", t("map.editor.place.coords")],
            ["geohash", t("map.editor.place.geohash")],
            ["lookup", t("map.editor.place.lookup")],
          ]}
          onChange={(next) => set({ place: next })}
          hint={t("map.editor.placeHint")}
        />
      )}
      {place === "coords" ? (
        <>
          <TextField
            label={t("map.editor.latField")}
            value={layer.latField}
            onChange={(latField) => set({ latField })}
            maxLength={MAX_FIELD_CHARS}
            hint={t("map.editor.latLonHint")}
            mono
          />
          <TextField
            label={t("map.editor.lonField")}
            value={layer.lonField}
            onChange={(lonField) => set({ lonField })}
            maxLength={MAX_FIELD_CHARS}
            mono
          />
          <TextField
            label={t("map.editor.pointField")}
            value={layer.pointField}
            onChange={(pointField) => set({ pointField })}
            maxLength={MAX_FIELD_CHARS}
            hint={t("map.editor.pointFieldHint")}
            mono
          />
        </>
      ) : null}
      {place === "geohash" ? (
        <TextField
          label={t("map.editor.geohashField")}
          value={layer.geohashField}
          onChange={(geohashField) => set({ geohashField })}
          maxLength={MAX_FIELD_CHARS}
          hint={t("map.editor.geohashHint")}
          mono
        />
      ) : null}
      {place === "lookup" ? (
        <TextField
          label={t("map.editor.keyField")}
          value={layer.keyField}
          onChange={(keyField) => set({ keyField })}
          maxLength={MAX_FIELD_CHARS}
          hint={t("map.editor.keyHint")}
          mono
        />
      ) : null}
      <TextField
        label={t(areas ? "map.editor.valueArea" : "map.editor.valuePoint")}
        value={layer.valueField}
        onChange={(valueField) => set({ valueField })}
        maxLength={MAX_FIELD_CHARS}
        hint={t(areas ? "map.editor.valueAreaHint" : "map.editor.valuePointHint")}
        mono
      />
      <SelectField<ColorMode>
        label={t("map.editor.color")}
        value={layer.color}
        choices={[
          ...(areas ? [] : [["single", t("map.editor.color.single")] as const]),
          ["scale", t("map.editor.color.scale")],
          ["thresholds", t("map.editor.color.thresholds")],
        ]}
        onChange={(color) => set({ color })}
        hint={t("map.editor.colorHint")}
      />
      {areas || layer.valueField === "" ? null : (
        <div className="map-editor__pair">
          <NumberField
            label={t("map.editor.sizeFrom")}
            value={layer.sizeFrom}
            onChange={(value) =>
              set({ sizeFrom: clampSize(value, POINT_SIZE.from, layer.sizeTo, true) })
            }
            min={POINT_SIZE.min}
            max={layer.sizeTo}
            step={1}
          />
          <NumberField
            label={t("map.editor.sizeTo")}
            value={layer.sizeTo}
            onChange={(value) =>
              set({ sizeTo: clampSize(value, POINT_SIZE.to, layer.sizeFrom, false) })
            }
            min={layer.sizeFrom}
            max={POINT_SIZE.max}
            step={1}
          />
        </div>
      )}
      {areas ? null : (
        <TextField
          label={t("map.editor.caption")}
          value={layer.caption}
          onChange={(caption) => set({ caption })}
          maxLength={MAX_FIELD_CHARS}
          hint={t("map.editor.captionHint")}
          mono
        />
      )}
      {aliases.length === 0 ? null : (
        <div className="field">
          <p className="field__label">{t("map.editor.aliases")}</p>
          <ul className="map-editor__aliases">
            {aliases.map(([from, code]) => (
              <li key={from}>
                <span className="map-editor__alias">
                  {from} → {code}
                </span>
                <button
                  type="button"
                  className="button button--ghost button--small"
                  aria-label={t("map.editor.aliasRemove", { from, code })}
                  title={t("map.editor.aliasRemove", { from, code })}
                  onClick={() => {
                    const next = { ...layer.aliases };
                    delete next[from];
                    set({ aliases: next });
                  }}
                >
                  <Icon name="close" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </fieldset>
  );
}

/** A point size within the bounds and on the right side of the other end. */
function clampSize(
  value: number | undefined,
  otherwise: number,
  other: number,
  lower: boolean,
): number {
  const size = Math.round(value ?? otherwise);
  const within = Math.max(POINT_SIZE.min, Math.min(POINT_SIZE.max, size));
  return lower ? Math.min(within, other) : Math.max(within, other);
}
