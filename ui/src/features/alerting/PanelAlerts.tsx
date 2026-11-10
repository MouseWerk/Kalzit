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
  type AlertState,
  fetchHistory,
  isRange,
  type Rule,
  ruleQuery,
  rulesQuery,
  statusQuery,
} from "./api";
import { evalErrorText } from "./reasons";
import {
  conditionText,
  formatNumber,
  labelPairs,
  STATE_ORDER,
  sortRules,
  timelineRows,
} from "./ruleModel";
import { StateLabel, stateKey, useAlertTime } from "./shared";
import "./alerting.css";

/** The badge's state: the most severe of the panel's rules, silenced firing below the others. */
export type BadgeState = AlertState | "silenced";

/** Most severe first, as the board ranks the badge (frame 12). */
const BADGE_ORDER: readonly BadgeState[] = [
  "firing",
  "error",
  "pending",
  "silenced",
  "no_data",
  "ok",
];

export function badgeState(rules: readonly Rule[]): BadgeState | null {
  const states = rules
    .filter((rule) => !rule.paused && rule.state !== null)
    .map((rule) => rule.state as AlertState);
  if (states.length === 0) return null;
  return BADGE_ORDER.find((state) => states.includes(state as AlertState)) ?? "ok";
}

/**
 * The alert rules made from the panels of a dashboard, for those who may read it and have
 * `alerts:read`, while alerting is on. One request per dashboard; each panel picks its own.
 */
export function useDashboardAlerts(dashboardId: string | undefined): readonly Rule[] {
  const org = useCurrentOrg();
  const orgId = org?.id ?? "";
  const permissions = useOrgPermissions();
  const allowed = org !== undefined && dashboardId !== undefined && permissions.has("alerts:read");
  const status = useQuery({ ...statusQuery(orgId), enabled: allowed });
  const rules = useQuery({
    ...rulesQuery(orgId, { dashboardId: dashboardId ?? "" }),
    enabled: allowed && status.data?.enabled === true,
  });
  return rules.data ?? [];
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

/** The values where the conditions of frame rules change: their limits on the value axis. */
export function alertLimits(rules: readonly Rule[]): number[] {
  return rules.flatMap((rule) => {
    if (rule.paused || rule.reduce.shape !== "frame") return [];
    const condition = rule.condition;
    return isRange(condition) ? [condition.low, condition.high] : [condition.value];
  });
}

/**
 * When the panel's rules fired in the range: spans for the time axis, drawn as a quiet area
 * like an annotation region, from the rules' history.
 */
export function useFiringSpans(
  rules: readonly Rule[],
  range: { from: number; to: number },
  enabled: boolean,
): PanelAnnotation[] {
  const { t } = useI18n();
  const org = useCurrentOrg();
  const orgId = org?.id ?? "";
  const ids = rules.filter((rule) => rule.reduce.shape === "frame").map((rule) => rule.id);
  // Rounded to the minute, so a moving range does not ask again on every refresh.
  const from = Math.floor(range.from / 60_000) * 60_000;
  const to = Math.ceil(range.to / 60_000) * 60_000;
  const history = useQuery({
    queryKey: ["alerting", orgId, "firing-spans", ids, from, to],
    queryFn: async ({ signal }) => {
      const pages = await Promise.all(
        ids.map((ruleId) =>
          fetchHistory(orgId, { ruleId, from, to, kind: "transition", limit: 200 }, signal),
        ),
      );
      return pages.flatMap((page) => page.items);
    },
    enabled: enabled && orgId !== "" && ids.length > 0,
    staleTime: 60_000,
  });
  const entries = history.data ?? [];
  // A rule firing now without a change in the range fired all along.
  const firingNow = rules.filter(
    (rule) => rule.state === "firing" && !entries.some((entry) => entry.ruleId === rule.id),
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

/**
 * The alert badge in a panel's header (board frame 12): the most severe state of the panel's
 * rules as text, or a quiet bell when all are OK. It opens a dialog with the rules, their
 * instances and the ways on (silence, history, open the rule); Escape closes it and focus
 * returns to the badge.
 */
export function PanelAlertBadge({ rules, title }: { rules: readonly Rule[]; title: string }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const state = badgeState(rules);
  if (rules.length === 0) {
    return null;
  }
  const firing = rules.filter((rule) => rule.state === "firing").length;
  const name =
    state === "firing"
      ? t(firing === 1 ? "alerting.badge.firingOne" : "alerting.badge.firing", { count: firing })
      : t("alerting.badge.named", {
          state: t(stateKey(state === null ? "ok" : state)),
          count: rules.length,
        });
  const quiet = state === null || state === "ok";
  return (
    <>
      <button
        type="button"
        className={quiet ? "alert-badge alert-badge--quiet" : "alert-badge"}
        data-state={state ?? "ok"}
        aria-label={name}
        title={name}
        aria-haspopup="dialog"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setOpen(true)}
      >
        <Icon name={state === "silenced" ? "bellOff" : "bell"} />
        {quiet ? null : <span aria-hidden="true">{t(stateKey(state))}</span>}
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
            <BadgeRule key={rule.id} rule={rule} />
          ))}
        </ul>
        <p className="alert-hint">{t("alerting.badge.hint")}</p>
      </Dialog>
    </>
  );
}

function BadgeRule({ rule }: { rule: Rule }) {
  const { t, language } = useI18n();
  const org = useCurrentOrg();
  const permissions = useOrgPermissions();
  const detail = useQuery(ruleQuery(org?.id ?? "", rule.id));
  const time = useAlertTime();
  const instances = [...(detail.data?.instances ?? [])]
    .filter((instance) => instance.state !== "ok")
    .sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state));
  const condition = conditionText(t, rule.condition, language);
  const firstFiring = detail.data?.instances?.find((instance) => instance.state === "firing");
  return (
    <li className="alert-badge-list__item">
      <div className="alert-badge-list__head">
        <StateLabel state={rule.paused ? "paused" : (rule.state ?? "ok")} />
        <span className="alert-rule-name">{rule.name}</span>
      </div>
      {instances.length === 0 ? null : (
        <p className="alert-muted">
          {instances
            .map((instance) => {
              const who = labelPairs(instance.labels)
                .map((pair) => pair.split("=").slice(1).join("="))
                .join(", ");
              if (instance.lastError !== null)
                return `${who} ${evalErrorText(t, instance.lastError)}`;
              if (instance.state === "firing") {
                return t("alerting.badge.instanceFiring", {
                  who: who || rule.name,
                  value:
                    instance.lastValue === null ? "–" : formatNumber(instance.lastValue, language),
                  condition,
                  since: time(instance.stateSince),
                });
              }
              return `${who || rule.name} ${t(stateKey(instance.state)).toLowerCase()}`;
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
              ...(firstFiring === undefined ? {} : { fingerprint: firstFiring.fingerprint }),
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
