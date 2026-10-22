import { useId, useState } from "react";
import type { Shape } from "../../api/generated/shapes";
import { useI18n } from "../../i18n/i18n";
import { panelsForShapes } from "../registry";
import { CheckboxField } from "../shared";
import { GenericPreview } from "./previews";
import "../viz.css";

/**
 * The visual chooser of panel types: a card with a drawing per type, showing the types that
 * can draw what the query returns. The others appear on request, marked as not fitting. The
 * cards are one radio group, so arrow keys move between them.
 */
export function PanelPicker({
  value,
  shapes,
  onChange,
}: {
  value: string;
  /** Shapes the query returns, or its data sources can return; empty when nothing is known. */
  shapes: readonly Shape[];
  onChange: (type: string) => void;
}) {
  const { t } = useI18n();
  const name = useId();
  const [showAll, setShowAll] = useState(false);
  const choices = panelsForShapes(shapes.length === 0 ? ["frame"] : shapes);
  const hidden = choices.filter((c) => !c.accepts).length;
  const shown = choices.filter((c) => c.accepts || showAll || c.panel.type === value);
  return (
    <fieldset className="picker">
      <legend className="field__label">{t("dashboards.editor.visualization")}</legend>
      <div className="picker__grid">
        {shown.map(({ panel, accepts }) => {
          const Preview = panel.Preview ?? GenericPreview;
          const hintId = `${name}-${panel.type}-hint`;
          return (
            <label
              key={panel.type}
              className={
                panel.type === value ? "picker__card picker__card--current" : "picker__card"
              }
            >
              <input
                type="radio"
                className="picker__radio"
                name={name}
                value={panel.type}
                checked={panel.type === value}
                aria-labelledby={`${name}-${panel.type}-name`}
                aria-describedby={hintId}
                onChange={() => onChange(panel.type)}
              />
              <Preview />
              <span className="picker__name" id={`${name}-${panel.type}-name`}>
                {t(panel.name)}
              </span>
              <span className="picker__hint" id={hintId}>
                {accepts
                  ? panel.description === undefined
                    ? ""
                    : t(panel.description)
                  : t("dashboards.editor.notForShape")}
              </span>
            </label>
          );
        })}
      </div>
      {hidden > 0 ? (
        <CheckboxField
          label={t("panels.picker.showAll", { count: hidden })}
          checked={showAll}
          onChange={setShowAll}
        />
      ) : null}
    </fieldset>
  );
}
