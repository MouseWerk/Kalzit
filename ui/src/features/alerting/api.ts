import { queryOptions } from "@tanstack/react-query";
import { isApiError, isRecord } from "../../api/client";
import { orgPath, send } from "../datasources/api";

/**
 * Alerting of an organization (docs/api/alerting.md): rules with their instances, contact points,
 * silences, the history and the per source opt-in. The server checks every right; the UI only
 * hides what a person may not do.
 */

export const ALERT_STATES = ["firing", "error", "no_data", "pending", "ok"] as const;
export type AlertState = (typeof ALERT_STATES)[number];

export const FRAME_FUNCTIONS = ["last", "min", "max", "mean", "sum", "count"] as const;
export type FrameFunction = (typeof FRAME_FUNCTIONS)[number];
export const FIELD_FUNCTIONS = ["first", "min", "max", "mean", "sum"] as const;
export type FieldFunction = (typeof FIELD_FUNCTIONS)[number];
export const GRAPH_COUNTS = ["nodes", "edges", "paths"] as const;
export type GraphCount = (typeof GRAPH_COUNTS)[number];

export type Reduce =
  | { shape: "frame"; function: FrameFunction }
  | { shape: "documents"; mode: "count" }
  | { shape: "documents"; mode: "field"; path: string; function: FieldFunction }
  | { shape: "graph"; count: GraphCount; label?: string };

export const COMPARISONS = ["gt", "gte", "lt", "lte", "eq", "ne"] as const;
export type Comparison = (typeof COMPARISONS)[number];
export const RANGES = ["outside", "inside"] as const;
export type RangeOp = (typeof RANGES)[number];
export type ConditionOp = Comparison | RangeOp;

export type RangeCondition = { op: RangeOp; low: number; high: number };
export type Condition = { op: Comparison; value: number } | RangeCondition;

/** Whether a condition has two bounds (`outside`, `inside`) rather than one value. */
export function isRange(condition: Condition): condition is RangeCondition {
  return condition.op === "outside" || condition.op === "inside";
}

export type NoDataState = "no_data" | "ok" | "firing";
export type ErrorState = "error" | "keep";

/** Why an evaluation failed, as a code with parameters the UI translates. */
export interface AlertError {
  code: string;
  params?: Record<string, string>;
}

export interface RuleQuery {
  query: unknown;
  steps: unknown[];
  variables: Record<string, unknown>;
}

export interface RuleInput {
  name: string;
  description: string;
  runbookUrl: string | null;
  datasourceId: string;
  query: RuleQuery;
  rangeSecs: number;
  reduce: Reduce;
  condition: Condition;
  intervalSecs: number;
  forSecs: number;
  noDataState: NoDataState;
  errorState: ErrorState;
  labels: Record<string, string>;
  reminderSecs: number;
  contactPointIds: string[];
  dashboardId: string | null;
  panelId: string | null;
}

export interface Instance {
  fingerprint: string;
  labels: Record<string, string>;
  state: AlertState;
  stateSince: number;
  pendingSince: number | null;
  pendingTarget?: AlertState | null;
  lastEvaluatedAt: number | null;
  lastValue: number | null;
  lastError: AlertError | null;
  lastNotifiedAt: number | null;
  lastNotifiedState: string | null;
  silencedBy: string[];
}

export interface Rule extends Omit<RuleInput, "query"> {
  id: string;
  query: RuleQuery | null;
  queryHidden: boolean;
  paused: boolean;
  version: number;
  createdBy: string;
  createdAt: number;
  updatedBy: string;
  updatedByName?: string | null;
  updatedAt: number;
  lastEvaluatedAt: number | null;
  lastDurationMs: number | null;
  lastError: AlertError | null;
  skippedEvaluations: number;
  state: AlertState | null;
  instanceCounts: Partial<Record<AlertState, number>>;
  instances?: Instance[];
}

export interface AlertingLimits {
  minIntervalSecs: number;
  evaluationTimeoutSecs: number;
  maxRulesPerOrg: number;
  maxInstancesPerRule: number;
  maxContactPointsPerRule: number;
  maxSilencesPerOrg: number;
  historyRetentionDays: number;
}

export interface AlertingStatus {
  enabled: boolean;
  serverEnabled: boolean;
  orgEnabled: boolean;
  limits: AlertingLimits;
  mailConfigured: boolean;
  rules: number;
  pausedRules: number;
  instances: Partial<Record<AlertState, number>>;
}

export type ContactKind = "mail" | "webhook";

export interface ContactPoint {
  id: string;
  name: string;
  kind: ContactKind;
  language: "de" | "en";
  /** True when the caller may see the full recipients and URL (`alerts:contacts`). */
  details: boolean;
  recipients?: string[];
  host?: string;
  url?: string;
  insecure?: boolean;
  previousSecretUntil?: number | null;
  lastDelivery: { at: number; ok: boolean; error?: string | null } | null;
  rules: number;
  version: number;
  updatedAt: number;
}

export interface ContactPointInput {
  name: string;
  kind: ContactKind;
  language: "de" | "en";
  recipients?: string[];
  url?: string;
  version?: number;
}

export type MatcherOp = "=" | "!=" | "=~";
export interface Matcher {
  label: string;
  op: MatcherOp;
  value: string;
}

export type SilenceStatus = "pending" | "active" | "expired";

export interface Silence {
  id: string;
  matchers: Matcher[];
  startsAt: number;
  endsAt: number;
  comment: string;
  status: SilenceStatus;
  createdBy: string;
  createdByName: string | null;
  createdAt: number;
  endedBy: string | null;
  endedByName: string | null;
  endedAt: number | null;
}

export interface SilenceInput {
  matchers: Matcher[];
  startsAt?: number;
  endsAt: number;
  comment: string;
}

export interface AffectedInstance {
  ruleId: string;
  ruleName: string;
  fingerprint: string;
  labels: Record<string, string>;
  state: AlertState;
}

export interface HistoryEntry {
  id: string;
  ruleId: string;
  ruleName: string;
  fingerprint: string | null;
  labels: Record<string, string>;
  kind: "transition" | "delivery";
  fromState: AlertState | null;
  toState: AlertState | null;
  pendingTarget?: AlertState | null;
  value: number | null;
  error: AlertError | null;
  silenceId: string | null;
  reason?: string | null;
  contactPointId: string | null;
  event: string | null;
  attempt: number | null;
  result: string | null;
  at: number;
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface SourceAlerting {
  datasourceId: string;
  enabled: boolean;
  maxConcurrent: number | null;
  rules: number;
  firingRules: number;
}

export interface AlertingSource {
  datasourceId: string;
  name: string;
  kind: string;
}

/** One instance the preview would have now, in the rule's own words. */
export interface PreviewInstance {
  labels: Record<string, string>;
  value: number | null;
  state: AlertState;
  error?: AlertError | null;
}

/**
 * What "Jetzt auswerten" answers (the rule preview of the server): the result's shape with a short
 * description of it, and per instance the reduced value and the state it would have now.
 */
export interface Preview {
  evaluatedAt: number;
  durationMs: number | null;
  shape: string | null;
  /** Counts for the step "Abfrage": series and points, documents, nodes, edges and paths. */
  summary: Record<string, number>;
  instances: PreviewInstance[];
  error: AlertError | null;
  /** Hints of the reduce step (documents without the field, fields of text). */
  notes: AlertError[];
}

// ---- parsing ----------------------------------------------------------------------------------

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function labelsOf(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, v]) => (typeof v === "string" ? [[key, v]] : [])),
  );
}

export function isAlertState(value: unknown): value is AlertState {
  return typeof value === "string" && (ALERT_STATES as readonly string[]).includes(value);
}

export function evalErrorOf(value: unknown): AlertError | null {
  if (!isRecord(value) || typeof value.code !== "string") return null;
  const params = labelsOf(value.params);
  // Numbers in params are written as text, as the catalogs fill them.
  if (isRecord(value.params)) {
    for (const [key, v] of Object.entries(value.params)) {
      if (typeof v === "number") params[key] = String(v);
    }
  }
  return { code: value.code, params };
}

function countsOf(value: unknown): Partial<Record<AlertState, number>> {
  const out: Partial<Record<AlertState, number>> = {};
  if (!isRecord(value)) return out;
  for (const state of ALERT_STATES) {
    const n = num(value[state]);
    if (n !== null) out[state] = n;
  }
  return out;
}

function parseInstance(value: unknown): Instance | null {
  if (!isRecord(value) || !isAlertState(value.state)) return null;
  return {
    fingerprint: str(value.fingerprint),
    labels: labelsOf(value.labels),
    state: value.state,
    stateSince: num(value.stateSince) ?? 0,
    pendingSince: num(value.pendingSince),
    pendingTarget: isAlertState(value.pendingTarget) ? value.pendingTarget : null,
    lastEvaluatedAt: num(value.lastEvaluatedAt),
    lastValue: num(value.lastValue),
    lastError: evalErrorOf(value.lastError),
    lastNotifiedAt: num(value.lastNotifiedAt),
    lastNotifiedState: typeof value.lastNotifiedState === "string" ? value.lastNotifiedState : null,
    silencedBy: Array.isArray(value.silencedBy)
      ? value.silencedBy.filter((id): id is string => typeof id === "string")
      : [],
  };
}

export function parseRule(value: unknown): Rule {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new TypeError("not a rule");
  }
  const query = isRecord(value.query)
    ? {
        query: value.query.query,
        steps: Array.isArray(value.query.steps) ? value.query.steps : [],
        variables: isRecord(value.query.variables) ? value.query.variables : {},
      }
    : null;
  const rule: Rule = {
    id: value.id,
    name: str(value.name),
    description: str(value.description),
    runbookUrl: typeof value.runbookUrl === "string" ? value.runbookUrl : null,
    datasourceId: str(value.datasourceId),
    query,
    queryHidden: value.queryHidden === true,
    rangeSecs: num(value.rangeSecs) ?? 600,
    reduce: (isRecord(value.reduce)
      ? value.reduce
      : { shape: "frame", function: "last" }) as Reduce,
    condition: (isRecord(value.condition) ? value.condition : { op: "gt", value: 0 }) as Condition,
    intervalSecs: num(value.intervalSecs) ?? 60,
    forSecs: num(value.forSecs) ?? 0,
    noDataState: (value.noDataState as NoDataState) ?? "no_data",
    errorState: (value.errorState as ErrorState) ?? "error",
    labels: labelsOf(value.labels),
    reminderSecs: num(value.reminderSecs) ?? 0,
    paused: value.paused === true,
    contactPointIds: Array.isArray(value.contactPointIds)
      ? value.contactPointIds.filter((id): id is string => typeof id === "string")
      : [],
    dashboardId: typeof value.dashboardId === "string" ? value.dashboardId : null,
    panelId: typeof value.panelId === "string" ? value.panelId : null,
    version: num(value.version) ?? 1,
    createdBy: str(value.createdBy),
    createdAt: num(value.createdAt) ?? 0,
    updatedBy: str(value.updatedBy),
    updatedByName: typeof value.updatedByName === "string" ? value.updatedByName : null,
    updatedAt: num(value.updatedAt) ?? 0,
    lastEvaluatedAt: num(value.lastEvaluatedAt),
    lastDurationMs: num(value.lastDurationMs),
    lastError: evalErrorOf(value.lastError),
    skippedEvaluations: num(value.skippedEvaluations) ?? 0,
    state: isAlertState(value.state) ? value.state : null,
    instanceCounts: countsOf(value.instanceCounts),
  };
  if (Array.isArray(value.instances)) {
    rule.instances = value.instances.flatMap((item) => {
      const instance = parseInstance(item);
      return instance === null ? [] : [instance];
    });
  }
  return rule;
}

function parsePage<T>(value: unknown, item: (value: unknown) => T | null): Page<T> {
  if (!isRecord(value) || !Array.isArray(value.items)) {
    throw new TypeError("not a page");
  }
  return {
    items: value.items.flatMap((entry) => {
      const parsed = item(entry);
      return parsed === null ? [] : [parsed];
    }),
    nextCursor: typeof value.nextCursor === "string" ? value.nextCursor : null,
  };
}

function parseStatus(value: unknown): AlertingStatus {
  if (!isRecord(value)) throw new TypeError("not a status");
  const limits = isRecord(value.limits) ? value.limits : {};
  return {
    enabled: value.enabled === true,
    serverEnabled: value.serverEnabled !== false,
    orgEnabled: value.orgEnabled !== false,
    limits: {
      minIntervalSecs: num(limits.minIntervalSecs) ?? 30,
      evaluationTimeoutSecs: num(limits.evaluationTimeoutSecs) ?? 30,
      maxRulesPerOrg: num(limits.maxRulesPerOrg) ?? 500,
      maxInstancesPerRule: num(limits.maxInstancesPerRule) ?? 100,
      maxContactPointsPerRule: num(limits.maxContactPointsPerRule) ?? 5,
      maxSilencesPerOrg: num(limits.maxSilencesPerOrg) ?? 200,
      historyRetentionDays: num(limits.historyRetentionDays) ?? 90,
    },
    mailConfigured: value.mailConfigured === true,
    rules: num(value.rules) ?? 0,
    pausedRules: num(value.pausedRules) ?? 0,
    instances: countsOf(value.instances),
  };
}

function parseContactPoint(value: unknown): ContactPoint | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const delivery = isRecord(value.lastDelivery) ? value.lastDelivery : null;
  const point: ContactPoint = {
    id: value.id,
    name: str(value.name),
    kind: value.kind === "mail" ? "mail" : "webhook",
    language: value.language === "en" ? "en" : "de",
    details: value.details === true,
    lastDelivery:
      delivery === null
        ? null
        : {
            at: num(delivery.at) ?? 0,
            ok: delivery.ok === true,
            error: typeof delivery.error === "string" ? delivery.error : null,
          },
    rules: num(value.rules) ?? 0,
    version: num(value.version) ?? 1,
    updatedAt: num(value.updatedAt) ?? 0,
  };
  if (Array.isArray(value.recipients)) {
    point.recipients = value.recipients.filter((r): r is string => typeof r === "string");
  }
  if (typeof value.host === "string") point.host = value.host;
  if (typeof value.url === "string") point.url = value.url;
  if (typeof value.insecure === "boolean") point.insecure = value.insecure;
  if (value.previousSecretUntil !== undefined) {
    point.previousSecretUntil = num(value.previousSecretUntil);
  }
  return point;
}

function parseMatcher(value: unknown): Matcher | null {
  if (!isRecord(value)) return null;
  const op = value.op === "!=" || value.op === "=~" ? value.op : "=";
  return { label: str(value.label), op, value: str(value.value) };
}

function parseSilence(value: unknown): Silence | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const status = value.status === "pending" || value.status === "expired" ? value.status : "active";
  return {
    id: value.id,
    matchers: Array.isArray(value.matchers)
      ? value.matchers.flatMap((m) => {
          const matcher = parseMatcher(m);
          return matcher === null ? [] : [matcher];
        })
      : [],
    startsAt: num(value.startsAt) ?? 0,
    endsAt: num(value.endsAt) ?? 0,
    comment: str(value.comment),
    status,
    createdBy: str(value.createdBy),
    createdByName: typeof value.createdByName === "string" ? value.createdByName : null,
    createdAt: num(value.createdAt) ?? 0,
    endedBy: typeof value.endedBy === "string" ? value.endedBy : null,
    endedByName: typeof value.endedByName === "string" ? value.endedByName : null,
    endedAt: num(value.endedAt),
  };
}

function parseAffected(value: unknown): AffectedInstance | null {
  if (!isRecord(value) || !isAlertState(value.state)) return null;
  return {
    ruleId: str(value.ruleId),
    ruleName: str(value.ruleName),
    fingerprint: str(value.fingerprint),
    labels: labelsOf(value.labels),
    state: value.state,
  };
}

function parseHistory(value: unknown): HistoryEntry | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    ruleId: str(value.ruleId),
    ruleName: str(value.ruleName),
    fingerprint: typeof value.fingerprint === "string" ? value.fingerprint : null,
    labels: labelsOf(value.labels),
    kind: value.kind === "delivery" ? "delivery" : "transition",
    fromState: isAlertState(value.fromState) ? value.fromState : null,
    toState: isAlertState(value.toState) ? value.toState : null,
    pendingTarget: isAlertState(value.pendingTarget) ? value.pendingTarget : null,
    value: num(value.value),
    error: evalErrorOf(value.error),
    silenceId: typeof value.silenceId === "string" ? value.silenceId : null,
    reason: typeof value.reason === "string" ? value.reason : null,
    contactPointId: typeof value.contactPointId === "string" ? value.contactPointId : null,
    event: typeof value.event === "string" ? value.event : null,
    attempt: num(value.attempt),
    result: typeof value.result === "string" ? value.result : null,
    at: num(value.at) ?? 0,
  };
}

function parseSourceAlerting(value: unknown): SourceAlerting {
  if (!isRecord(value)) throw new TypeError("not a source opt-in");
  return {
    datasourceId: str(value.datasourceId),
    enabled: value.enabled === true,
    maxConcurrent: num(value.maxConcurrent),
    rules: num(value.rules) ?? 0,
    firingRules: num(value.firingRules) ?? 0,
  };
}

function parseAlertingSource(value: unknown): AlertingSource | null {
  if (!isRecord(value) || typeof value.datasourceId !== "string") return null;
  return { datasourceId: value.datasourceId, name: str(value.name), kind: str(value.kind) };
}

/** The preview as the server answers it; lenient, so a field added later does not break it. */
export function parsePreview(value: unknown): Preview {
  if (!isRecord(value)) throw new TypeError("not a preview");
  const summary: Record<string, number> = {};
  if (isRecord(value.summary)) {
    for (const [key, v] of Object.entries(value.summary)) {
      const n = num(v);
      if (n !== null) summary[key] = n;
    }
  }
  return {
    evaluatedAt: num(value.evaluatedAt) ?? Date.now(),
    durationMs: num(value.durationMs),
    shape: typeof value.shape === "string" ? value.shape : null,
    summary,
    instances: Array.isArray(value.instances)
      ? value.instances.flatMap((item) => {
          if (!isRecord(item) || !isAlertState(item.state)) return [];
          return [
            {
              labels: labelsOf(item.labels),
              value: num(item.value),
              state: item.state,
              error: evalErrorOf(item.error),
            },
          ];
        })
      : [],
    error: evalErrorOf(value.error),
    notes: Array.isArray(value.notes)
      ? value.notes.flatMap((note) => {
          const parsed = evalErrorOf(note);
          return parsed === null ? [] : [parsed];
        })
      : [],
  };
}

// ---- requests ---------------------------------------------------------------------------------

const path = (orgId: string, ...segments: string[]) => orgPath(orgId, "alerting", ...segments);

function withQuery(base: string, params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const text = query.toString();
  return text === "" ? base : `${base}?${text}`;
}

export async function fetchStatus(orgId: string, signal?: AbortSignal): Promise<AlertingStatus> {
  return parseStatus(await send("GET", path(orgId, "status"), undefined, signal));
}

export interface RuleFilter {
  datasourceId?: string;
  dashboardId?: string;
  panelId?: string;
}

export async function fetchRules(
  orgId: string,
  filter: RuleFilter = {},
  signal?: AbortSignal,
): Promise<Rule[]> {
  const page = parsePage(
    await send("GET", withQuery(path(orgId, "rules"), { ...filter }), undefined, signal),
    (item) => {
      try {
        return parseRule(item);
      } catch {
        return null;
      }
    },
  );
  return page.items;
}

export async function fetchRule(orgId: string, id: string, signal?: AbortSignal): Promise<Rule> {
  return parseRule(await send("GET", path(orgId, "rules", id), undefined, signal));
}

export async function createRule(orgId: string, input: RuleInput): Promise<Rule> {
  return parseRule(await send("POST", path(orgId, "rules"), input));
}

export async function updateRule(
  orgId: string,
  id: string,
  input: RuleInput,
  version: number,
): Promise<Rule> {
  return parseRule(await send("PUT", path(orgId, "rules", id), { ...input, version }));
}

export async function deleteRule(orgId: string, id: string): Promise<void> {
  await send("DELETE", path(orgId, "rules", id));
}

export async function setRulePaused(orgId: string, id: string, paused: boolean): Promise<Rule> {
  return parseRule(await send("POST", path(orgId, "rules", id, paused ? "pause" : "resume")));
}

/** "Jetzt auswerten": the rule as edited, run with the editing person's rights, nothing stored. */
export async function previewRule(
  orgId: string,
  input: RuleInput,
  signal?: AbortSignal,
): Promise<Preview> {
  return parsePreview(await send("POST", path(orgId, "rules", "preview"), input, signal));
}

/** The server has no preview route yet (an older server), so the editor says so instead. */
export function previewMissing(error: unknown): boolean {
  return isApiError(error) && (error.status === 404 || error.status === 405);
}

export async function fetchContactPoints(
  orgId: string,
  signal?: AbortSignal,
): Promise<ContactPoint[]> {
  return parsePage(
    await send("GET", path(orgId, "contact-points"), undefined, signal),
    parseContactPoint,
  ).items;
}

export async function createContactPoint(
  orgId: string,
  input: ContactPointInput,
): Promise<{ point: ContactPoint; secret: string | null }> {
  const body = await send("POST", path(orgId, "contact-points"), input);
  const point = parseContactPoint(body);
  if (point === null) throw new TypeError("not a contact point");
  return { point, secret: isRecord(body) && typeof body.secret === "string" ? body.secret : null };
}

export async function updateContactPoint(
  orgId: string,
  id: string,
  input: ContactPointInput,
): Promise<ContactPoint> {
  const point = parseContactPoint(await send("PUT", path(orgId, "contact-points", id), input));
  if (point === null) throw new TypeError("not a contact point");
  return point;
}

export async function deleteContactPoint(orgId: string, id: string): Promise<void> {
  await send("DELETE", path(orgId, "contact-points", id));
}

export async function rotateSecret(
  orgId: string,
  id: string,
): Promise<{ secret: string; previousSecretUntil: number | null }> {
  const body = await send("POST", path(orgId, "contact-points", id, "secret"));
  return {
    secret: isRecord(body) ? str(body.secret) : "",
    previousSecretUntil: isRecord(body) ? num(body.previousSecretUntil) : null,
  };
}

export interface TestResult {
  ok: boolean;
  status: number | null;
  durationMs: number | null;
  error: string | null;
}

/** Sends the sample message ("Testsenden"); at most 5 a minute per contact point. */
export async function testContactPoint(orgId: string, id: string): Promise<TestResult> {
  const body = await send("POST", path(orgId, "contact-points", id, "test"));
  const value = isRecord(body) ? body : {};
  return {
    ok: value.ok !== false && value.result !== "failed",
    status: num(value.status) ?? num(value.httpStatus),
    durationMs: num(value.durationMs),
    error:
      typeof value.error === "string"
        ? value.error
        : typeof value.result === "string" && value.result !== "ok"
          ? value.result
          : null,
  };
}

export async function fetchSilences(
  orgId: string,
  status: SilenceStatus | undefined,
  signal?: AbortSignal,
): Promise<Silence[]> {
  return parsePage(
    await send(
      "GET",
      withQuery(path(orgId, "silences"), { status, limit: 200 }),
      undefined,
      signal,
    ),
    parseSilence,
  ).items;
}

export async function createSilence(orgId: string, input: SilenceInput): Promise<Silence> {
  const silence = parseSilence(await send("POST", path(orgId, "silences"), input));
  if (silence === null) throw new TypeError("not a silence");
  return silence;
}

export async function previewSilence(
  orgId: string,
  matchers: Matcher[],
  signal?: AbortSignal,
): Promise<AffectedInstance[]> {
  return parsePage(
    await send("POST", path(orgId, "silences", "preview"), { matchers }, signal),
    parseAffected,
  ).items;
}

export async function expireSilence(orgId: string, id: string): Promise<Silence> {
  const silence = parseSilence(await send("POST", path(orgId, "silences", id, "expire")));
  if (silence === null) throw new TypeError("not a silence");
  return silence;
}

export interface HistoryFilter {
  ruleId?: string;
  state?: AlertState;
  label?: string;
  kind?: "transition" | "delivery";
  from?: number;
  to?: number;
  limit?: number;
  cursor?: string;
}

export async function fetchHistory(
  orgId: string,
  filter: HistoryFilter,
  signal?: AbortSignal,
): Promise<Page<HistoryEntry>> {
  return parsePage(
    await send("GET", withQuery(path(orgId, "history"), { ...filter }), undefined, signal),
    parseHistory,
  );
}

export async function fetchSourceAlerting(
  orgId: string,
  datasourceId: string,
  signal?: AbortSignal,
): Promise<SourceAlerting> {
  return parseSourceAlerting(
    await send("GET", orgPath(orgId, "datasources", datasourceId, "alerting"), undefined, signal),
  );
}

export async function saveSourceAlerting(
  orgId: string,
  datasourceId: string,
  input: { enabled: boolean; maxConcurrent?: number | null },
): Promise<SourceAlerting> {
  return parseSourceAlerting(
    await send("PUT", orgPath(orgId, "datasources", datasourceId, "alerting"), input),
  );
}

export async function fetchAlertingSources(
  orgId: string,
  signal?: AbortSignal,
): Promise<AlertingSource[]> {
  return parsePage(
    await send("GET", path(orgId, "datasources"), undefined, signal),
    parseAlertingSource,
  ).items;
}

// ---- query options ----------------------------------------------------------------------------

export const ALERTING_KEY = "alerting";

export const alertingKeys = {
  all: (orgId: string) => [ALERTING_KEY, orgId] as const,
  status: (orgId: string) => [ALERTING_KEY, orgId, "status"] as const,
  rules: (orgId: string, filter: RuleFilter = {}) =>
    [ALERTING_KEY, orgId, "rules", filter] as const,
  rule: (orgId: string, id: string) => [ALERTING_KEY, orgId, "rule", id] as const,
  contactPoints: (orgId: string) => [ALERTING_KEY, orgId, "contact-points"] as const,
  silences: (orgId: string, status?: SilenceStatus) =>
    [ALERTING_KEY, orgId, "silences", status ?? "all"] as const,
  history: (orgId: string, filter: HistoryFilter) =>
    [ALERTING_KEY, orgId, "history", filter] as const,
  sources: (orgId: string) => [ALERTING_KEY, orgId, "sources"] as const,
  source: (orgId: string, datasourceId: string) =>
    [ALERTING_KEY, orgId, "source", datasourceId] as const,
};

/** States change with every evaluation; lists refresh about as often as the shortest interval. */
const REFRESH_MS = 30_000;

export function statusQuery(orgId: string) {
  return queryOptions({
    queryKey: alertingKeys.status(orgId),
    queryFn: ({ signal }) => fetchStatus(orgId, signal),
    staleTime: REFRESH_MS,
    refetchInterval: REFRESH_MS,
  });
}

export function rulesQuery(orgId: string, filter: RuleFilter = {}) {
  return queryOptions({
    queryKey: alertingKeys.rules(orgId, filter),
    queryFn: ({ signal }) => fetchRules(orgId, filter, signal),
    staleTime: 10_000,
    refetchInterval: REFRESH_MS,
  });
}

export function ruleQuery(orgId: string, id: string) {
  return queryOptions({
    queryKey: alertingKeys.rule(orgId, id),
    queryFn: ({ signal }) => fetchRule(orgId, id, signal),
  });
}

export function contactPointsQuery(orgId: string) {
  return queryOptions({
    queryKey: alertingKeys.contactPoints(orgId),
    queryFn: ({ signal }) => fetchContactPoints(orgId, signal),
    staleTime: 10_000,
  });
}

export function silencesQuery(orgId: string, status?: SilenceStatus) {
  return queryOptions({
    queryKey: alertingKeys.silences(orgId, status),
    queryFn: ({ signal }) => fetchSilences(orgId, status, signal),
    staleTime: 10_000,
  });
}

export function historyQuery(orgId: string, filter: HistoryFilter) {
  return queryOptions({
    queryKey: alertingKeys.history(orgId, filter),
    queryFn: ({ signal }) => fetchHistory(orgId, filter, signal),
    staleTime: 10_000,
  });
}

export function alertingSourcesQuery(orgId: string) {
  return queryOptions({
    queryKey: alertingKeys.sources(orgId),
    queryFn: ({ signal }) => fetchAlertingSources(orgId, signal),
    staleTime: 60_000,
  });
}

export function sourceAlertingQuery(orgId: string, datasourceId: string) {
  return queryOptions({
    queryKey: alertingKeys.source(orgId, datasourceId),
    queryFn: ({ signal }) => fetchSourceAlerting(orgId, datasourceId, signal),
  });
}
