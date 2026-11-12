import { useI18n } from "../../i18n/i18n";
import { formatNumber } from "./ruleModel";
import "./alerting.css";

/**
 * A grouped notification as mail, Slack or Teams show it (board AlertingRouting.dc.html, frame
 * 6): subject or header with the state and the group, the changes since the last message on top,
 * the instances that keep firing below, the links. Only reduced values, never rows, documents or
 * nodes. Drawn from what the UI knows; the server builds the real message.
 */

export type MessageKind = "mail" | "slack" | "teams";

export interface MessageInstance {
  rule: string;
  /** The instance's own labels as `key=value`, shortened. */
  labels: string;
  value: string;
  condition: string;
  since: string;
  isNew: boolean;
}

export interface MessageGroup {
  org: string;
  /** "Standard › Lager › Lager kritisch"; empty for a rule that goes directly. */
  way: string;
  /** The group's labels, `key=value`. */
  groupLabels: string[];
  instances: MessageInstance[];
  /** The escalation step this message is sent for; null for the policy's own contact points. */
  escalation: number | null;
}

/** How many instances a message writes out before "und N weitere". */
export const WRITTEN_OUT: Record<MessageKind, number> = { mail: 20, slack: 10, teams: 10 };

export function GroupedMessage({ kind, group }: { kind: MessageKind; group: MessageGroup }) {
  const { t } = useI18n();
  const limit = WRITTEN_OUT[kind];
  const shown = group.instances.slice(0, limit);
  const more = group.instances.length - shown.length;
  const fresh = shown.filter((instance) => instance.isNew);
  const still = shown.filter((instance) => !instance.isNew);
  const count = group.instances.length;
  const what =
    count === 1 ? t("alerting.message.instanceOne") : t("alerting.message.instances", { count });
  const title = group.groupLabels.map((pair) => pair.split("=").slice(1).join("=")).join(", ");
  const state =
    group.escalation === null
      ? t("alerting.message.firing")
      : t("alerting.message.escalated", { level: group.escalation });
  const subject = `[${state}] ${what}${title === "" ? "" : ` · ${title}`} · ${group.org}`;
  const buttons = (
    <p className="alert-msg__buttons">
      <span className="alert-chip">{t("alerting.message.openRule")}</span>
      <span className="alert-chip">{t("alerting.message.openPanel")}</span>
      <span className="alert-chip">
        {t(kind === "mail" ? "alerting.message.silenceGroup" : "alerting.message.silence")}
      </span>
    </p>
  );
  const instanceCard = (instance: MessageInstance) => (
    <li key={`${instance.rule}:${instance.labels}`} className="alert-msg__inst">
      <span className="alert-mono-cell">
        {kind === "teams" || group.instances.some((other) => other.rule !== instance.rule)
          ? `${instance.rule} · `
          : ""}
        {instance.labels}
        {instance.isNew && kind !== "mail" ? (
          <span className="alert-chip">{t("alerting.message.new")}</span>
        ) : null}
      </span>
      <span className="alert-msg__value">{instance.value}</span>
      <span className="alert-msg__detail">
        {t("alerting.message.detail", { condition: instance.condition, since: instance.since })}
      </span>
    </li>
  );
  if (kind === "mail") {
    return (
      <div className="alert-msg">
        <p className="alert-message__subject">{subject}</p>
        {group.way === "" ? null : (
          <p className="alert-muted">
            {t("alerting.message.wayLine", {
              way: group.way,
              group: group.groupLabels.join(", ") || "–",
            })}
          </p>
        )}
        {fresh.length === 0 ? null : (
          <>
            <p className="alert-overline">{t("alerting.message.newSince")}</p>
            <ul className="alert-msg__list">{fresh.map(instanceCard)}</ul>
          </>
        )}
        {still.length === 0 ? null : (
          <>
            <p className="alert-overline">{t("alerting.message.stillFiring")}</p>
            <ul className="alert-msg__list">{still.map(instanceCard)}</ul>
          </>
        )}
        {more > 0 ? (
          <p className="alert-muted">{t("alerting.message.more", { count: more })}</p>
        ) : null}
        {buttons}
        {group.escalation === null ? null : (
          <p className="alert-hint">
            {t("alerting.message.viaEscalation", { level: group.escalation })}
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="alert-msg alert-msg--chat" data-kind={kind}>
      <p className="alert-msg__head">
        <span className="alert-kind" aria-hidden="true">
          K
        </span>
        <strong>
          {state}: {what}
          {title === "" ? "" : ` · ${title}`}
        </strong>
      </p>
      <p className="alert-muted">
        {[group.org, group.way.split(" › ").at(-1) ?? ""].filter((part) => part !== "").join(" · ")}
        {fresh.length > 0 && still.length > 0
          ? ` · ${t("alerting.message.newAndStill", { fresh: fresh.length, still: still.length })}`
          : ""}
      </p>
      <ul className="alert-msg__list">{shown.map(instanceCard)}</ul>
      {more > 0 ? (
        <p className="alert-muted">{t("alerting.message.more", { count: more })}</p>
      ) : null}
      {buttons}
      {group.groupLabels.length === 0 ? null : (
        <p className="alert-hint alert-mono-cell">{group.groupLabels.join(" · ")}</p>
      )}
    </div>
  );
}

/** A made-up group for the contact point form: what a message to it looks like. */
export function sampleGroup(
  t: ReturnType<typeof useI18n>["t"],
  org: string,
  language: string,
): MessageGroup {
  const rule = t("alerting.message.sampleRule");
  const n = (value: number) => formatNumber(value, language);
  const condition = `> ${n(1.5)}`;
  return {
    org,
    way: t("alerting.message.sampleWay"),
    groupLabels: [`alertname=${rule}`],
    escalation: null,
    instances: [
      { rule, labels: "instance=server-3", value: n(1.62), condition, since: "14:07", isNew: true },
      {
        rule,
        labels: "instance=server-2",
        value: n(1.84),
        condition,
        since: "14:02",
        isNew: false,
      },
      {
        rule,
        labels: "instance=server-1",
        value: n(1.57),
        condition,
        since: "14:02",
        isNew: false,
      },
    ],
  };
}
