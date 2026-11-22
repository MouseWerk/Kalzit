import { lazy, Suspense } from "react";
import { loadArea, useI18n } from "../../i18n/i18n";
import { NumberField, SelectField, TextField } from "../shared";
import type { PanelEditorProps } from "../types";
import {
  CLUSTER_DISTANCE,
  type CoordMode,
  type EdgeMode,
  type FitMode,
  MAX_FIELD_CHARS,
  type MapOptions,
  type OutlineMode,
} from "./options";
import "./map.css";

/** The editor of style rules, loaded with the graph panels' rule code when the options open. */
const LazyStyleSection = lazy(() =>
  loadArea("graphStyle")
    .then(() => import("../graph/style/StyleSection"))
    .then((module) => ({ default: module.StyleSection })),
);

/**
 * The options of the map panel (board Graph081.dc.html, frame 15): where coordinates come from,
 * the outlines, the section shown, edges and bundling, and the style rules of graph data.
 */
export function MapEditor({ options, onChange }: PanelEditorProps<MapOptions>) {
  const { t } = useI18n();
  const set = (patch: Partial<MapOptions>) => onChange({ ...options, ...patch });
  return (
    <div className="map-editor">
      <SelectField<CoordMode>
        label={t("map.editor.coords")}
        value={options.coords}
        choices={[
          ["auto", t("map.editor.coords.auto")],
          ["point", t("map.editor.coords.point")],
          ["latLon", t("map.editor.coords.latLon")],
        ]}
        onChange={(coords) => set({ coords })}
        hint={t("map.editor.coordsHint")}
      />
      {options.coords === "latLon" ? null : (
        <TextField
          label={t("map.editor.pointField")}
          value={options.pointField}
          onChange={(pointField) => set({ pointField })}
          maxLength={MAX_FIELD_CHARS}
          hint={t("map.editor.pointFieldHint")}
          mono
        />
      )}
      {options.coords === "point" ? null : (
        <>
          <TextField
            label={t("map.editor.latField")}
            value={options.latField}
            onChange={(latField) => set({ latField })}
            maxLength={MAX_FIELD_CHARS}
            hint={t("map.editor.latLonHint")}
            mono
          />
          <TextField
            label={t("map.editor.lonField")}
            value={options.lonField}
            onChange={(lonField) => set({ lonField })}
            maxLength={MAX_FIELD_CHARS}
            mono
          />
        </>
      )}
      <TextField
        label={t("map.editor.caption")}
        value={options.caption}
        onChange={(caption) => set({ caption })}
        maxLength={MAX_FIELD_CHARS}
        hint={t("map.editor.captionHint")}
        mono
      />
      <TextField
        label={t("map.editor.sizeField")}
        value={options.sizeField}
        onChange={(sizeField) => set({ sizeField })}
        maxLength={MAX_FIELD_CHARS}
        hint={t("map.editor.sizeFieldHint")}
        mono
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
      <SelectField<FitMode>
        label={t("map.editor.fit")}
        value={options.fit}
        choices={[
          ["data", t("map.editor.fit.data")],
          ["world", t("map.editor.fit.world")],
        ]}
        onChange={(fit) => set({ fit })}
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
      <section aria-label={t("map.editor.style")}>
        <h4 className="field__label">{t("map.editor.style")}</h4>
        <p className="field__hint">{t("map.editor.styleHint")}</p>
        <Suspense fallback={<p className="field__hint">{t("common.loading")}</p>}>
          <LazyStyleSection rules={options.style} onChange={(style) => set({ style })} />
        </Suspense>
      </section>
    </div>
  );
}
