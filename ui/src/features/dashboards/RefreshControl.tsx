import { IconButton } from "../../components/IconButton";
import { ToolbarMenu, type ToolbarMenuEntry } from "../../components/ToolbarMenu";
import { useI18n } from "../../i18n/i18n";
import { intervalLabel, intervalShort, refreshIntervals } from "./refresh";
import "./toolbar.css";

/** Live updates of a dashboard: off, on, or paused by the person. */
export type LiveChoice = "off" | "on" | "paused";

interface RefreshControlProps {
  /** Runs the queries again now. */
  onRefresh: () => void;
  /** The automatic refresh running, in seconds; 0 is off. Without it, no interval menu. */
  seconds?: number;
  onSeconds?: (seconds: number) => void;
  /** The dashboard's own interval list. */
  intervals?: readonly number[] | undefined;
  /** Live updates, offered in the interval menu when given. */
  live?: LiveChoice | undefined;
  onLive?: ((live: LiveChoice) => void) | undefined;
  /** The icon alone, without the word (the panel editor's bar). */
  compact?: boolean;
}

/**
 * Refresh as a split button: the icon runs the queries now, the part beside it chooses the
 * automatic refresh (showing the interval while one runs) or live updates, which replace it.
 */
export function RefreshControl({
  onRefresh,
  seconds,
  onSeconds,
  intervals,
  live = "off",
  onLive,
  compact = false,
}: RefreshControlProps) {
  const { t } = useI18n();
  const liveOn = onLive !== undefined && live !== "off";
  let label = t("dashboards.refresh.auto");
  let text: string | undefined;
  if (liveOn) {
    label = live === "paused" ? t("live.menu.labelPaused") : t("live.menu.label");
    text = live === "paused" ? t("live.paused") : t("live.on");
  } else if (seconds !== undefined && seconds > 0) {
    label = t("toolbar.refresh.menuRunning", { interval: intervalLabel(t, seconds) });
    text = intervalShort(seconds);
  }
  const entries: ToolbarMenuEntry[] =
    seconds === undefined || onSeconds === undefined
      ? []
      : [0, ...refreshIntervals(intervals, seconds)].map((value) => ({
          kind: "radio" as const,
          key: String(value),
          label: intervalLabel(t, value),
          checked: !liveOn && value === seconds,
          onSelect: () => {
            onLive?.("off");
            onSeconds(value);
          },
        }));
  if (onLive !== undefined) {
    entries.push(
      { kind: "separator", key: "live-sep" },
      {
        kind: "radio",
        key: "live",
        label: t("live.menu.live"),
        checked: liveOn,
        onSelect: () => onLive(live === "paused" ? "paused" : "on"),
      },
    );
    if (liveOn) {
      entries.push(
        live === "paused"
          ? { key: "resume", label: t("live.menu.resume"), onSelect: () => onLive("on") }
          : { key: "pause", label: t("live.menu.pause"), onSelect: () => onLive("paused") },
      );
    }
  }
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
      {entries.length === 0 ? null : (
        <ToolbarMenu
          icon="chevronDown"
          label={label}
          text={text}
          className="split-control__menu"
          entries={entries}
        />
      )}
    </div>
  );
}
