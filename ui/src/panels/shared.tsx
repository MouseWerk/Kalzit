import { useId } from "react";
import { useI18n } from "../i18n/i18n";
import "./panels.css";

const EMPTY_REASONS = {
  noData: "dashboards.panels.empty.noData",
  noTimeSeries: "dashboards.panels.empty.noTimeSeries",
  noValues: "dashboards.panels.empty.noValues",
} as const;

/** What a panel shows when the data has nothing it can draw, and why. */
export function EmptyPanel({ reason }: { reason: keyof typeof EMPTY_REASONS }) {
  const { t } = useI18n();
  return <p className="panel-empty">{t(EMPTY_REASONS[reason])}</p>;
}

export function UnitField({
  value,
  onChange,
}: {
  value: string;
  onChange: (unit: string) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const hintId = useId();
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {t("dashboards.panels.unit")}
      </label>
      <p className="field__hint" id={hintId}>
        {t("dashboards.panels.unitHint")}
      </p>
      <input
        id={id}
        className="input"
        value={value}
        maxLength={16}
        aria-describedby={hintId}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </div>
  );
}
