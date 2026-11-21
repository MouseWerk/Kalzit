import { useState } from "react";
import { useI18n } from "../../../i18n/i18n";
import { CARD_PROPERTIES, type GraphPanelOptions, ownEntry, withEntry } from "../options";
import "../graph.css";

/** The property names typed into a row: comma-separated, each once, at most CARD_PROPERTIES. */
export function cardNames(text: string): string[] {
  const names = text
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  return [...new Set(names)].slice(0, CARD_PROPERTIES);
}

/**
 * The info card's properties per label in the panel editor (Graph 0.8.1 board, decision 6): up
 * to four names per label, comma-separated; an empty row keeps the card's own order.
 */
export function InfoCardOptions({
  labels,
  value,
  onChange,
}: {
  labels: readonly string[];
  value: GraphPanelOptions["infoCard"];
  onChange: (value: GraphPanelOptions["infoCard"]) => void;
}) {
  const { t } = useI18n();
  return (
    <fieldset className="graph-options__labels">
      <legend className="field__label">{t("graphCanvas.editor.card")}</legend>
      <p className="field__hint">{t("graphCanvas.editor.cardHint")}</p>
      {labels.map((label) => (
        <CardRow
          key={label}
          label={label}
          names={ownEntry(value, label) ?? []}
          onNames={(names) =>
            onChange(withEntry(value, label, names.length > 0 ? names : undefined))
          }
        />
      ))}
    </fieldset>
  );
}

/** One label's row: typed freely, taken over when the field is left. */
function CardRow({
  label,
  names,
  onNames,
}: {
  label: string;
  names: readonly string[];
  onNames: (names: string[]) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div className="graph-options__label-row">
      <span className="graph-options__label-name">{label}</span>
      <input
        className="input"
        type="text"
        autoComplete="off"
        spellCheck={false}
        aria-label={t("graphCanvas.editor.cardLabel", { label })}
        placeholder={t("graphCanvas.editor.cardPlaceholder")}
        value={draft ?? names.join(", ")}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={() => {
          if (draft === null) return;
          setDraft(null);
          onNames(cardNames(draft));
        }}
      />
    </div>
  );
}
