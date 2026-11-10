import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { appRoute } from "../../app/baseRoutes";
import { ALERT_STATES, type AlertState } from "./api";

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

export interface RulesSearch {
  /** Only rules in this state; `paused` for the paused ones. */
  state?: AlertState | "paused" | undefined;
  /** Only the rules on this data source ("Regeln ansehen" at a source). */
  source?: string | undefined;
}

export interface NewRuleSearch {
  /** "Alert-Regel erstellen" from a panel: its query, variables and range are copied. */
  dashboard?: string | undefined;
  panel?: string | undefined;
  /** "Duplizieren": the rule the new one starts from. */
  from?: string | undefined;
}

export interface SilencesSearch {
  /** Opens the dialog with conditions from an instance: the rule and these labels. */
  rule?: string | undefined;
  fingerprint?: string | undefined;
  /** Opens an empty dialog. */
  create?: boolean | undefined;
  expired?: boolean | undefined;
}

export interface HistorySearch {
  rule?: string | undefined;
  state?: AlertState | undefined;
  label?: string | undefined;
  /** Hours back from now. */
  hours?: number | undefined;
}

const isState = (value: unknown): value is AlertState =>
  typeof value === "string" && (ALERT_STATES as readonly string[]).includes(value);

const rulesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/alerting",
  validateSearch: (search: Record<string, unknown>): RulesSearch => ({
    state: search.state === "paused" ? "paused" : isState(search.state) ? search.state : undefined,
    source: text(search.source),
  }),
  component: lazyRouteComponent(() => import("./RulesPage"), "RulesPage"),
});

const newRuleRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/alerting/rules/new",
  validateSearch: (search: Record<string, unknown>): NewRuleSearch => ({
    dashboard: text(search.dashboard),
    panel: text(search.panel),
    from: text(search.from),
  }),
  component: lazyRouteComponent(() => import("./RuleEditorPage"), "NewRulePage"),
});

const editRuleRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/alerting/rules/$ruleId",
  component: lazyRouteComponent(() => import("./RuleEditorPage"), "EditRulePage"),
});

const contactPointsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/alerting/contact-points",
  component: lazyRouteComponent(() => import("./ContactPointsPage"), "ContactPointsPage"),
});

const silencesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/alerting/silences",
  validateSearch: (search: Record<string, unknown>): SilencesSearch => ({
    rule: text(search.rule),
    fingerprint: text(search.fingerprint),
    create: search.create === true || search.create === "true" ? true : undefined,
    expired: search.expired === true || search.expired === "true" ? true : undefined,
  }),
  component: lazyRouteComponent(() => import("./SilencesPage"), "SilencesPage"),
});

const historyRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/alerting/history",
  validateSearch: (search: Record<string, unknown>): HistorySearch => {
    const hours = Number(search.hours);
    return {
      rule: text(search.rule),
      state: isState(search.state) ? search.state : undefined,
      label: text(search.label),
      hours: Number.isInteger(hours) && hours > 0 && hours <= 24 * 90 ? hours : undefined,
    };
  },
  component: lazyRouteComponent(() => import("./HistoryPage"), "HistoryPage"),
});

export const alertingRoutes = [
  rulesRoute,
  newRuleRoute,
  editRuleRoute,
  contactPointsRoute,
  silencesRoute,
  historyRoute,
] as const;
