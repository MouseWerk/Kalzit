import { useId } from "react";
import { Segmented } from "../features/settings/rows";
import { type MessageKey, useI18n } from "../i18n/i18n";
import {
  DARK_VARIANTS,
  type DarkVariant,
  LIGHT_VARIANTS,
  type LightVariant,
  THEMES,
  type Theme,
} from "../theme/theme";
import type { Preferences, PreferencesPatch } from "./preferences";
import "../features/settings/settings.css";
import "./themeChoice.css";

/** When a side's variant shows, for the line beside its heading (board Themes, frame 7). */
function appliesText(side: "light" | "dark", mode: Theme): MessageKey {
  if (mode === "contrast") {
    return "theme.applies.contrast";
  }
  if (mode === "system") {
    return side === "light" ? "theme.applies.whenLight" : "theme.applies.whenDark";
  }
  if (mode === side) {
    return "theme.applies.always";
  }
  return side === "light" ? "theme.applies.keptLight" : "theme.applies.keptDark";
}

/**
 * The theme on the profile page (board Themes, frame 7): the mode, and below it one light and one
 * dark variant, both always kept; the mode says which applies. Each tile is a small picture drawn
 * with the real tokens of its variant. A value the person never chose shows the server's default;
 * choosing one makes it their own, and "Use the default" lets all three follow the default again.
 */
export function ThemeChoice({
  preferences,
  busy,
  onChange,
}: {
  preferences: Preferences;
  busy: boolean;
  onChange: (patch: PreferencesPatch) => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const modeId = useId();
  const { defaults } = preferences;
  const defaultMode = THEMES.find((theme) => theme === defaults.theme) ?? "system";
  const defaultLight = LIGHT_VARIANTS.find((v) => v === defaults.themeLight) ?? "light";
  const defaultDark = DARK_VARIANTS.find((v) => v === defaults.themeDark) ?? "dark";
  const mode = preferences.theme ?? defaultMode;
  const light = preferences.themeLight ?? defaultLight;
  const dark = preferences.themeDark ?? defaultDark;
  const own =
    preferences.theme !== null || preferences.themeLight !== null || preferences.themeDark !== null;
  const change = (patch: PreferencesPatch) => {
    if (!busy) {
      onChange(patch);
    }
  };

  return (
    <fieldset className="field theme-choice" aria-labelledby={titleId}>
      <div className="theme-choice__heading">
        <span className="field__label" id={titleId}>
          {t("shell.preferences.theme")}
        </span>
        <span className="field__hint">{t("shell.preferences.themeLead")}</span>
      </div>
      <div className="theme-choice__mode">
        <span className="theme-choice__label" id={modeId}>
          {t("theme.mode")}
        </span>
        <Segmented
          labelled={{ "aria-labelledby": modeId }}
          value={mode}
          options={THEMES.map((theme) => ({ value: theme, label: t(`theme.${theme}`) }))}
          onChange={(value) => {
            const theme = THEMES.find((option) => option === value);
            if (theme !== undefined) change({ theme });
          }}
        />
      </div>
      <VariantTiles
        side="light"
        variants={LIGHT_VARIANTS}
        value={light}
        mode={mode}
        onChange={(variant) => change({ themeLight: variant as LightVariant })}
      />
      <VariantTiles
        side="dark"
        variants={DARK_VARIANTS}
        value={dark}
        mode={mode}
        onChange={(variant) => change({ themeDark: variant as DarkVariant })}
      />
      {own ? (
        <div>
          <button
            type="button"
            className="button button--ghost button--small"
            aria-disabled={busy}
            onClick={() => change({ theme: null, themeLight: null, themeDark: null })}
          >
            {t("shell.preferences.themeDefault", {
              value: [
                t(`theme.${defaultMode}`),
                t(`theme.variant.${defaultLight}`),
                t(`theme.variant.${defaultDark}`),
              ].join(" · "),
            })}
          </button>
        </div>
      ) : null}
    </fieldset>
  );
}

function VariantTiles({
  side,
  variants,
  value,
  mode,
  onChange,
}: {
  side: "light" | "dark";
  variants: readonly (LightVariant | DarkVariant)[];
  value: string;
  mode: Theme;
  onChange: (variant: string) => void;
}) {
  const { t } = useI18n();
  const name = useId();
  const appliesId = useId();
  // The tile's picture names its variant on the side it belongs to, so tokens.css draws it with
  // that variant's tokens in that scheme.
  const sideAttribute = side === "light" ? "data-light" : "data-dark";
  return (
    <fieldset className="theme-choice__variants" aria-describedby={appliesId}>
      <legend className="theme-choice__legend">
        <span className="theme-choice__label">
          {t(side === "light" ? "theme.lightVariant" : "theme.darkVariant")}
        </span>{" "}
        <span className="theme-choice__applies" id={appliesId}>
          {t(appliesText(side, mode))}
        </span>
      </legend>
      <div className="theme-choice__tiles">
        {variants.map((variant) => (
          <label key={variant} className="variant-tile">
            <input
              type="radio"
              className="variant-tile__input visually-hidden"
              name={name}
              value={variant}
              checked={variant === value}
              onChange={() => onChange(variant)}
            />
            <span
              className="variant-tile__preview"
              {...{ [sideAttribute]: variant }}
              aria-hidden="true"
            >
              <span className="variant-tile__rail" />
              <span className="variant-tile__main">
                <span className="variant-tile__card">
                  <span className="variant-tile__line" />
                  <span className="variant-tile__line variant-tile__line--muted" />
                </span>
                <span className="variant-tile__button" />
              </span>
            </span>
            <span className="variant-tile__text">
              <span className="variant-tile__name">{t(`theme.variant.${variant}`)}</span>
              <span className="variant-tile__hint">{t(`theme.variantHint.${variant}`)}</span>
            </span>
            <span className="variant-tile__dot" aria-hidden="true" />
          </label>
        ))}
      </div>
    </fieldset>
  );
}
