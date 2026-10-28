import { useId, useState } from "react";
import type { Shape } from "../../api/generated/shapes";
import { useI18n } from "../../i18n/i18n";
import { panelDescription, panelName, panelsForShapes, useExternalPanels } from "../registry";
import { CheckboxField } from "../shared";
import { GenericPreview } from "./previews";
import "../viz.css";

/**
 * The visual chooser of panel types: a card with a drawing per type, showing the types that
 * can draw what the query returns. The others appear on request, marked as not fitting. The
 * cards are one radio group, so arrow keys move between them. Panels of plugins come after the
 * built-in ones, each marked as a plugin with the publisher its manifest names.
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
  // Drawn again when the plugins' panels arrive.
  const plugins = useExternalPanels();
  const choices = panelsForShapes(shapes.length === 0 ? ["frame"] : shapes, plugins);
  const hidden = choices.filter((c) => !c.accepts).length;
  const shown = choices.filter((c) => c.accepts || showAll || c.panel.type === value);
  return (
    <fieldset className="picker">
      <legend className="field__label">{t("dashboards.editor.visualization")}</legend>
      <div className="picker__grid">
        {shown.map(({ panel, accepts }) => {
          const Preview = panel.Preview ?? GenericPreview;
          const hintId = `${name}-${panel.type}-hint`;
          const description = panelDescription(t, panel);
          return (
            <label
              key={panel.type}
              // The whole description, also where the card shows only its first two lines.
              title={accepts ? description : undefined}
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
                {panelName(t, panel)}
              </span>
              {panel.external === true ? (
                <span className="picker__badge">
                  {panel.badge === undefined
                    ? t("panelPlugins.badge")
                    : t("panelPlugins.badgeBy", { publisher: panel.badge })}
                </span>
              ) : null}
              <span className="picker__hint" id={hintId}>
                {accepts ? (description ?? "") : t("dashboards.editor.notForShape")}
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
