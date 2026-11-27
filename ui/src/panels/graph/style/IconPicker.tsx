import { useId, useState } from "react";
import { useI18n } from "../../../i18n/i18n";
import { useIcons } from "./icons/load";
import "./style.css";

/** At most this many icons are offered at once; the search narrows the rest. */
export const ICONS_SHOWN = 60;

/**
 * Picks an icon of the set: a search over names and tags, and a grid of buttons, the chosen one
 * pressed (a quiet tint, never an accent). The icons are inline SVG paths, nothing is fetched
 * from elsewhere. The set loads with the picker.
 */
export function IconPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (icon: string) => void;
}) {
  const { t, language } = useI18n();
  const number = new Intl.NumberFormat(language);
  const set = useIcons();
  const [query, setQuery] = useState("");
  const searchId = useId();
  const countId = useId();
  if (set === null) {
    return <p className="field__hint">{t("graphStyle.icon.loading")}</p>;
  }
  const found = set.searchIcons(query);
  // The chosen icon stays in view, also when the search would leave it out.
  const shown = found.slice(0, ICONS_SHOWN);
  if (value !== "" && set.iconOf(value) !== undefined && !shown.includes(value)) {
    shown.unshift(value);
  }
  return (
    <fieldset className="graph-style-icons">
      <legend className="field__label">{label}</legend>
      <label className="visually-hidden" htmlFor={searchId}>
        {t("graphStyle.icon.search")}
      </label>
      <input
        id={searchId}
        className="input"
        type="search"
        value={query}
        placeholder={t("graphStyle.icon.search")}
        aria-describedby={countId}
        onChange={(event) => setQuery(event.currentTarget.value)}
      />
      <p className="field__hint" id={countId} aria-live="polite">
        {found.length === 0
          ? t("graphStyle.icon.none")
          : t("graphStyle.icon.count", {
              shown: number.format(Math.min(found.length, ICONS_SHOWN)),
              total: number.format(found.length),
            })}
      </p>
      <div className="graph-style-icons__grid">
        {shown.map((name) => {
          const icon = set.iconOf(name);
          if (icon === undefined) return null;
          return (
            <button
              key={name}
              type="button"
              className="graph-style-icons__icon"
              aria-pressed={value === name}
              title={name}
              onClick={() => onChange(name)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d={icon.d} />
              </svg>
              <span className="visually-hidden">{name}</span>
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
