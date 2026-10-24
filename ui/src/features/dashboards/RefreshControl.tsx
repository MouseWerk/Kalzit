import { IconButton } from "../../components/IconButton";
import { ToolbarMenu } from "../../components/ToolbarMenu";
import { useI18n } from "../../i18n/i18n";
import { intervalLabel, intervalShort, refreshIntervals } from "./refresh";
import "./toolbar.css";

interface RefreshControlProps {
  /** Runs the queries again now. */
  onRefresh: () => void;
  /** The automatic refresh running, in seconds; 0 is off. Without it, no interval menu. */
  seconds?: number;
  onSeconds?: (seconds: number) => void;
  /** The dashboard's own interval list. */
  intervals?: readonly number[] | undefined;
  /** The icon alone, without the word (the panel editor's bar). */
  compact?: boolean;
}

/**
 * Refresh as a split button: the icon runs the queries now, the part beside it chooses the
 * automatic refresh (showing the interval while one runs).
 */
export function RefreshControl({
  onRefresh,
  seconds,
  onSeconds,
  intervals,
  compact = false,
}: RefreshControlProps) {
  const { t } = useI18n();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a pair of buttons, not a set of form fields
    <div className="split-control" role="group" aria-label={t("dashboards.refresh")}>
      <IconButton
        icon="refresh"
        label={t("dashboards.refresh")}
        text={
          compact ? undefined : (
            <span className="dash-toolbar__text">{t("dashboards.refresh")}</span>
          )
        }
        onClick={onRefresh}
      />
      {seconds === undefined || onSeconds === undefined ? null : (
        <ToolbarMenu
          icon="chevronDown"
          label={
            seconds > 0
              ? t("toolbar.refresh.menuRunning", { interval: intervalLabel(t, seconds) })
              : t("dashboards.refresh.auto")
          }
          text={seconds > 0 ? intervalShort(seconds) : undefined}
          className="split-control__menu"
          entries={[0, ...refreshIntervals(intervals, seconds)].map((value) => ({
            kind: "radio" as const,
            key: String(value),
            label: intervalLabel(t, value),
            checked: value === seconds,
            onSelect: () => onSeconds(value),
          }))}
        />
      )}
    </div>
  );
}
