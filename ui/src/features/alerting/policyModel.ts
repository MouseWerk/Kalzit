/**
 * The notification policy tree (docs/PLAN.md, section 13, "0.7.2"; board AlertingRouting.dc.html):
 * the tree built from the flat list the server answers, what a policy inherits from above, the
 * way an instance takes through the tree, the moves of the row menu and the checks of the policy
 * form. Pure logic, so it is tested without the pages.
 */

export type PolicyMatcherOp = "=" | "!=" | "=~" | "!~";

export interface PolicyMatcher {
  label: string;
  op: PolicyMatcherOp;
  value: string;
}

/** "Jede Instanz einzeln": a group per instance. */
export const EACH_INSTANCE = "...";

export interface Escalation {
  /** Wait since the group began firing. */
  waitSecs: number;
  contactPointIds: string[];
}

export interface Policy {
  id: string;
  /** Null only for the root ("Standard"). */
  parentId: string | null;
  /** Position among the siblings, from 0. */
  position: number;
  name: string;
  matchers: PolicyMatcher[];
  contactPointIds: string[];
  /** Null inherits; empty puts all instances in one group; `["..."]` makes one group each. */
  groupBy: string[] | null;
  groupWaitSecs: number | null;
  groupIntervalSecs: number | null;
  /** Null inherits; 0 is "aus". */
  repeatIntervalSecs: number | null;
  continue: boolean;
  escalations: Escalation[];
  /** Groups of this policy that have instances now. */
  activeGroups: number;
  version: number;
  updatedAt: number;
  updatedByName: string | null;
}

export interface PolicyNode {
  policy: Policy;
  children: PolicyNode[];
  parent: PolicyNode | null;
  /** 0 for the root. */
  depth: number;
}

/** The tree from the flat list; null when there is no root. Children in their order. */
export function buildTree(policies: readonly Policy[]): PolicyNode | null {
  const rootPolicy = policies.find((policy) => policy.parentId === null);
  if (rootPolicy === undefined) return null;
  const byParent = new Map<string, Policy[]>();
  for (const policy of policies) {
    if (policy.parentId === null) continue;
    const list = byParent.get(policy.parentId) ?? [];
    list.push(policy);
    byParent.set(policy.parentId, list);
  }
  const build = (policy: Policy, parent: PolicyNode | null, depth: number): PolicyNode => {
    const node: PolicyNode = { policy, children: [], parent, depth };
    const children = [...(byParent.get(policy.id) ?? [])].sort(
      (a, b) => a.position - b.position || a.name.localeCompare(b.name),
    );
    // A cycle in the answer would never end; a node is visited once.
    node.children = children
      .filter((child) => child.id !== policy.id)
      .map((child) => build(child, node, depth + 1));
    return node;
  };
  return build(rootPolicy, null, 0);
}

/** Every node in tree order (depth first, children in their order). */
export function walk(root: PolicyNode | null): PolicyNode[] {
  if (root === null) return [];
  const out: PolicyNode[] = [];
  const visit = (node: PolicyNode) => {
    out.push(node);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return out;
}

export function findNode(root: PolicyNode | null, id: string): PolicyNode | undefined {
  return walk(root).find((node) => node.policy.id === id);
}

/** The rows the tree shows: every node whose ancestors are all open. */
export function visibleRows(root: PolicyNode | null, collapsed: ReadonlySet<string>): PolicyNode[] {
  if (root === null) return [];
  const out: PolicyNode[] = [];
  const visit = (node: PolicyNode) => {
    out.push(node);
    if (collapsed.has(node.policy.id)) return;
    for (const child of node.children) visit(child);
  };
  visit(root);
  return out;
}

/** The names from the root down to this node: "Standard › Lager › Lager kritisch". */
export function pathOf(node: PolicyNode): Policy[] {
  const out: Policy[] = [];
  for (let at: PolicyNode | null = node; at !== null; at = at.parent) out.unshift(at.policy);
  return out;
}

export function descendants(node: PolicyNode): PolicyNode[] {
  return walk(node).slice(1);
}

// ---- inheritance ------------------------------------------------------------------------------

/** A value as it applies, with the policy it comes from when that is not the policy itself. */
export interface Effective<T> {
  value: T;
  /** The policy the value is inherited from; null when the policy sets it itself. */
  from: Policy | null;
}

type Inheritable = "groupBy" | "groupWaitSecs" | "groupIntervalSecs" | "repeatIntervalSecs";

/** Defaults of the root, in case the server answered a root without a value (it never should). */
export const ROOT_DEFAULTS = {
  groupBy: ["alertname"],
  groupWaitSecs: 30,
  groupIntervalSecs: 300,
  repeatIntervalSecs: 14_400,
} as const;

export function effectiveValue<K extends Inheritable>(
  node: PolicyNode,
  key: K,
): Effective<NonNullable<Policy[K]>> {
  for (let at: PolicyNode | null = node; at !== null; at = at.parent) {
    const value = at.policy[key];
    if (value !== null) {
      return {
        value: value as NonNullable<Policy[K]>,
        from: at === node ? null : at.policy,
      };
    }
  }
  return {
    value: ROOT_DEFAULTS[key] as unknown as NonNullable<Policy[K]>,
    from: null,
  };
}

/** Contact points are inherited only while a policy has none of its own. */
export function effectiveContactPoints(node: PolicyNode): Effective<string[]> {
  for (let at: PolicyNode | null = node; at !== null; at = at.parent) {
    if (at.policy.contactPointIds.length > 0) {
      return { value: at.policy.contactPointIds, from: at === node ? null : at.policy };
    }
  }
  return { value: [], from: null };
}

/** The conditions of the ancestors, which hold as well for an instance to get here. */
export function inheritedMatchers(node: PolicyNode): { policy: Policy; matcher: PolicyMatcher }[] {
  const out: { policy: Policy; matcher: PolicyMatcher }[] = [];
  for (let at = node.parent; at !== null; at = at.parent) {
    for (const matcher of at.policy.matchers) out.unshift({ policy: at.policy, matcher });
  }
  return out;
}

// ---- routing ----------------------------------------------------------------------------------

/** Whether one condition holds for these labels; a missing label counts as empty. */
export function matcherHolds(matcher: PolicyMatcher, labels: Readonly<Record<string, string>>) {
  const value = labels[matcher.label] ?? "";
  switch (matcher.op) {
    case "=":
      return value === matcher.value;
    case "!=":
      return value !== matcher.value;
    default: {
      let test: boolean;
      try {
        // Always over the whole value, as on the server.
        test = new RegExp(`^(?:${matcher.value})$`, "u").test(value);
      } catch {
        return false;
      }
      return matcher.op === "=~" ? test : !test;
    }
  }
}

export function policyMatches(policy: Policy, labels: Readonly<Record<string, string>>) {
  return policy.parentId === null || policy.matchers.every((m) => matcherHolds(m, labels));
}

/**
 * The ways an instance with these labels takes: from the root, the first matching child takes
 * over (and further ones while a match has "weiter prüfen" on); each way ends at the deepest
 * matching policy. The server decides; this is the same rule for showing it in the UI.
 */
export function routesFor(
  root: PolicyNode | null,
  labels: Readonly<Record<string, string>>,
): PolicyNode[] {
  if (root === null) return [];
  const out: PolicyNode[] = [];
  const descend = (node: PolicyNode) => {
    let matched = false;
    for (const child of node.children) {
      if (!policyMatches(child.policy, labels)) continue;
      matched = true;
      descend(child);
      if (!child.policy.continue) break;
    }
    if (!matched) out.push(node);
  };
  descend(root);
  return out;
}

/**
 * Siblings before a policy that match these labels and stop the search (no "weiter prüfen"):
 * why a policy whose own conditions hold is still not reached.
 */
export function blockedBy(
  node: PolicyNode,
  labels: Readonly<Record<string, string>>,
): Policy | null {
  const parent = node.parent;
  if (parent === null) return null;
  for (const sibling of parent.children) {
    if (sibling === node) return null;
    if (policyMatches(sibling.policy, labels) && !sibling.policy.continue) return sibling.policy;
  }
  return null;
}

// ---- moves ------------------------------------------------------------------------------------

export type Move = "up" | "down" | "indent" | "outdent";

export interface MoveTarget {
  parentId: string;
  position: number;
}

/**
 * Where a move puts a policy: up and down swap with a sibling, indent makes it the last child of
 * the sibling before, outdent puts it right after its parent. Null when the move is not possible
 * (the root, the first or last sibling, no sibling before, already under the root, or deeper than
 * `maxDepth` below the root).
 */
export function moveTarget(node: PolicyNode, move: Move, maxDepth: number): MoveTarget | null {
  const parent = node.parent;
  if (parent === null) return null;
  const index = parent.children.indexOf(node);
  switch (move) {
    case "up":
      return index > 0 ? { parentId: parent.policy.id, position: index - 1 } : null;
    case "down":
      return index < parent.children.length - 1
        ? { parentId: parent.policy.id, position: index + 1 }
        : null;
    case "indent": {
      const before = parent.children[index - 1];
      if (before === undefined) return null;
      if (before.depth + 1 + subtreeHeight(node) > maxDepth) return null;
      return { parentId: before.policy.id, position: before.children.length };
    }
    case "outdent": {
      const grand = parent.parent;
      if (grand === null) return null;
      return { parentId: grand.policy.id, position: grand.children.indexOf(parent) + 1 };
    }
  }
}

/** How many levels a subtree has below its own node (0 for a leaf). */
function subtreeHeight(node: PolicyNode): number {
  return node.children.reduce((max, child) => Math.max(max, 1 + subtreeHeight(child)), 0);
}

/** Whether a new child under this node stays within the depth limit. */
export function canAddChild(node: PolicyNode, maxDepth: number): boolean {
  return node.depth + 1 <= maxDepth;
}

/** The flat list after a move, as the tree shows it before the server answers. */
export function applyMove(policies: readonly Policy[], id: string, target: MoveTarget): Policy[] {
  const moving = policies.find((policy) => policy.id === id);
  if (moving === undefined) return [...policies];
  const siblingsOf = (parentId: string, without: string) =>
    policies
      .filter((policy) => policy.parentId === parentId && policy.id !== without)
      .sort((a, b) => a.position - b.position);
  const positions = new Map<string, { parentId: string | null; position: number }>();
  const old = moving.parentId;
  if (old !== null) {
    siblingsOf(old, id).forEach((policy, index) => {
      positions.set(policy.id, { parentId: old, position: index });
    });
  }
  const next = siblingsOf(target.parentId, id);
  next.splice(Math.min(target.position, next.length), 0, moving);
  next.forEach((policy, index) => {
    positions.set(policy.id, { parentId: target.parentId, position: index });
  });
  return policies.map((policy) => {
    const at = positions.get(policy.id);
    return at === undefined ? policy : { ...policy, ...at };
  });
}

// ---- the form ---------------------------------------------------------------------------------

export interface PolicyLimits {
  maxPolicies: number;
  maxDepth: number;
  maxMatchers: number;
  maxGroupBy: number;
  maxContactPoints: number;
  maxEscalations: number;
  minIntervalSecs: number;
}

export const DEFAULT_POLICY_LIMITS: PolicyLimits = {
  maxPolicies: 100,
  maxDepth: 5,
  maxMatchers: 10,
  maxGroupBy: 10,
  maxContactPoints: 5,
  maxEscalations: 3,
  minIntervalSecs: 30,
};

export type GroupMode = "inherit" | "labels" | "all" | "each";

export interface PolicyDraft {
  name: string;
  matchers: PolicyMatcher[];
  contactPointIds: string[];
  groupMode: GroupMode;
  groupBy: string[];
  groupWaitSecs: number | null;
  groupIntervalSecs: number | null;
  repeatIntervalSecs: number | null;
  continue: boolean;
  escalations: Escalation[];
}

export function groupModeOf(groupBy: string[] | null): GroupMode {
  if (groupBy === null) return "inherit";
  if (groupBy.length === 0) return "all";
  if (groupBy.length === 1 && groupBy[0] === EACH_INSTANCE) return "each";
  return "labels";
}

export function draftOf(policy: Policy | null): PolicyDraft {
  if (policy === null) {
    return {
      name: "",
      matchers: [{ label: "", op: "=", value: "" }],
      contactPointIds: [],
      groupMode: "inherit",
      groupBy: [],
      groupWaitSecs: null,
      groupIntervalSecs: null,
      repeatIntervalSecs: null,
      continue: false,
      escalations: [],
    };
  }
  const mode = groupModeOf(policy.groupBy);
  return {
    name: policy.name,
    matchers: policy.matchers.map((matcher) => ({ ...matcher })),
    contactPointIds: [...policy.contactPointIds],
    groupMode: mode,
    groupBy: mode === "labels" ? [...(policy.groupBy ?? [])] : [],
    groupWaitSecs: policy.groupWaitSecs,
    groupIntervalSecs: policy.groupIntervalSecs,
    repeatIntervalSecs: policy.repeatIntervalSecs,
    continue: policy.continue,
    escalations: policy.escalations.map((step) => ({
      waitSecs: step.waitSecs,
      contactPointIds: [...step.contactPointIds],
    })),
  };
}

export function groupByOf(draft: PolicyDraft): string[] | null {
  switch (draft.groupMode) {
    case "inherit":
      return null;
    case "all":
      return [];
    case "each":
      return [EACH_INSTANCE];
    case "labels":
      return draft.groupBy.map((label) => label.trim()).filter((label) => label !== "");
  }
}

/** The request body of a policy (docs/api/alerting.md, "Policies"). */
export interface PolicyInput {
  name: string;
  matchers: PolicyMatcher[];
  contactPointIds: string[];
  groupBy: string[] | null;
  groupWaitSecs: number | null;
  groupIntervalSecs: number | null;
  repeatIntervalSecs: number | null;
  continue: boolean;
  escalations: Escalation[];
}

export function inputOfPolicy(draft: PolicyDraft, isRoot: boolean): PolicyInput {
  return {
    name: draft.name.trim(),
    matchers: isRoot
      ? []
      : draft.matchers
          .map((matcher) => ({ ...matcher, label: matcher.label.trim() }))
          .filter((matcher) => matcher.label !== ""),
    contactPointIds: draft.contactPointIds,
    groupBy: groupByOf(draft),
    groupWaitSecs: draft.groupWaitSecs,
    groupIntervalSecs: draft.groupIntervalSecs,
    repeatIntervalSecs: draft.repeatIntervalSecs,
    continue: isRoot ? false : draft.continue,
    escalations: draft.escalations,
  };
}

export type PolicyField =
  | "name"
  | "matchers"
  | "contactPointIds"
  | "groupBy"
  | "groupWaitSecs"
  | "groupIntervalSecs"
  | "repeatIntervalSecs"
  | "escalations";

export interface PolicyProblem {
  key: string;
  params?: Record<string, string | number>;
}

export type PolicyErrors = Partial<Record<PolicyField, PolicyProblem>>;

const LABEL = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MIN_ESCALATION_SECS = 300;
export const MAX_ESCALATION_SECS = 86_400;
export const MAX_GROUP_WAIT_SECS = 3600;
export const MAX_GROUP_INTERVAL_SECS = 86_400;
export const MAX_REPEAT_SECS = 7 * 86_400;

function regexValid(pattern: string): boolean {
  try {
    new RegExp(pattern, "u");
    return true;
  } catch {
    return false;
  }
}

/**
 * The checks the server makes too: a name unique among the siblings, valid conditions, times in
 * their ranges with the repeat not shorter than the interval (with inherited values counted),
 * and escalation steps that each come later than the one before.
 */
export function validatePolicy(
  draft: PolicyDraft,
  context: {
    isRoot: boolean;
    siblingNames: readonly string[];
    inheritedIntervalSecs: number;
    inheritedRepeatSecs: number;
    limits: PolicyLimits;
  },
): PolicyErrors {
  const errors: PolicyErrors = {};
  const { limits } = context;
  const name = draft.name.trim();
  if (name === "") {
    errors.name = { key: "alerting.policies.error.nameRequired" };
  } else if (name.length > 100) {
    errors.name = { key: "alerting.policies.error.nameLong", params: { max: 100 } };
  } else if (
    // Unique among the siblings without regard to case, as on the server.
    context.siblingNames.some((other) => other.trim().toLowerCase() === name.toLowerCase())
  ) {
    errors.name = { key: "alerting.policies.error.nameTaken", params: { name } };
  }
  if (!context.isRoot) {
    const used = draft.matchers.filter((m) => m.label.trim() !== "" || m.value !== "");
    if (used.length > limits.maxMatchers) {
      errors.matchers = {
        key: "alerting.policies.error.tooManyMatchers",
        params: { max: limits.maxMatchers },
      };
    } else {
      const bad = used.find((m) => !LABEL.test(m.label.trim()));
      const badRegex = used.find((m) => (m.op === "=~" || m.op === "!~") && !regexValid(m.value));
      if (bad !== undefined) {
        errors.matchers = {
          key: "alerting.policies.error.matcherLabel",
          params: { label: bad.label.trim() },
        };
      } else if (badRegex !== undefined) {
        errors.matchers = {
          key: "alerting.policies.error.matcherRegex",
          params: { label: badRegex.label.trim() },
        };
      }
    }
  }
  if (draft.contactPointIds.length > limits.maxContactPoints) {
    errors.contactPointIds = {
      key: "alerting.policies.error.tooManyContactPoints",
      params: { max: limits.maxContactPoints },
    };
  }
  if (draft.groupMode === "labels") {
    const labels = groupByOf(draft) ?? [];
    if (labels.length === 0) {
      errors.groupBy = { key: "alerting.policies.error.groupByEmpty" };
    } else if (labels.length > limits.maxGroupBy) {
      errors.groupBy = {
        key: "alerting.policies.error.tooManyGroupBy",
        params: { max: limits.maxGroupBy },
      };
    } else {
      const bad = labels.find((label) => !LABEL.test(label));
      if (bad !== undefined) {
        errors.groupBy = { key: "alerting.policies.error.matcherLabel", params: { label: bad } };
      }
    }
  } else if (draft.groupMode === "inherit" && context.isRoot) {
    errors.groupBy = { key: "alerting.policies.error.rootInherits" };
  }
  if (context.isRoot) {
    for (const field of ["groupWaitSecs", "groupIntervalSecs", "repeatIntervalSecs"] as const) {
      if (draft[field] === null) errors[field] = { key: "alerting.policies.error.rootInherits" };
    }
  }
  if (draft.groupWaitSecs !== null && (draft.groupWaitSecs < 0 || draft.groupWaitSecs > 3600)) {
    errors.groupWaitSecs = { key: "alerting.policies.error.groupWait" };
  }
  const interval = draft.groupIntervalSecs ?? context.inheritedIntervalSecs;
  if (
    draft.groupIntervalSecs !== null &&
    (draft.groupIntervalSecs < Math.max(30, limits.minIntervalSecs) ||
      draft.groupIntervalSecs > MAX_GROUP_INTERVAL_SECS)
  ) {
    errors.groupIntervalSecs = {
      key: "alerting.policies.error.groupInterval",
      params: { min: Math.max(30, limits.minIntervalSecs) },
    };
  }
  const repeat = draft.repeatIntervalSecs ?? context.inheritedRepeatSecs;
  if (repeat !== 0 && (repeat < interval || repeat > MAX_REPEAT_SECS)) {
    errors.repeatIntervalSecs = {
      key: "alerting.policies.error.repeat",
      params: { interval },
    };
  }
  if (draft.escalations.length > limits.maxEscalations) {
    errors.escalations = {
      key: "alerting.policies.error.tooManySteps",
      params: { max: limits.maxEscalations },
    };
  } else {
    let before = 0;
    draft.escalations.forEach((step, index) => {
      if (errors.escalations !== undefined) return;
      const level = index + 1;
      if (step.waitSecs < MIN_ESCALATION_SECS || step.waitSecs > MAX_ESCALATION_SECS) {
        errors.escalations = { key: "alerting.policies.error.stepWait", params: { level } };
      } else if (step.waitSecs <= before) {
        errors.escalations = { key: "alerting.policies.error.stepOrder", params: { level } };
      } else if (
        step.contactPointIds.length === 0 ||
        step.contactPointIds.length > limits.maxContactPoints
      ) {
        errors.escalations = {
          key: "alerting.policies.error.stepContacts",
          params: { level, max: limits.maxContactPoints },
        };
      }
      before = step.waitSecs;
    });
  }
  return errors;
}

/** "30 s", "5 min", "4 h", "2 d": the short form of the tree's times column. */
export function shortDuration(secs: number): string {
  if (secs >= 86_400 && secs % 86_400 === 0) return `${secs / 86_400} d`;
  if (secs >= 3600 && secs % 3600 === 0) return `${secs / 3600} h`;
  if (secs >= 60 && secs % 60 === 0) return `${secs / 60} min`;
  return `${secs} s`;
}

/** Choices of the time fields, from the board's examples and the plan's ranges. */
export const GROUP_WAIT_CHOICES = [0, 10, 30, 60, 120, 300, 600, 1800, 3600] as const;
export const GROUP_INTERVAL_CHOICES = [
  30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21_600, 43_200, 86_400,
] as const;
export const REPEAT_CHOICES = [
  0, 300, 900, 1800, 3600, 7200, 14_400, 28_800, 43_200, 86_400, 172_800, 604_800,
] as const;
export const ESCALATION_CHOICES = [
  300, 600, 900, 1200, 1800, 2700, 3600, 7200, 14_400, 28_800, 43_200, 86_400,
] as const;
