import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useRef } from "react";
import { Breadcrumbs, type Crumb } from "../../components/Breadcrumbs";
import { EmptyState } from "../../components/EmptyState";
import { Page } from "../../components/Page";
import { type MessageKey, useI18n } from "../../i18n/i18n";
import { zoneOption } from "../../lib/timeSettings";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { type OrgPermissions, useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import {
  type AlertingStatus,
  type AlertState,
  contactPointsQuery,
  silencesQuery,
  statusQuery,
} from "./api";
import { policiesQuery, routingAvailable } from "./policies";
import { labelPairs } from "./ruleModel";
import "./alerting.css";

export interface AlertingContext {
  orgId: string;
  permissions: OrgPermissions;
  status: AlertingStatus | undefined;
  canWrite: boolean;
  canContacts: boolean;
}

/** The organization, the person's alerting rights and the status every page reads. */
export function useAlerting(): AlertingContext {
  const org = useCurrentOrg();
  const orgId = org?.id ?? "";
  const permissions = useOrgPermissions();
  const status = useQuery({
    ...statusQuery(orgId),
    enabled: org !== undefined && permissions.has("alerts:read"),
  });
  return {
    orgId,
    permissions,
    status: status.data,
    canWrite: permissions.has("alerts:write"),
    canContacts: permissions.has("alerts:contacts"),
  };
}

const STATE_KEYS: Record<AlertState | "paused" | "silenced", MessageKey> = {
  firing: "alerting.state.firing",
  pending: "alerting.state.pending",
  error: "alerting.state.error",
  no_data: "alerting.state.no_data",
  ok: "alerting.state.ok",
  paused: "alerting.state.paused",
  silenced: "alerting.state.silenced",
};

export function stateKey(state: AlertState | "paused" | "silenced"): MessageKey {
  return STATE_KEYS[state];
}

/**
 * A state as text with a dot; the color is only a hint next to the word (firing in the danger
 * tint, pending and error in the warning tint, the others neutral).
 */
export function StateLabel({
  state,
  quiet = false,
}: {
  state: AlertState | "paused" | "silenced";
  /** Only the dot and the word, without the tinted pill. */
  quiet?: boolean;
}) {
  const { t } = useI18n();
  return (
    <span className={quiet ? "alert-state alert-state--quiet" : "alert-state"} data-state={state}>
      <span className="alert-state__dot" aria-hidden="true" />
      {t(STATE_KEYS[state])}
    </span>
  );
}

/** Labels as small mono chips, `key=value`. */
export function LabelChips({ labels }: { labels: Readonly<Record<string, string>> }) {
  const pairs = labelPairs(labels);
  if (pairs.length === 0) {
    return null;
  }
  return (
    <span className="alert-labels">
      {pairs.map((pair) => (
        <span key={pair} className="alert-chip alert-chip--mono" translate="no">
          {pair}
        </span>
      ))}
    </span>
  );
}

/** Times as the board writes them: today as "13:41", other days with the date. */
export function useAlertTime(): (ms: number) => string {
  const { language, timeZone } = useI18n();
  const zone = zoneOption(timeZone);
  const time = new Intl.DateTimeFormat(language, { timeStyle: "short", ...zone });
  const dateTime = new Intl.DateTimeFormat(language, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...zone,
  });
  const day = new Intl.DateTimeFormat("en-CA", { dateStyle: "short", ...zone });
  return (ms: number) =>
    day.format(ms) === day.format(Date.now()) ? time.format(ms) : dateTime.format(ms);
}

/** "vor 12 s", "vor 4 min", "vor 2 h". */
export function useAgo(): (ms: number) => string {
  const { language } = useI18n();
  const format = new Intl.RelativeTimeFormat(language, { numeric: "always", style: "narrow" });
  return (ms: number) => {
    const secs = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (secs < 60) return format.format(-secs, "second");
    if (secs < 3600) return format.format(-Math.floor(secs / 60), "minute");
    if (secs < 86_400) return format.format(-Math.floor(secs / 3600), "hour");
    return format.format(-Math.floor(secs / 86_400), "day");
  };
}

type Tab = "rules" | "policies" | "contactPoints" | "silences" | "history";

const TABS: readonly { id: Tab; to: string; label: MessageKey }[] = [
  { id: "rules", to: "/alerting", label: "alerting.tab.rules" },
  { id: "policies", to: "/alerting/policies", label: "alerting.tab.policies" },
  { id: "contactPoints", to: "/alerting/contact-points", label: "alerting.tab.contactPoints" },
  { id: "silences", to: "/alerting/silences", label: "alerting.tab.silences" },
  { id: "history", to: "/alerting/history", label: "alerting.tab.history" },
];

const CRUMBS: Record<Tab, MessageKey> = {
  rules: "alerting.tab.rules",
  policies: "alerting.tab.policies",
  contactPoints: "alerting.tab.contactPoints",
  silences: "alerting.tab.silences",
  history: "alerting.tab.history",
};

/**
 * The frame of the four alerting pages (board frames 1, 8, 9, 10): heading with its lead, the
 * page's actions, the pages as links with their counts, and a note while alerting is off.
 */
export function AlertingLayout({
  tab,
  lead,
  actions,
  children,
}: {
  tab: Tab;
  lead: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const { t } = useI18n();
  useDocumentTitle(CRUMBS[tab]);
  const { orgId, permissions, status } = useAlerting();
  const readable = permissions.has("alerts:read");
  const points = useQuery({ ...contactPointsQuery(orgId), enabled: readable && orgId !== "" });
  const silences = useQuery({
    ...silencesQuery(orgId, "active"),
    enabled: readable && orgId !== "",
  });
  // Policies exist only on a server that has them (0.7.2); an older one is never asked.
  const routing = routingAvailable(status);
  const policies = useQuery({
    ...policiesQuery(orgId),
    enabled: readable && orgId !== "" && routing,
  });
  const counts: Partial<Record<Tab, number>> = {
    ...(status === undefined ? {} : { rules: status.rules }),
    ...(policies.data === undefined ? {} : { policies: policies.data.length }),
    ...(points.data === undefined ? {} : { contactPoints: points.data.length }),
    ...(silences.data === undefined ? {} : { silences: silences.data.length }),
  };
  const crumbs: Crumb[] = [
    { label: t("alerting.title"), link: { to: "/alerting" } },
    { label: t(CRUMBS[tab]) },
  ];
  if (permissions.loaded && !readable) {
    return (
      <Page title={t("alerting.title")}>
        <Breadcrumbs crumbs={crumbs} />
        <EmptyState icon="lock" title={t("alerting.forbidden.title")}>
          {t("alerting.forbidden.text")}
        </EmptyState>
      </Page>
    );
  }
  return (
    <Page title={t("alerting.title")} lead={lead}>
      <Breadcrumbs crumbs={crumbs} />
      {actions}
      <nav className="alert-tabs tabs" aria-label={t("alerting.tabs")}>
        {TABS.filter((item) => item.id !== "policies" || routing).map((item) => (
          <Link
            key={item.id}
            to={item.to}
            className="tabs__tab"
            activeOptions={{ exact: true, includeSearch: false }}
          >
            {t(item.label)}
            {counts[item.id] === undefined ? null : (
              <span className="tabs__count">{counts[item.id]}</span>
            )}
          </Link>
        ))}
      </nav>
      {status !== undefined && !status.enabled ? (
        <p className="alert-note" role="status">
          {t(status.serverEnabled ? "alerting.off.org" : "alerting.off.server")}
        </p>
      ) : null}
      {children}
    </Page>
  );
}

/**
 * A small set of buttons for one choice, as a radio group: the choice applies at once, arrow
 * keys move between the options, Tab reaches only the chosen one.
 */
export function Segmented({
  label,
  value,
  options,
  disabled = false,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string; mono?: boolean }[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  function move(to: number) {
    const next = (to + options.length) % options.length;
    refs.current[next]?.focus();
    const option = options[next];
    if (option !== undefined) onChange(option.value);
  }
  return (
    <div className="alert-seg" role="radiogroup" aria-label={label}>
      {options.map((option, i) => (
        // biome-ignore lint/a11y/useSemanticElements: radio buttons as buttons, so a choice applies at once
        <button
          key={option.value}
          ref={(element) => {
            refs.current[i] = element;
          }}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          tabIndex={i === index ? 0 : -1}
          disabled={disabled}
          className={
            option.mono === true ? "alert-seg__item alert-seg__item--mono" : "alert-seg__item"
          }
          onClick={() => onChange(option.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
              event.preventDefault();
              move(i + 1);
            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
              event.preventDefault();
              move(i - 1);
            }
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
