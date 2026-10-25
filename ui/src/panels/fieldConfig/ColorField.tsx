import { type RefObject, useId, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { contrastRatio, MIN_MARK_CONTRAST } from "./contrast";
import { type ColorValue, type HexColor, isHexColor, TONES, type Tone } from "./fieldConfig";
import { Swatch } from "./Legend";
import { toneLabel } from "./toneLabel";
import "../viz.css";

/**
 * A colour picked from the theme's tones as swatches, or, where the panel draws them, a free
 * colour (`#rrggbb`) typed or picked next to them. A free colour stays the same in every theme,
 * so its contrast is checked against the panel surface in the light and in the dark scheme.
 */
export function ColorField({
  label,
  value,
  onChange,
  allowFree = false,
  optional = false,
  compact = false,
}: {
  label: string;
  value: ColorValue | undefined;
  onChange: (color: ColorValue | undefined) => void;
  /** Offer a free colour; only panels that draw free colours (the time series) do. */
  allowFree?: boolean;
  /** Offer "none", which leaves the colour to the scheme or palette. */
  optional?: boolean;
  /** Smaller swatches, for rows such as threshold steps. */
  compact?: boolean;
}) {
  const { t } = useI18n();
  const name = useId();
  const free = isHexColor(value);
  const [customOpen, setCustomOpen] = useState(free);
  const choose = (next: ColorValue | undefined) => {
    setCustomOpen(false);
    onChange(next);
  };
  return (
    <fieldset className={compact ? "color-field color-field--compact" : "color-field"}>
      <legend className="color-field__legend">{label}</legend>
      <div className="color-field__swatches">
        {optional ? (
          <SwatchOption
            name={name}
            label={t("panels.tone.none")}
            className="color-field__none"
            checked={value === undefined && !customOpen}
            onSelect={() => choose(undefined)}
          />
        ) : null}
        {TONES.map((tone: Tone) => (
          <SwatchOption
            key={tone}
            name={name}
            label={toneLabel(t, tone)}
            className={`tone--${tone}`}
            checked={value === tone && !customOpen}
            onSelect={() => choose(tone)}
          />
        ))}
        {allowFree ? (
          <SwatchOption
            name={name}
            label={t("panels.color.custom")}
            className={free ? "series-free" : "color-field__add"}
            freeColor={free ? value : null}
            checked={free || customOpen}
            onSelect={() => setCustomOpen(true)}
            icon={free ? null : "plus"}
          />
        ) : null}
      </div>
      {allowFree && (free || customOpen) ? (
        <FreeColorInput value={free ? value : undefined} onChange={(hex) => onChange(hex)} />
      ) : null}
    </fieldset>
  );
}

/** One swatch as a radio button: the input is hidden, the label shows the colour and a check. */
function SwatchOption({
  name,
  label,
  className,
  checked,
  onSelect,
  freeColor = null,
  icon = null,
}: {
  name: string;
  label: string;
  className: string;
  checked: boolean;
  onSelect: () => void;
  freeColor?: string | null;
  icon?: "plus" | null;
}) {
  const id = useId();
  return (
    <span className="color-field__option">
      <input
        id={id}
        type="radio"
        name={name}
        className="color-field__input"
        checked={checked}
        onChange={onSelect}
      />
      <label htmlFor={id} className="color-field__swatch" title={label}>
        <Swatch className={`color-field__chip ${className}`} freeColor={freeColor} />
        {checked ? (
          <span className="color-field__mark" aria-hidden="true">
            <Icon name="check" />
          </span>
        ) : icon === null ? null : (
          <span className="color-field__mark" aria-hidden="true">
            <Icon name={icon} />
          </span>
        )}
        <span className="visually-hidden">{label}</span>
      </label>
    </span>
  );
}

/** Reads the panel surface colour in the light and in the dark scheme, through two probes. */
function useSurfaces(): {
  probes: RefObject<HTMLSpanElement | null>[];
  surfaces: { light: string; dark: string };
} {
  const light = useRef<HTMLSpanElement>(null);
  const dark = useRef<HTMLSpanElement>(null);
  const [surfaces, setSurfaces] = useState({ light: "", dark: "" });
  useLayoutEffect(() => {
    const read = (el: HTMLSpanElement | null) => (el === null ? "" : getComputedStyle(el).color);
    setSurfaces({ light: read(light.current), dark: read(dark.current) });
  }, []);
  return { probes: [light, dark], surfaces };
}

/**
 * The free colour: a hex field and the browser's colour picker, kept in step, and the contrast
 * against the panel surface. A value is only passed on once it is a full `#rrggbb`.
 */
export function FreeColorInput({
  value,
  onChange,
}: {
  value: HexColor | undefined;
  onChange: (hex: HexColor) => void;
}) {
  const { t, language } = useI18n();
  const id = useId();
  const [text, setText] = useState<string>(value ?? "#");
  const { probes, surfaces } = useSurfaces();
  const valid = isHexColor(text);
  const hex = valid ? (text.toLowerCase() as HexColor) : value;
  const ratio = (surface: string) =>
    hex === undefined || surface === "" ? null : contrastRatio(hex, surface);
  const onLight = ratio(surfaces.light);
  const onDark = ratio(surfaces.dark);
  const format = new Intl.NumberFormat(language, { maximumFractionDigits: 1 });
  const low =
    (onLight !== null && onLight < MIN_MARK_CONTRAST) ||
    (onDark !== null && onDark < MIN_MARK_CONTRAST);
  return (
    <div className="color-field__free">
      <span className="color-field__probe color-field__probe--light" ref={probes[0]} />
      <span className="color-field__probe color-field__probe--dark" ref={probes[1]} />
      <div className="color-field__free-row">
        <label className="visually-hidden" htmlFor={`${id}-picker`}>
          {t("panels.color.picker")}
        </label>
        <input
          id={`${id}-picker`}
          type="color"
          className="color-field__picker"
          value={hex ?? "#000000"}
          onChange={(event) => {
            const next = event.currentTarget.value.toLowerCase() as HexColor;
            setText(next);
            onChange(next);
          }}
        />
        <div className="field color-field__hex">
          <label className="field__label" htmlFor={`${id}-hex`}>
            {t("panels.color.hex")}
          </label>
          <input
            id={`${id}-hex`}
            className="input input--mono"
            value={text}
            maxLength={7}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={text !== "#" && !valid ? true : undefined}
            aria-describedby={`${id}-contrast`}
            onChange={(event) => {
              const next = event.currentTarget.value.trim();
              setText(next);
              if (isHexColor(next)) {
                onChange(next.toLowerCase() as HexColor);
              }
            }}
          />
        </div>
      </div>
      <p
        id={`${id}-contrast`}
        className={low ? "field__error" : "field__hint"}
        role={low ? "alert" : undefined}
      >
        {text !== "#" && !valid
          ? t("panels.color.hexInvalid")
          : onLight === null || onDark === null
            ? t("panels.color.hexHint")
            : t(low ? "panels.color.contrastLow" : "panels.color.contrastOk", {
                light: format.format(onLight),
                dark: format.format(onDark),
              })}
      </p>
    </div>
  );
}
