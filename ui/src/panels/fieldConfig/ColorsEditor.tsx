import { useId } from "react";
import { useI18n } from "../../i18n/i18n";
import { SelectField } from "../shared";
import { RAMP_CLASSES, RAMPS } from "../timeseries/styles";
import { ColorField, FreeColorInput } from "./ColorField";
import {
  COLOR_SCHEMES,
  type ColorScheme,
  type ColorValue,
  type FieldConfig,
  type FieldOptions,
  type FieldOverride,
  type HexColor,
  isHexColor,
  type OverrideProperties,
  TONES,
} from "./fieldConfig";
import { LINE_STYLES, type LineStyle } from "./graphStyle";
import { Swatch } from "./Legend";
import { toneLabel } from "./toneLabel";
import "../viz.css";

/** At most this many series get a row of their own; more are styled with overrides. */
export const MAX_SERIES_ROWS = 20;

/** The override that picks exactly this series by name, if there is one. */
function seriesOverride(config: FieldConfig, name: string): FieldOverride | undefined {
  return config.overrides.find((o) => o.matcher.type === "name" && o.matcher.value === name);
}

/**
 * Sets or clears one property of a series' own override: the override is added when the first
 * property is set and removed when its last one is cleared, so styling a series by its row and
 * editing it under Overrides stay one and the same.
 */
export function setSeriesProperty<K extends keyof FieldOptions>(
  config: FieldConfig,
  name: string,
  key: K,
  value: FieldOptions[K] | undefined,
): FieldConfig {
  const existing = seriesOverride(config, name);
  if (existing === undefined) {
    if (value === undefined) {
      return config;
    }
    const added: FieldOverride = {
      matcher: { type: "name", value: name },
      properties: { [key]: value },
    };
    return { ...config, overrides: [...config.overrides, added] };
  }
  const properties: OverrideProperties = { ...existing.properties };
  if (value === undefined) {
    delete properties[key];
  } else {
    properties[key] = value;
  }
  const overrides =
    Object.keys(properties).length === 0
      ? config.overrides.filter((o) => o !== existing)
      : config.overrides.map((o) => (o === existing ? { ...o, properties } : o));
  return { ...config, overrides };
}

const RAMP_OF: Partial<Record<ColorScheme, string>> = RAMPS;

/**
 * The time series' colours after the blueprint: the scheme, the colour of a one-colour scheme,
 * a preview of the palette or ramp, and a row per series with its colour, line style and
 * opacity, which are that series' override.
 */
export function ColorsEditor({
  config,
  seriesNames,
  onChange,
}: {
  config: FieldConfig;
  seriesNames: readonly string[];
  onChange: (config: FieldConfig) => void;
}) {
  const { t } = useI18n();
  const defaults = config.defaults;
  const scheme = defaults.colorScheme ?? "palette";
  const setDefault = <K extends keyof FieldOptions>(key: K, value: FieldOptions[K] | undefined) => {
    const next = { ...defaults };
    if (value === undefined) {
      delete next[key];
    } else {
      next[key] = value;
    }
    onChange({ ...config, defaults: next });
  };
  const ramp = RAMP_OF[scheme];
  const rows = seriesNames.slice(0, MAX_SERIES_ROWS);
  return (
    <div className="colors-editor">
      <SelectField
        label={t("panels.colors.scheme")}
        value={scheme}
        choices={COLOR_SCHEMES.map((s) => [s, t(`panels.colors.scheme.${s}`)] as const)}
        onChange={(next) => {
          // The panel's colour only means something to one colour and the palette; another
          // scheme would otherwise be hidden behind it.
          const nextDefaults = { ...defaults };
          if (next === "palette") delete nextDefaults.colorScheme;
          else nextDefaults.colorScheme = next;
          if (next !== "single" && next !== "palette") delete nextDefaults.color;
          onChange({ ...config, defaults: nextDefaults });
        }}
      />
      {scheme === "single" || scheme === "palette" ? (
        <ColorField
          label={scheme === "single" ? t("panels.colors.single") : t("panels.colors.allSeries")}
          value={defaults.color}
          optional={scheme === "palette"}
          allowFree
          onChange={(color) => setDefault("color", color)}
        />
      ) : null}
      {scheme === "palette" && defaults.color === undefined ? (
        <div className="colors-editor__preview">
          <span className="field__label">{t("panels.colors.paletteOrder")}</span>
          <span className="colors-editor__swatches" aria-hidden="true">
            {TONES.filter((tone) => tone.startsWith("chart-")).map((tone) => (
              <Swatch key={tone} className={`colors-editor__chip tone--${tone}`} />
            ))}
          </span>
        </div>
      ) : null}
      {ramp === undefined ? null : (
        <div className="colors-editor__preview">
          <span className="field__label">{t("panels.colors.rampOrder")}</span>
          <span className="colors-editor__swatches" aria-hidden="true">
            {RAMP_CLASSES.filter((name) => name.startsWith(`ramp-${ramp}-`)).map((name) => (
              <Swatch key={name} className={`colors-editor__chip ${name}`} />
            ))}
          </span>
        </div>
      )}
      {scheme === "thresholds" ? (
        <p className="field__hint">
          {defaults.thresholds === undefined
            ? t("panels.colors.thresholdsMissing")
            : t("panels.colors.thresholdsHint")}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="field__hint">{t("panels.colors.noSeries")}</p>
      ) : (
        <div className="colors-editor__series">
          <p className="colors-editor__head">
            <span className="field__label">{t("panels.colors.series")}</span>
            <span className="field__hint">{t("panels.colors.seriesColumns")}</span>
          </p>
          <ul className="colors-editor__list">
            {rows.map((name) => (
              <SeriesRow
                key={name}
                name={name}
                properties={seriesOverride(config, name)?.properties ?? {}}
                onSet={(key, value) => onChange(setSeriesProperty(config, name, key, value))}
              />
            ))}
          </ul>
          {seriesNames.length > rows.length ? (
            <p className="field__hint">
              {t("panels.colors.moreSeries", { count: seriesNames.length - rows.length })}
            </p>
          ) : null}
        </div>
      )}
      <p className="field__hint">{t("panels.colors.byThresholdHint")}</p>
    </div>
  );
}

/**
 * A series' colour, line style and opacity: the properties of its own override. The controls are
 * compact, as on the blueprint; each is named with the series for screen readers.
 */
function SeriesRow({
  name,
  properties,
  onSet,
}: {
  name: string;
  properties: OverrideProperties;
  onSet: <K extends keyof FieldOptions>(key: K, value: FieldOptions[K] | undefined) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const color = properties.color ?? undefined;
  const free = isHexColor(color);
  const choice = color === undefined ? "auto" : free ? "custom" : color;
  const swatchClass =
    color === undefined ? "colors-editor__auto" : free ? "series-free" : `tone--${color}`;
  return (
    <li className="colors-editor__row">
      <span className="colors-editor__name">
        <Swatch className={swatchClass} freeColor={free ? color : null} />
        <span className="truncate" title={name}>
          {name}
        </span>
      </span>
      <label className="visually-hidden" htmlFor={`${id}-color`}>
        {t("panels.colors.seriesColor", { name })}
      </label>
      <select
        id={`${id}-color`}
        className="select colors-editor__select"
        value={choice}
        onChange={(event) => {
          const next = event.currentTarget.value;
          if (next === "auto") onSet("color", undefined);
          else if (next === "custom") onSet("color", free ? color : DEFAULT_FREE);
          else onSet("color", next as ColorValue);
        }}
      >
        <option value="auto">{t("panels.colors.auto")}</option>
        {TONES.map((tone) => (
          <option key={tone} value={tone}>
            {toneLabel(t, tone)}
          </option>
        ))}
        <option value="custom">{t("panels.color.custom")}</option>
      </select>
      <label className="visually-hidden" htmlFor={`${id}-line`}>
        {t("panels.colors.lineStyle", { name })}
      </label>
      <select
        id={`${id}-line`}
        className="select colors-editor__select"
        value={properties.lineStyle ?? "auto"}
        onChange={(event) => {
          const next = event.currentTarget.value;
          onSet("lineStyle", next === "auto" ? undefined : (next as LineStyle));
        }}
      >
        <option value="auto">{t("panels.colors.auto")}</option>
        {LINE_STYLES.map((s) => (
          <option key={s} value={s}>
            {t(`panels.graph.lineStyle.${s}`)}
          </option>
        ))}
      </select>
      <span className="colors-editor__percent">
        <label className="visually-hidden" htmlFor={`${id}-opacity`}>
          {t("panels.colors.opacity", { name })}
        </label>
        <input
          id={`${id}-opacity`}
          className="input colors-editor__number"
          type="number"
          inputMode="numeric"
          min={0}
          max={100}
          step={1}
          placeholder="100"
          value={properties.opacity ?? ""}
          onChange={(event) => {
            const text = event.currentTarget.value;
            const value = Number(text);
            if (text === "") onSet("opacity", undefined);
            else if (Number.isInteger(value) && value >= 0 && value <= 100) onSet("opacity", value);
          }}
        />
        <span aria-hidden="true">%</span>
      </span>
      {free ? (
        <div className="colors-editor__free">
          <FreeColorInput value={color} onChange={(hex) => onSet("color", hex)} />
        </div>
      ) : null}
    </li>
  );
}

/** The free colour a series starts with when "Custom colour" is picked: palette colour 1's hue. */
const DEFAULT_FREE = "#6aa3d8" as HexColor;
