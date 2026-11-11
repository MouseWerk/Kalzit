import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { readPreference, writePreference } from "../../lib/storage";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import type { PanelAnnotation } from "../../panels/annotations";
import { Dialog } from "../admin/components/Dialog";
import {
  ALERTING_KEY,
  type AlertState,
  type BadgeInstance,
  type BadgeRule,
  fetchHistory,
  fetchPanelBadges,
  isRange,
  ruleQuery,
  silencesQuery,
  statusQuery,
} from "./api";
import { evalErrorText } from "./reasons";
import {
  conditionText,
  formatNumber,
  labelPairs,
  STATE_ORDER,
  silenceEnd,
  sortRules,
  timelineRows,
} from "./ruleModel";
import { StateLabel, stateKey, useAlertTime } from "./shared";
import "./alerting.css";

/**
 * The badge's state: the most severe of the panel's rules, silenced firing below the others;
 * `paused` when every rule of the panel is paused, `null` while none was evaluated.
 */
export type BadgeState = AlertState | "silenced" | "paused";

/** Most severe first, as the board ranks the badge (frame 12). */
const BADGE_ORDER: readonly BadgeState[] = [
  "firing",
  "error",
  "pending",
  "silenced",
  "no_data",
  "ok",
];

/** A rule's state for the badge: firing but silenced reads "Stumm". */
function ruleBadgeState(rule: BadgeRule): BadgeState | null {
  if (rule.paused || rule.state === null) return null;
  return rule.state === "firing" && rule.silenced ? "silenced" : rule.state;
}

export function badgeState(rules: readonly BadgeRule[]): BadgeState | null {
  if (rules.length > 0 && rules.every((rule) => rule.paused)) return "paused";
  const states = rules.flatMap((rule) => {
    const state = ruleBadgeState(rule);
    return state === null ? [] : [state];
  });
  if (states.length === 0) return null;
  return BADGE_ORDER.find((state) => states.includes(state)) ?? "ok";
}

const NO_RULES: readonly BadgeRule[] = [];

/** Whether alerting is on for the organization, for those who may read it. */
export function useAlertingOn(): boolean {
  const org = useCurrentOrg();
  const permissions = useOrgPermissions();
  const allowed = org !== undefined && permissions.has("alerts:read");
  const status = useQuery({ ...statusQuery(org?.id ?? ""), enabled: allowed });
  return allowed && status.data?.enabled === true;
}

/**
 * The alert rules made from the panels of a dashboard, for those who may read it and have
 * `alerts:read`, while alerting is on. One request per dashboard; each panel picks its own.
 */
export function usePanelAlerts(
  dashboardId: string | undefined,
  panelId: string,
): readonly BadgeRule[] {
  const org = useCurrentOrg();
  const orgId = org?.id ?? "";
  const on = useAlertingOn();
  const badges = useQuery({
    queryKey: [ALERTING_KEY, orgId, "panels", dashboardId ?? ""],
    queryFn: ({ signal }) => fetchPanelBadges(orgId, dashboardId ?? "", signal),
    enabled: on && dashboardId !== undefined,
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
  return badges.data?.get(panelId) ?? NO_RULES;
}

const overlayKey = (dashboardId: string, panelId: string) =>
  `kalzit.alertOverlay.${dashboardId}.${panelId}`;

/** Whether the person hid the limit and the firing range of a panel ("ausblenden" in its menu). */
export function useAlertOverlay(
  dashboardId: string,
  panelId: string,
): [boolean, (hidden: boolean) => void] {
  const [hidden, setHidden] = useState(
    () => readPreference(overlayKey(dashboardId, panelId)) === "hidden",
  );
  return [
    hidden,
    (next: boolean) => {
      setHidden(next);
      writePreference(overlayKey(dashboardId, panelId), next ? "hidden" : "shown");
    },
  ];
}

/** Reductions whose value lies on the series' own axis; a sum or a count of points does not. */
const ON_AXIS = new Set(["last", "min", "max", "mean"]);

/** Whether a rule's limit can be drawn on the panel's value axis. */
function onAxis(rule: BadgeRule): boolean {
  return (
    !rule.paused &&
    rule.reduce !== null &&
    rule.reduce.shape === "frame" &&
    ON_AXIS.has(rule.reduce.function)
  );
}

/** The values where the conditions of frame rules change: their limits on the value axis. */
export function alertLimits(rules: readonly BadgeRule[]): number[] {
  return rules.flatMap((rule) => {
    if (!onAxis(rule)) return [];
    const condition = rule.condition;
    return isRange(condition) ? [condition.low, condition.high] : [condition.value];
  });
}

/**
 * When the panel's rules fired in the range: spans for the time axis, drawn as a quiet area
 * like an annotation region. One history request per dashboard and minute; each panel takes the
 * changes of its own rules.
 */
export function useFiringSpans(
  dashboardId: string,
  rules: readonly BadgeRule[],
  range: { from: number; to: number },
  enabled: boolean,
): PanelAnnotation[] {
  const { t } = useI18n();
  const org = useCurrentOrg();
  const orgId = org?.id ?? "";
  const ids = new Set(rules.filter(onAxis).map((rule) => rule.id));
  // Rounded to the minute, so a moving range does not ask again on every refresh.
  const from = Math.floor(range.from / 60_000) * 60_000;
  const to = Math.ceil(range.to / 60_000) * 60_000;
  const history = useQuery({
    queryKey: [ALERTING_KEY, orgId, "firing-spans", dashboardId, from, to],
    queryFn: async ({ signal }) =>
      (await fetchHistory(orgId, { from, to, kind: "transition", limit: 200 }, signal)).items,
    enabled: enabled && orgId !== "" && ids.size > 0,
    staleTime: 60_000,
  });
  const entries = (history.data ?? []).filter((entry) => ids.has(entry.ruleId));
  // A rule firing now without a change in the range fired all along.
  const firingNow = rules.filter(
    (rule) =>
      ids.has(rule.id) &&
      rule.state === "firing" &&
      !entries.some((entry) => entry.ruleId === rule.id),
  );
  const spans = timelineRows(entries, from, to).flatMap((row) =>
    row.segments
      .filter((segment) => segment.state === "firing")
      .map((segment) => ({
        key: `alert:${row.key}:${segment.from}`,
        time: segment.from,
        timeEnd: segment.to,
        text: t("alerting.badge.firedSpan", { name: row.title }),
        tags: [],
      })),
  );
  for (const rule of firingNow) {
    spans.push({
      key: `alert:${rule.id}:now`,
      time: from,
      timeEnd: to,
      text: t("alerting.badge.firedSpan", { name: rule.name }),
      tags: [],
    });
  }
  return spans;
}

/** The rule id of a firing area's key (`alert:<rule>:...`), for the link to its history. */
export function firingSpanRule(key: string): string | undefined {
  const [prefix, rule] = key.split(":");
  return prefix === "alert" && rule !== undefined && rule !== "" ? rule : undefined;
}

/** When the earliest silence that holds back a silenced rule's instances ends. */
function useSilencedUntil(rules: readonly BadgeRule[]): number | null {
  const org = useCurrentOrg();
  const silenced = rules.filter((rule) => rule.silenced);
  const silences = useQuery({
    ...silencesQuery(org?.id ?? "", "active"),
    enabled: org !== undefined && silenced.length > 0,
  });
  const ends = silenced.flatMap((rule) =>
    (rule.instances ?? [{ labels: {} }]).flatMap((instance) => {
      const end = silenceEnd(silences.data ?? [], rule.name, instance.labels);
      return end === null ? [] : [end];
    }),
  );
  return ends.length === 0 ? null : Math.min(...ends);
}

/**
 * The alert badge in a panel's header (board frame 12): the most severe state of the panel's
 * rules as text, or a quiet bell when all are OK. It opens a dialog with the rules, their
 * instances and the ways on (silence, history, open the rule); Escape closes it and focus
 * returns to the badge.
 */
export function PanelAlertBadge({ rules, title }: { rules: readonly BadgeRule[]; title: string }) {
  const { t } = useI18n();
  const time = useAlertTime();
  const [open, setOpen] = useState(false);
  const state = badgeState(rules);
  const until = useSilencedUntil(state === "silenced" ? rules : NO_RULES);
  if (rules.length === 0) {
    return null;
  }
  const firing = rules.filter((rule) => rule.state === "firing" && !rule.silenced).length;
  const stateText =
    state === null
      ? t("alerting.rules.notEvaluated")
      : state === "silenced" && until !== null
        ? t("alerting.badge.silencedUntil", { at: time(until) })
        : t(stateKey(state));
  const name =
    state === "firing"
      ? t(firing === 1 ? "alerting.badge.firingOne" : "alerting.badge.firing", { count: firing })
      : t("alerting.badge.named", { state: stateText, count: rules.length });
  const quiet = state === null || state === "ok" || state === "paused";
  return (
    <>
      <button
        type="button"
        className={quiet ? "alert-badge alert-badge--quiet" : "alert-badge"}
        data-state={state ?? "none"}
        aria-label={name}
        title={name}
        aria-haspopup="dialog"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setOpen(true)}
      >
        <Icon name={state === "silenced" || state === "paused" ? "bellOff" : "bell"} />
        {quiet ? null : <span aria-hidden="true">{stateText}</span>}
      </button>
      <Dialog
        open={open}
        title={t("alerting.badge.title", { panel: title })}
        onClose={() => setOpen(false)}
        footer={
          <button type="button" className="button button--secondary" onClick={() => setOpen(false)}>
            {t("alerting.badge.close")}
          </button>
        }
      >
        <ul className="alert-badge-list">
          {sortRules(rules).map((rule) => (
            <BadgeRuleItem key={rule.id} rule={rule} />
          ))}
        </ul>
        <p className="alert-hint">{t("alerting.badge.hint")}</p>
      </Dialog>
    </>
  );
}

function BadgeRuleItem({ rule }: { rule: BadgeRule }) {
  const { t, language } = useI18n();
  const org = useCurrentOrg();
  const permissions = useOrgPermissions();
  // An older server sends no instances with the badge: then the rule itself is asked for.
  const detail = useQuery({
    ...ruleQuery(org?.id ?? "", rule.id),
    enabled: rule.instances === undefined,
  });
  const time = useAlertTime();
  const all: BadgeInstance[] =
    rule.instances ??
    (detail.data?.instances ?? []).map((instance) => ({
      fingerprint: instance.fingerprint,
      labels: instance.labels,
      state: instance.state,
      stateSince: instance.stateSince,
      lastValue: instance.lastValue,
      silenced: instance.silencedBy.length > 0,
      error: instance.lastError,
    }));
  const instances = all
    .filter((instance) => instance.state !== "ok")
    .sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state));
  const condition = conditionText(t, rule.condition, language);
  const firstFiring = all.find((instance) => instance.state === "firing");
  const state = ruleBadgeState(rule);
  return (
    <li className="alert-badge-list__item">
      <div className="alert-badge-list__head">
        <StateLabel state={rule.paused ? "paused" : (state ?? "ok")} />
        <span className="alert-rule-name">{rule.name}</span>
      </div>
      {instances.length === 0 ? null : (
        <p className="alert-muted">
          {instances
            .map((instance) => {
              const who =
                labelPairs(instance.labels)
                  .map((pair) => pair.split("=").slice(1).join("="))
                  .join(", ") || rule.name;
              if (instance.error !== null) {
                return t("alerting.badge.instanceError", {
                  who,
                  error: evalErrorText(t, instance.error),
                });
              }
              if (instance.state === "firing") {
                return t("alerting.badge.instanceFiring", {
                  who,
                  value:
                    instance.lastValue === null ? "–" : formatNumber(instance.lastValue, language),
                  condition,
                  since: time(instance.stateSince),
                });
              }
              return t(`alerting.badge.instance.${instance.state}`, { who });
            })
            .join(" · ")}
        </p>
      )}
      <div className="alert-row-actions">
        {permissions.has("alerts:write") && rule.state === "firing" ? (
          <Link
            to="/alerting/silences"
            search={{
              rule: rule.id,
              ...(firstFiring?.fingerprint == null ? {} : { fingerprint: firstFiring.fingerprint }),
            }}
            className="button button--secondary button--small"
          >
            <Icon name="bellOff" />
            {t("alerting.rules.silence")}
          </Link>
        ) : null}
        <Link
          to="/alerting/history"
          search={{ rule: rule.id }}
          className="button button--ghost button--small"
        >
          {t("alerting.badge.history")}
        </Link>
        <Link
          to="/alerting/rules/$ruleId"
          params={{ ruleId: rule.id }}
          className="button button--ghost button--small"
        >
          {t("alerting.badge.open")}
        </Link>
      </div>
    </li>
  );
}
