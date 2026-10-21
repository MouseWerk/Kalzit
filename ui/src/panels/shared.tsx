import { useId } from "react";
import type { Frame } from "../api/generated/shapes";
import { useI18n } from "../i18n/i18n";
import { rowCount } from "./frame";
import "./panels.css";
import "../features/dashboards/ui/shared.css";

const EMPTY_REASONS = {
  noData: "dashboards.panels.empty.noData",
  noTimeSeries: "dashboards.panels.empty.noTimeSeries",
  noValues: "dashboards.panels.empty.noValues",
} as const;

type EmptyReason = keyof typeof EMPTY_REASONS;

/** What a panel shows when the data has nothing it can draw, and why. */
export function EmptyPanel({ reason }: { reason: EmptyReason }) {
  const { t } = useI18n();
  return <p className="panel-empty">{t(EMPTY_REASONS[reason])}</p>;
}

/**
 * Why there is nothing to draw: without any row the query found no data, which says more than the
 * panel's own reason. An empty result also has no values to tell a column's type by, so a number
 * column can arrive as text and the panel's reason would be wrong.
 */
export function emptyReason(frames: readonly Frame[], otherwise: EmptyReason): EmptyReason {
  return frames.every((frame) => rowCount(frame) === 0) ? "noData" : otherwise;
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
