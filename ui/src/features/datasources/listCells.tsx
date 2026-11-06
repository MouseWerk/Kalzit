import { useI18n } from "../../i18n/i18n";
import { relativeTime } from "../../shell/startData";
import type { LatencyPoint, TeamShare } from "./api";
import { StatusLabel } from "./StatusLabel";
import type { SourceStatus } from "./sourceStatus";
import "./datasources.css";

/** Up to two letters for the avatar: the first of the first two words, or a word's first two. */
export function initials(name: string): string {
  const [first = "", second] = name.trim().split(/\s+/u);
  const letters =
    second === undefined
      ? Array.from(first).slice(0, 2)
      : [Array.from(first)[0] ?? "", Array.from(second)[0] ?? ""];
  return letters.join("").toLocaleUpperCase();
}

/** How many team avatars the list shows before "n teams" says the rest. */
const AVATARS = 3;

/** "2 hours ago" for a time in Unix milliseconds, in the UI language. */
export function useAgo(): (at: number, now?: number) => string {
  const { t, language } = useI18n();
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "short" });
  return (at, now = Date.now()) => relativeTime(format, at, now, t("datasources.justNow"));
}

/** The teams a source is shared with: the first by name, the others as initials and a count. */
export function TeamCell({ teams }: { teams: readonly TeamShare[] | undefined }) {
  const { t } = useI18n();
  if (teams === undefined) {
    return <span className="ds-cell__muted">–</span>;
  }
  const [first, ...rest] = teams;
  if (first === undefined) {
    return <span className="ds-cell__muted">{t("datasources.team.none")}</span>;
  }
  return (
    <span className="ds-cell">
      <span>{first.name}</span>
      {rest.length === 0 ? null : (
        <span className="ds-cell__line">
          <span className="ds-avatars" aria-hidden="true">
            {rest.slice(0, AVATARS).map((team) => (
              <span key={team.id} className="ds-avatars__item" title={team.name}>
                {initials(team.name)}
              </span>
            ))}
          </span>
          <span className="ds-cell__muted">
            {t("datasources.team.more", { count: rest.length })}
          </span>
        </span>
      )}
      <span className="visually-hidden">{rest.map((team) => team.name).join(", ")}</span>
    </span>
  );
}

/** The width and height of the latency line, in its own units. */
const LINE_W = 52;
const LINE_H = 16;

/** Points of a polyline for the latencies, scaled to the line's box (at least two points). */
export function sparklinePoints(points: readonly LatencyPoint[]): string {
  if (points.length === 0) {
    return "";
  }
  const values = points.length === 1 ? [points[0], points[0]] : points;
  const max = Math.max(...values.map((point) => point?.ms ?? 0), 1);
  const step = (LINE_W - 4) / (values.length - 1);
  return values
    .map((point, index) => {
      const x = 2 + index * step;
      const y = LINE_H - 2 - ((point?.ms ?? 0) / max) * (LINE_H - 4);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

/** The hourly median latency of the last 24 hours as a small line, quiet and neutral. */
export function Sparkline({ points }: { points: readonly LatencyPoint[] }) {
  const { t } = useI18n();
  if (points.length === 0) {
    return null;
  }
  return (
    <svg
      className="ds-sparkline"
      preserveAspectRatio="none"
      viewBox={`0 0 ${LINE_W} ${LINE_H}`}
      role="img"
      aria-label={t("datasources.latency.label")}
    >
      <polyline points={sparklinePoints(points)} />
    </svg>
  );
}

/** Status, and below it the latency line and the latency of the test it comes from. */
export function StatusCell({
  status,
  latencyMs,
  points,
}: {
  status: SourceStatus;
  latencyMs: number | undefined;
  points: readonly LatencyPoint[];
}) {
  const { t } = useI18n();
  return (
    <span className="ds-cell">
      <StatusLabel status={status} />
      <span className="ds-cell__line">
        <Sparkline points={points} />
        {(status === "connected" || status === "slow") && latencyMs !== undefined ? (
          <span className="ds-status__ms">
            {t("datasources.status.ms", { ms: Math.round(latencyMs) })}
          </span>
        ) : null}
      </span>
    </span>
  );
}

/** How many dashboards use the source, and when it last answered a query. */
export function UsageCell({
  usedIn,
  lastUsedAt,
}: {
  usedIn: number;
  lastUsedAt: number | undefined;
}) {
  const { t } = useI18n();
  const ago = useAgo();
  return (
    <span className="ds-cell">
      <span className={usedIn === 0 ? "ds-cell__muted" : undefined}>
        {usedIn === 0
          ? t("datasources.usedIn.none")
          : usedIn === 1
            ? t("datasources.usedIn.one")
            : t("datasources.usedIn.many", { count: usedIn })}
      </span>
      {lastUsedAt === undefined ? null : <span className="ds-cell__muted">{ago(lastUsedAt)}</span>}
    </span>
  );
}

/** When the source last changed and who changed it. */
export function ChangedCell({
  updatedAt,
  updatedBy,
  date,
}: {
  updatedAt: number;
  updatedBy: string | undefined;
  date: (at: number) => string;
}) {
  const { t } = useI18n();
  return (
    <span className="ds-cell">
      <span>{date(updatedAt)}</span>
      {updatedBy === undefined ? null : (
        <span className="ds-cell__muted">{t("datasources.changed.by", { name: updatedBy })}</span>
      )}
    </span>
  );
}
