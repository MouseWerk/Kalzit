import { queryOptions } from "@tanstack/react-query";
import { isRecord } from "../../api/client";
import { orgPath, send } from "../datasources/api";
import { type AlertingStatus, alertingKeys } from "./api";
import {
  DEFAULT_POLICY_LIMITS,
  type Escalation,
  type MoveTarget,
  type Policy,
  type PolicyInput,
  type PolicyLimits,
  type PolicyMatcher,
} from "./policyModel";

/**
 * Notification policies of an organization (docs/api/alerting.md, "Notification policies"): the
 * tree as a flat list, saving one policy with its version, moving it, deleting it, the route
 * check and the active groups. The server checks every right; the UI only hides what a person may
 * not do.
 */

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const labelsOf = (value: unknown): Record<string, string> =>
  isRecord(value)
    ? Object.fromEntries(
        Object.entries(value).flatMap(([key, v]) => (typeof v === "string" ? [[key, v]] : [])),
      )
    : {};

/**
 * Whether this server has policies (0.7.2): its status names their limits. A server without them
 * gets no request to the policy routes; the pages and the rule editor stay as in 0.7.0.
 */
export function routingAvailable(status: AlertingStatus | undefined): boolean {
  return status?.routing === true;
}

export function policyLimits(status: AlertingStatus | undefined): PolicyLimits {
  return {
    ...DEFAULT_POLICY_LIMITS,
    ...(status?.policyLimits ?? {}),
    minIntervalSecs: Math.max(30, status?.limits.minIntervalSecs ?? 30),
  };
}

function parseMatcher(value: unknown): PolicyMatcher | null {
  if (!isRecord(value)) return null;
  const op =
    value.op === "!=" || value.op === "=~" || value.op === "!~" ? value.op : ("=" as const);
  return { label: str(value.label), op, value: str(value.value) };
}

function parseEscalation(value: unknown): Escalation | null {
  if (!isRecord(value)) return null;
  const wait = num(value.waitSecs);
  if (wait === null) return null;
  return { waitSecs: wait, contactPointIds: strings(value.contactPointIds) };
}

export function parsePolicy(value: unknown): Policy | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  return {
    id: value.id,
    parentId: typeof value.parentId === "string" && value.isRoot !== true ? value.parentId : null,
    position: num(value.position) ?? 0,
    name: str(value.name),
    matchers: Array.isArray(value.matchers)
      ? value.matchers.flatMap((item) => {
          const matcher = parseMatcher(item);
          return matcher === null ? [] : [matcher];
        })
      : [],
    contactPointIds: strings(value.contactPointIds),
    groupBy: Array.isArray(value.groupBy) ? strings(value.groupBy) : null,
    groupWaitSecs: num(value.groupWaitSecs),
    groupIntervalSecs: num(value.groupIntervalSecs),
    repeatIntervalSecs: num(value.repeatIntervalSecs),
    continue: value.continue === true,
    escalations: Array.isArray(value.escalations)
      ? value.escalations.flatMap((item) => {
          const step = parseEscalation(item);
          return step === null ? [] : [step];
        })
      : [],
    activeGroups: num(value.activeGroups) ?? 0,
    version: num(value.version) ?? 1,
    updatedAt: num(value.updatedAt) ?? 0,
    updatedByName: typeof value.updatedByName === "string" ? value.updatedByName : null,
  };
}

function parsePolicies(value: unknown): Policy[] {
  const items = isRecord(value) && Array.isArray(value.items) ? value.items : [];
  return items.flatMap((item) => {
    const policy = parsePolicy(item);
    return policy === null ? [] : [policy];
  });
}

function onePolicy(value: unknown): Policy {
  const policy = parsePolicy(value);
  if (policy === null) throw new TypeError("not a policy");
  return policy;
}

/** The request body: escalation steps carry their level (1, 2, 3 in order). */
function body(input: PolicyInput): Record<string, unknown> {
  return {
    ...input,
    escalations: input.escalations.map((step, index) => ({
      level: index + 1,
      waitSecs: step.waitSecs,
      contactPointIds: step.contactPointIds,
    })),
  };
}

const path = (orgId: string, ...segments: string[]) =>
  orgPath(orgId, "alerting", "policies", ...segments);

export async function fetchPolicies(orgId: string, signal?: AbortSignal): Promise<Policy[]> {
  return parsePolicies(await send("GET", path(orgId), undefined, signal));
}

export async function createPolicy(
  orgId: string,
  parentId: string,
  input: PolicyInput,
): Promise<Policy> {
  return onePolicy(await send("POST", path(orgId), { ...body(input), parentId }));
}

export async function updatePolicy(
  orgId: string,
  id: string,
  input: PolicyInput,
  version: number,
): Promise<Policy> {
  return onePolicy(await send("PUT", path(orgId, id), { ...body(input), version }));
}

/** Moves a policy at once; answers the whole tree. */
export async function movePolicy(orgId: string, id: string, target: MoveTarget): Promise<Policy[]> {
  return parsePolicies(await send("POST", path(orgId, id, "move"), target));
}

export async function deletePolicy(orgId: string, id: string): Promise<void> {
  await send("DELETE", path(orgId, id));
}

/** One way of a route check, as the server answers it. */
export interface CheckedRoute {
  policyId: string;
  path: { id: string; name: string }[];
  contactPointIds: string[];
  groupBy: string[];
  groupLabels: Record<string, string>;
  groupWaitSecs: number;
  groupIntervalSecs: number;
  repeatIntervalSecs: number;
  escalations: Escalation[];
  delivers: boolean;
}

export interface CheckedInstance {
  labels: Record<string, string>;
  /** The caller may not read the rule's source: `labels` are the rule's own and `alertname`. */
  dataHidden: boolean;
  fingerprint: string | null;
  routes: CheckedRoute[];
}

export function parseCheckedRoute(value: unknown): CheckedRoute | null {
  if (!isRecord(value) || typeof value.policyId !== "string") return null;
  return {
    policyId: value.policyId,
    path: Array.isArray(value.path)
      ? value.path.flatMap((step) =>
          isRecord(step) && typeof step.id === "string"
            ? [{ id: step.id, name: str(step.name) }]
            : [],
        )
      : [],
    contactPointIds: strings(value.contactPointIds),
    groupBy: strings(value.groupBy),
    groupLabels: labelsOf(value.groupLabels),
    groupWaitSecs: num(value.groupWaitSecs) ?? 0,
    groupIntervalSecs: num(value.groupIntervalSecs) ?? 0,
    repeatIntervalSecs: num(value.repeatIntervalSecs) ?? 0,
    escalations: Array.isArray(value.escalations)
      ? value.escalations.flatMap((item) => {
          const step = parseEscalation(item);
          return step === null ? [] : [step];
        })
      : [],
    delivers: value.delivers !== false,
  };
}

/** "Weg prüfen" on the server: label sets as they are, or a stored rule with its instances. */
export async function checkRoutes(
  orgId: string,
  input: { labels: Record<string, string>[] } | { ruleId: string },
  signal?: AbortSignal,
): Promise<CheckedInstance[]> {
  const answer = await send("POST", path(orgId, "route"), input, signal);
  const items = isRecord(answer) && Array.isArray(answer.items) ? answer.items : [];
  return items.flatMap((item) =>
    isRecord(item)
      ? [
          {
            labels: labelsOf(item.labels),
            dataHidden: item.dataHidden === true,
            fingerprint: typeof item.fingerprint === "string" ? item.fingerprint : null,
            routes: Array.isArray(item.routes)
              ? item.routes.flatMap((route) => {
                  const parsed = parseCheckedRoute(route);
                  return parsed === null ? [] : [parsed];
                })
              : [],
          },
        ]
      : [],
  );
}

/** An active group of a policy (docs/api/alerting.md, "Groups"). */
export interface AlertGroup {
  /** Null for a group with `dataHidden`: its id would tie it to the policy. */
  id: string | null;
  /** Null for a group with `dataHidden`: its policy was chosen by labels the caller may not see. */
  policyId: string | null;
  labels: Record<string, string>;
  catchAll: boolean;
  /** The caller may not read every rule's source in the group: `labels` are left out. */
  dataHidden: boolean;
  state: string;
  instances: number;
  firingInstances: number;
  createdAt: number;
  firingSince: number | null;
  nextSendAt: number | null;
  nextRepeatAt: number | null;
  escalationLevel: number | null;
  escalationPaused: boolean | null;
  nextEscalationAt: number | null;
}

/** The active groups the caller may see, and how many others there are (`hiddenGroups`). */
export interface GroupList {
  items: AlertGroup[];
  hiddenGroups: number;
}

function parseGroup(value: unknown): AlertGroup | null {
  if (!isRecord(value)) return null;
  return {
    id: typeof value.id === "string" ? value.id : null,
    policyId: typeof value.policyId === "string" ? value.policyId : null,
    labels: labelsOf(value.labels),
    catchAll: value.catchAll === true,
    dataHidden: value.dataHidden === true,
    state: str(value.state),
    instances: num(value.instances) ?? 0,
    firingInstances: num(value.firingInstances) ?? 0,
    createdAt: num(value.createdAt) ?? 0,
    firingSince: num(value.firingSince),
    nextSendAt: num(value.nextSendAt),
    nextRepeatAt: num(value.nextRepeatAt),
    escalationLevel: num(value.escalationLevel),
    escalationPaused: typeof value.escalationPaused === "boolean" ? value.escalationPaused : null,
    nextEscalationAt: num(value.nextEscalationAt),
  };
}

export async function fetchGroups(
  orgId: string,
  policyId: string | undefined,
  signal?: AbortSignal,
): Promise<GroupList> {
  const base = orgPath(orgId, "alerting", "groups");
  const answer = await send(
    "GET",
    policyId === undefined ? base : `${base}?policyId=${encodeURIComponent(policyId)}`,
    undefined,
    signal,
  );
  const items = isRecord(answer) && Array.isArray(answer.items) ? answer.items : [];
  return {
    items: items.flatMap((item) => {
      const group = parseGroup(item);
      return group === null ? [] : [group];
    }),
    hiddenGroups: isRecord(answer) ? (num(answer.hiddenGroups) ?? 0) : 0,
  };
}

export const policyKeys = {
  list: (orgId: string) => [...alertingKeys.all(orgId), "policies"] as const,
  groups: (orgId: string, policyId: string | undefined) =>
    [...alertingKeys.all(orgId), "groups", policyId ?? "all"] as const,
};

export function policiesQuery(orgId: string) {
  return queryOptions({
    queryKey: policyKeys.list(orgId),
    queryFn: ({ signal }) => fetchPolicies(orgId, signal),
    staleTime: 10_000,
  });
}

export function groupsQuery(orgId: string, policyId: string | undefined) {
  return queryOptions({
    queryKey: policyKeys.groups(orgId, policyId),
    queryFn: ({ signal }) => fetchGroups(orgId, policyId, signal),
    staleTime: 10_000,
    refetchInterval: 30_000,
  });
}
