import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { translate } from "../../i18n/i18n";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { PG_ID } from "../datasources/test/fakeDatasources";
import type { Rule } from "./api";
import {
  applyMove,
  blockedBy,
  buildTree,
  DEFAULT_POLICY_LIMITS,
  draftOf,
  EACH_INSTANCE,
  effectiveContactPoints,
  effectiveValue,
  findNode,
  groupModeOf,
  inputOfPolicy,
  moveTarget,
  type Policy,
  routesFor,
  validatePolicy,
  visibleRows,
} from "./policyModel";
import { emptyDraft, inputOf } from "./ruleModel";
import { FAKE_STATUS_ON, FAKE_STATUS_ROUTING, fakePolicy, fakeRoot } from "./test/fakeAlerting";

const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate("en", key, params ?? {});

function policy(
  id: string,
  parentId: string | null,
  position: number,
  patch: Partial<Policy> = {},
): Policy {
  return {
    id,
    parentId,
    position,
    name: id,
    matchers: [],
    contactPointIds: [],
    groupBy: parentId === null ? ["alertname"] : null,
    groupWaitSecs: parentId === null ? 30 : null,
    groupIntervalSecs: parentId === null ? 300 : null,
    repeatIntervalSecs: parentId === null ? 14_400 : null,
    continue: false,
    escalations: [],
    activeGroups: 0,
    version: 1,
    updatedAt: 0,
    updatedByName: null,
    ...patch,
  };
}

/** The board's tree: Standard > Lager > (Lager kritisch, Lager-API Nacht), Tickets, Vertrieb. */
const TREE: Policy[] = [
  policy("root", null, 0, { name: "Standard", contactPointIds: ["mailbox"] }),
  policy("lager", "root", 0, {
    name: "Lager",
    matchers: [{ label: "team", op: "=", value: "lager" }],
    contactPointIds: ["oncall", "slack"],
    groupBy: ["alertname", "team"],
  }),
  policy("kritisch", "lager", 0, {
    name: "Lager kritisch",
    matchers: [
      { label: "severity", op: "=", value: "kritisch" },
      { label: "instance", op: "!~", value: "lager-api-test.*" },
    ],
    contactPointIds: ["slack"],
    groupWaitSecs: 0,
    groupIntervalSecs: 120,
    repeatIntervalSecs: 3600,
  }),
  policy("nacht", "lager", 1, {
    name: "Lager-API Nacht",
    matchers: [{ label: "alertname", op: "=~", value: "Lager-API.*" }],
  }),
  policy("tickets", "root", 1, {
    name: "Tickets für Kritisches",
    matchers: [{ label: "severity", op: "=~", value: "kritisch|hoch" }],
    continue: true,
    contactPointIds: ["tickets"],
  }),
  policy("vertrieb", "root", 2, {
    name: "Vertrieb",
    matchers: [{ label: "team", op: "=", value: "vertrieb" }],
  }),
];

const root = () => buildTree(TREE);
const node = (id: string) => {
  const found = findNode(root(), id);
  if (found === undefined) throw new Error(id);
  return found;
};

describe("policy tree logic", () => {
  it("builds the tree in sibling order with depths", () => {
    const shuffled = [...TREE].reverse();
    const tree = buildTree(shuffled);
    expect(tree?.children.map((child) => child.policy.id)).toEqual([
      "lager",
      "tickets",
      "vertrieb",
    ]);
    expect(findNode(tree, "kritisch")?.depth).toBe(2);
    expect(visibleRows(tree, new Set(["lager"])).map((row) => row.policy.id)).toEqual([
      "root",
      "lager",
      "tickets",
      "vertrieb",
    ]);
  });

  it("names where an inherited value comes from, and none for the policy's own", () => {
    const kritisch = node("kritisch");
    expect(effectiveValue(kritisch, "groupBy")).toEqual({
      value: ["alertname", "team"],
      from: expect.objectContaining({ id: "lager" }),
    });
    expect(effectiveValue(kritisch, "groupIntervalSecs")).toEqual({ value: 120, from: null });
    const nacht = node("nacht");
    expect(effectiveValue(nacht, "repeatIntervalSecs").value).toBe(14_400);
    expect(effectiveValue(nacht, "repeatIntervalSecs").from?.id).toBe("root");
  });

  it("inherits contact points only while a policy has none of its own", () => {
    expect(effectiveContactPoints(node("kritisch"))).toEqual({ value: ["slack"], from: null });
    expect(effectiveContactPoints(node("nacht")).value).toEqual(["oncall", "slack"]);
    expect(effectiveContactPoints(node("nacht")).from?.id).toBe("lager");
  });

  it("takes the first matching child and goes on after one with continue", () => {
    const ways = (labels: Record<string, string>) =>
      routesFor(root(), labels).map((end) => end.policy.id);
    const labels = { alertname: "Lager-API Latenz p95", team: "lager", severity: "kritisch" };
    // Siblings are checked in order; "Lager" (without continue) stops the search at its level.
    expect(ways(labels)).toEqual(["kritisch"]);
    // Without team, "Tickets" matches and continues; nothing after it matches, so one way.
    expect(ways({ alertname: "x", severity: "hoch" })).toEqual(["tickets"]);
    // A test instance is excluded from "Lager kritisch" and lands at "Lager-API Nacht".
    expect(
      ways({
        alertname: "Lager-API Latenz",
        team: "lager",
        severity: "kritisch",
        instance: "lager-api-test-1",
      }),
    ).toEqual(["nacht"]);
    // Nothing below matches: the instance stays at the root.
    expect(ways({ alertname: "x", team: "einkauf" })).toEqual(["root"]);
  });

  it("explains a policy that matches but is not reached", () => {
    const labels = { alertname: "Lager-API Latenz", team: "lager", severity: "kritisch" };
    expect(blockedBy(node("nacht"), labels)?.id).toBe("kritisch");
    expect(blockedBy(node("kritisch"), labels)).toBeNull();
  });

  it("moves with the row menu and refuses impossible moves", () => {
    expect(moveTarget(node("tickets"), "up", 5)).toEqual({ parentId: "root", position: 0 });
    expect(moveTarget(node("lager"), "up", 5)).toBeNull();
    expect(moveTarget(node("vertrieb"), "down", 5)).toBeNull();
    expect(moveTarget(node("tickets"), "indent", 5)).toEqual({ parentId: "lager", position: 2 });
    expect(moveTarget(node("lager"), "indent", 5)).toBeNull();
    expect(moveTarget(node("nacht"), "outdent", 5)).toEqual({ parentId: "root", position: 1 });
    expect(moveTarget(node("lager"), "outdent", 5)).toBeNull();
    expect(moveTarget(node("root"), "down", 5)).toBeNull();
    // "Lager" has a level below it: indenting it under nothing deeper than 1 is refused.
    expect(moveTarget(node("tickets"), "indent", 1)).toBeNull();
  });

  it("applies a move to the flat list and closes up the old siblings", () => {
    const moved = applyMove(TREE, "kritisch", { parentId: "root", position: 1 });
    const tree = buildTree(moved);
    expect(tree?.children.map((child) => child.policy.id)).toEqual([
      "lager",
      "kritisch",
      "tickets",
      "vertrieb",
    ]);
    expect(findNode(tree, "nacht")?.policy.position).toBe(0);
  });

  it("checks the form as the server does, with inherited times counted", () => {
    const context = {
      isRoot: false,
      siblingNames: ["Tickets für Kritisches"],
      inheritedIntervalSecs: 300,
      inheritedRepeatSecs: 14_400,
      limits: DEFAULT_POLICY_LIMITS,
    };
    const draft = { ...draftOf(null), name: "Tickets für Kritisches", repeatIntervalSecs: 60 };
    const errors = validatePolicy(draft, context);
    expect(errors.name?.key).toBe("alerting.policies.error.nameTaken");
    expect(errors.repeatIntervalSecs).toEqual({
      key: "alerting.policies.error.repeat",
      params: { interval: 300 },
    });
    const steps = validatePolicy(
      {
        ...draftOf(null),
        name: "Lager",
        escalations: [
          { waitSecs: 900, contactPointIds: ["a"] },
          { waitSecs: 600, contactPointIds: ["b"] },
        ],
      },
      context,
    );
    expect(steps.escalations).toEqual({
      key: "alerting.policies.error.stepOrder",
      params: { level: 2 },
    });
    // The root sets every time itself.
    const rootErrors = validatePolicy(
      { ...draftOf(TREE[0] ?? null), groupWaitSecs: null },
      { ...context, isRoot: true, siblingNames: [] },
    );
    expect(rootErrors.groupWaitSecs?.key).toBe("alerting.policies.error.rootInherits");
  });

  it("turns the draft into the documented body", () => {
    const kritisch = TREE[2] as Policy;
    expect(inputOfPolicy(draftOf(kritisch), false)).toEqual({
      name: "Lager kritisch",
      matchers: kritisch.matchers,
      contactPointIds: ["slack"],
      groupBy: null,
      groupWaitSecs: 0,
      groupIntervalSecs: 120,
      repeatIntervalSecs: 3600,
      continue: false,
      escalations: [],
    });
    expect(groupModeOf([EACH_INSTANCE])).toBe("each");
    expect(groupModeOf([])).toBe("all");
    // The root never sends matchers or continue.
    const rootInput = inputOfPolicy(
      {
        ...draftOf(TREE[0] ?? null),
        matchers: [{ label: "a", op: "=", value: "b" }],
        continue: true,
      },
      true,
    );
    expect(rootInput.matchers).toEqual([]);
    expect(rootInput.continue).toBe(false);
  });

  it("sends routing only to a server with policies, and contact points only for direct rules", () => {
    const draft = { ...emptyDraft(), name: "R", contactPointIds: ["cp1"] };
    expect(inputOf(draft)).not.toHaveProperty("routing");
    expect(inputOf(draft).contactPointIds).toEqual(["cp1"]);
    expect(inputOf(draft, true)).toMatchObject({ routing: "policies", contactPointIds: [] });
    expect(inputOf({ ...draft, routing: "direct" }, true)).toMatchObject({
      routing: "direct",
      contactPointIds: ["cp1"],
    });
  });
});

const POINTS = [
  {
    id: "mailbox",
    name: "Team-Postfach",
    kind: "mail",
    language: "de",
    recipients: ["lager@mousewerk.test"],
    lastDelivery: null,
    rules: 0,
    policies: 1,
    version: 1,
    updatedAt: 0,
  },
  {
    id: "slack",
    name: "#lager-alerts",
    kind: "slack",
    language: "de",
    host: "hooks.slack.com",
    urlEnd: "9Qx2",
    lastDelivery: null,
    rules: 0,
    policies: 2,
    version: 1,
    updatedAt: 0,
  },
];

function open(
  path: string,
  role: string,
  setup?: (server: ReturnType<typeof installFakeServer>) => void,
) {
  const server = installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "MouseWerk", role }] },
  });
  server.areas.alerting.status = { ...FAKE_STATUS_ROUTING };
  server.areas.alerting.contactPoints = POINTS.map((point) => ({ ...point }));
  server.areas.alerting.policies = [
    fakeRoot({ contactPointIds: ["mailbox"] }),
    fakePolicy("p-lager", "org-root", 0, {
      name: "Lager",
      matchers: [{ label: "team", op: "=", value: "lager" }],
      contactPointIds: ["slack"],
    }),
    fakePolicy("p-vertrieb", "org-root", 1, {
      name: "Vertrieb",
      matchers: [{ label: "team", op: "=", value: "vertrieb" }],
      escalations: [{ level: 1, waitSecs: 900, contactPointIds: ["mailbox"] }],
    }),
  ];
  setup?.(server);
  return { server, ...renderApp(path) };
}

describe("Policies page", () => {
  it("shows admins the tree with inherited values as a word, and moves by keyboard with undo", async () => {
    const { server, user } = open("/alerting/policies", "admin");
    const tree = await screen.findByRole("tree", { name: t("alerting.policies.treeLabel") });
    const rows = await within(tree).findAllByRole("treeitem");
    expect(rows.map((row) => row.getAttribute("aria-level"))).toEqual(["1", "2", "2"]);
    const vertrieb = within(tree).getByRole("treeitem", {
      name: /^Vertrieb, under “Standard”, position 2 of 2/,
    });
    // Times it does not set read "inherited", never only paler.
    expect(within(vertrieb).getAllByText(t("alerting.policies.inherited")).length).toBeGreaterThan(
      1,
    );
    expect(within(vertrieb).getByText(t("alerting.policies.stepsOne"))).toBeTruthy();
    expect(screen.getByRole("link", { name: t("alerting.policies.add") })).toBeTruthy();

    vertrieb.focus();
    fireEvent.keyDown(vertrieb, { key: "ArrowUp", altKey: true });
    await waitFor(() =>
      expect(server.areas.alerting.policyRequests.at(-1)).toMatchObject({
        method: "POST",
        body: { parentId: "org-root", position: 0 },
      }),
    );
    const undo = await screen.findByRole("button", { name: /Undo/ });
    expect(screen.getByText(t("alerting.policies.moved.up", { name: "Vertrieb" }))).toBeTruthy();
    await user.click(undo);
    await waitFor(() =>
      expect(server.areas.alerting.policyRequests.at(-1)).toMatchObject({
        body: { parentId: "org-root", position: 1 },
      }),
    );
  });

  it("deletes a policy with what is below it after saying what happens", async () => {
    const { server, user } = open("/alerting/policies", "admin", (s) => {
      s.areas.alerting.policies.push(
        fakePolicy("p-kritisch", "p-lager", 0, { name: "Lager kritisch", activeGroups: 2 }),
      );
    });
    await user.click(await screen.findByRole("button", { name: "Actions for “Lager”" }));
    await user.click(
      await screen.findByRole("menuitem", { name: t("alerting.policies.menu.delete") }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Delete “Lager”?" });
    expect(within(dialog).getByText(/The policy below it is deleted with it\./)).toBeTruthy();
    expect(within(dialog).getByText(/Its 2 active groups end;/)).toBeTruthy();
    await user.click(
      within(dialog).getByRole("button", { name: t("alerting.policies.menu.delete") }),
    );
    await waitFor(() =>
      expect(server.areas.alerting.policies.map((p) => p.id)).toEqual(["org-root", "p-vertrieb"]),
    );
    // One call: the server deletes the policies below with it.
    const deletes = server.areas.alerting.policyRequests.filter((r) => r.method === "DELETE");
    expect(deletes.map((r) => r.route.split("/").at(-1))).toEqual(["p-lager"]);
  });

  it("shows editors the tree read-only, with the checker", async () => {
    const { user } = open("/alerting/policies", "editor");
    const tree = await screen.findByRole("tree");
    await within(tree).findAllByRole("treeitem");
    expect(screen.getByText(/^View only\./)).toBeTruthy();
    expect(screen.queryByRole("link", { name: t("alerting.policies.add") })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Actions for/ })).toBeNull();
    expect(screen.queryByTitle(t("alerting.policies.drag"))).toBeNull();
    // Contact points by name and kind; no recipients or URLs.
    expect(within(tree).getAllByText("#lager-alerts").length).toBeGreaterThan(0);
    expect(screen.queryByText(/hooks\.slack\.com/)).toBeNull();

    const labels = screen.getByLabelText(t("alerting.policies.check.labels"));
    await user.type(labels, "team=lager");
    const result = await screen.findByText(t("alerting.policies.check.ways", { count: 1 }));
    expect(result).toBeTruthy();
    expect(screen.getAllByText("Lager").length).toBeGreaterThan(1);
  });

  it("lets the root set everything itself, without inheriting or conditions", async () => {
    const { server, user } = open("/alerting/policies/org-root", "admin");
    expect(await screen.findByDisplayValue("Standard")).toBeTruthy();
    const group = screen.getByRole("radiogroup", { name: t("alerting.policies.groupBy") });
    expect(
      within(group).queryByRole("radio", { name: t("alerting.policies.group.inherit") }),
    ).toBeNull();
    expect(screen.getByText(t("alerting.policies.rootMatchesAll"))).toBeTruthy();
    expect(screen.queryByRole("switch", { name: t("alerting.policies.continueLabel") })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(server.areas.alerting.policyRequests.at(-1)).toMatchObject({
        method: "PUT",
        body: { name: "Standard", matchers: [], continue: false, groupBy: ["alertname"] },
      }),
    );
  });

  it("opens a policy read-only for viewers", async () => {
    open("/alerting/policies/p-lager", "viewer");
    expect(await screen.findByDisplayValue("Lager")).toBeTruthy();
    expect(screen.getByText(t("alerting.policies.readOnlyDetail"))).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    expect(screen.queryByRole("button", { name: t("alerting.policies.menu.delete") })).toBeNull();
  });

  it("saves a policy with its escalation steps numbered", async () => {
    const { server, user } = open("/alerting/policies/p-vertrieb", "admin");
    const name = await screen.findByDisplayValue("Vertrieb");
    await user.type(name, " Nord");
    // The group wait is inherited and says from what.
    expect(screen.getByText(/Inherited \(30 s\)/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(server.areas.alerting.policyRequests.at(-1)).toMatchObject({
        method: "PUT",
        body: {
          name: "Vertrieb Nord",
          version: 1,
          groupWaitSecs: null,
          escalations: [{ level: 1, waitSecs: 900, contactPointIds: ["mailbox"] }],
        },
      }),
    );
  });

  it("asks a server without policies for none, and shows no tab", async () => {
    const { server } = open("/alerting", "admin", (s) => {
      s.areas.alerting.status = { ...FAKE_STATUS_ON };
      const { routing: _routing, routes: _routes, ...older } = RULE;
      s.areas.alerting.rules = [older];
    });
    expect(await screen.findByRole("link", { name: "Lager-API Latenz p95" })).toBeTruthy();
    await waitFor(() =>
      expect(server.calls.some((call) => call.path.endsWith("/alerting/status"))).toBe(true),
    );
    expect(screen.queryByRole("link", { name: /^Policies/ })).toBeNull();
    expect(server.calls.some((call) => call.path.includes("/alerting/policies"))).toBe(false);
    expect(
      screen.getByRole("columnheader", { name: t("alerting.rules.column.contactPoints") }),
    ).toBeTruthy();
  });
});

const RULE: Partial<Rule> & Record<string, unknown> = {
  id: "r1",
  name: "Lager-API Latenz p95",
  description: "",
  runbookUrl: null,
  datasourceId: PG_ID,
  query: { query: { sql: "SELECT 1" }, steps: [], variables: {} },
  queryHidden: false,
  rangeSecs: 600,
  reduce: { shape: "frame", function: "max" },
  condition: { op: "gt", value: 1.5 },
  intervalSecs: 60,
  forSecs: 0,
  noDataState: "no_data",
  errorState: "error",
  labels: { team: "lager" },
  reminderSecs: 14_400,
  paused: false,
  contactPointIds: [],
  routing: "policies",
  routes: [
    {
      policyId: "p-lager",
      path: [
        { id: "org-root", name: "Standard" },
        { id: "p-lager", name: "Lager" },
      ],
      contactPointIds: ["slack"],
      delivers: true,
      instances: 1,
    },
    {
      policyId: "p-tickets",
      path: [
        { id: "org-root", name: "Standard" },
        { id: "p-tickets", name: "Tickets" },
      ],
      contactPointIds: [],
      delivers: true,
      instances: 1,
    },
  ],
  dashboardId: null,
  panelId: null,
  version: 3,
  createdBy: "u1",
  createdAt: 0,
  updatedBy: "u1",
  updatedByName: "Ada Lovelace",
  updatedAt: 0,
  lastEvaluatedAt: null,
  lastDurationMs: null,
  lastError: null,
  skippedEvaluations: 0,
  state: "ok",
  instanceCounts: { ok: 1 },
};

describe("Routing in rules", () => {
  it("shows the way of each rule in the list", async () => {
    open("/alerting", "viewer", (s) => {
      s.areas.alerting.rules = [
        RULE,
        {
          ...RULE,
          id: "r2",
          name: "Direkte Regel",
          routing: "direct",
          routes: [],
          contactPointIds: ["mailbox", "slack"],
        },
      ];
    });
    expect(
      await screen.findByRole("columnheader", { name: t("alerting.routing.way") }),
    ).toBeTruthy();
    const first = (await screen.findByRole("link", { name: "Lager-API Latenz p95" })).closest("tr");
    expect(within(first as HTMLElement).getByText("Standard › Lager")).toBeTruthy();
    expect(within(first as HTMLElement).getByText(t("alerting.routing.moreOne"))).toBeTruthy();
    const second = screen.getByRole("link", { name: "Direkte Regel" }).closest("tr");
    expect(within(second as HTMLElement).getByText(t("alerting.routing.directShort"))).toBeTruthy();
    expect(
      within(second as HTMLElement).getByText(t("alerting.routing.contacts", { count: 2 })),
    ).toBeTruthy();
  });

  it("hides the rule's contact points and reminder through policies, and shows the ways", async () => {
    const { user, server } = open("/alerting/rules/r1", "editor", (s) => {
      s.areas.alerting.rules = [RULE];
      s.areas.alerting.sources = [{ datasourceId: PG_ID, name: "Sales DB", kind: "postgres" }];
    });
    const routing = await screen.findByRole("radiogroup", { name: t("alerting.routing.label") });
    expect(
      within(routing).getByRole("radio", { name: t("alerting.routing.policies") }),
    ).toHaveProperty("ariaChecked", "true");
    expect(screen.queryByLabelText(t("alerting.editor.reminder"))).toBeNull();
    expect(await screen.findByText("Standard › Lager")).toBeTruthy();
    // Editors cannot add a policy for the rule.
    expect(screen.queryByRole("link", { name: t("alerting.routing.ownPolicy") })).toBeNull();

    await user.click(
      within(routing).getByRole("radio", { name: t("alerting.routing.directLabel") }),
    );
    expect(await screen.findByLabelText(t("alerting.editor.reminder"))).toBeTruthy();
    expect(
      await screen.findByText(/Switched to “Through policies” it would go to: #lager-alerts/),
    ).toBeTruthy();
    await user.click(screen.getByRole("checkbox", { name: /Team-Postfach/ }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(server.areas.alerting.saved.at(-1)).toMatchObject({
        routing: "direct",
        contactPointIds: ["mailbox"],
      }),
    );
  });
});

describe("Review changes of the server (0.7.2)", () => {
  it("shows a name taken on the level, without case, at the name field", async () => {
    const { server, user } = open("/alerting/policies/new", "admin");
    const name = await screen.findByLabelText(t("alerting.editor.name"), { exact: true });
    await user.type(name, "lager");
    await user.click(screen.getByRole("button", { name: "Save" }));
    // Checked before sending, as the server does, without regard to case.
    expect(
      await screen.findByText(t("alerting.policies.error.nameTaken", { name: "lager" })),
    ).toBeTruthy();
    expect(server.areas.alerting.policyRequests).toEqual([]);
  });

  it("names the policy and stage of a group's delivery in the history", async () => {
    open("/alerting/history", "viewer", (s) => {
      s.areas.alerting.history = [
        {
          id: "h1",
          ruleId: "r1",
          ruleName: "Lager-API Latenz p95",
          fingerprint: "f1",
          labels: {},
          kind: "delivery",
          fromState: null,
          toState: null,
          value: null,
          error: null,
          silenceId: null,
          reason: null,
          contactPointId: "slack",
          event: "escalation",
          attempt: 1,
          result: "ok",
          policyId: "p-lager",
          groupId: "g1",
          stage: "e2",
          at: Date.now() - 60_000,
        },
      ];
    });
    expect(
      await screen.findByText(
        t("alerting.history.viaPolicy", {
          name: "Lager",
          stage: t("alerting.history.stage.escalation", { level: "2" }),
        }),
      ),
    ).toBeTruthy();
    expect(screen.getByText(t("alerting.history.event.escalation"))).toBeTruthy();
  });
});

describe("Groups and deliveries with hidden data", () => {
  const hiddenGroup = {
    id: null,
    policyId: null,
    labels: {},
    dataHidden: true,
    catchAll: false,
    state: "firing",
    instances: 2,
    firingInstances: 2,
    silencedInstances: 0,
    createdAt: 1,
    firingSince: 1,
    lastSentAt: 1,
    nextSendAt: null,
    nextRepeatAt: null,
    repeats: null,
    escalationLevel: null,
    escalationPaused: null,
    nextEscalationAt: null,
  };

  it("counts hidden groups once, tied to no policy", async () => {
    open("/alerting/policies", "editor", (s) => {
      s.areas.alerting.groups = [hiddenGroup, { ...hiddenGroup, createdAt: 2 }];
      s.areas.alerting.hiddenGroups = 2;
    });
    expect(await screen.findByText(t("alerting.policies.hiddenGroups", { count: 2 }))).toBeTruthy();
  });

  it("leaves hidden groups out of a policy's active groups", async () => {
    open("/alerting/policies/p-lager", "viewer", (s) => {
      s.areas.alerting.groups = [
        {
          ...hiddenGroup,
          id: "g1",
          policyId: "p-lager",
          dataHidden: false,
          labels: { team: "lager" },
          escalationLevel: 1,
          escalationPaused: false,
        },
        hiddenGroup,
      ];
      s.areas.alerting.hiddenGroups = 1;
    });
    expect(await screen.findByText("team=lager")).toBeTruthy();
    expect(screen.queryByText(t("alerting.policies.groupHidden"))).toBeNull();
    expect(screen.queryByText(/hidden group/)).toBeNull();
  });

  it("names no policy for a hidden delivery of a group", async () => {
    open("/alerting/history", "viewer", (s) => {
      s.areas.alerting.history = [
        {
          id: "h2",
          ruleId: "r1",
          ruleName: "Lager-API Latenz p95",
          fingerprint: "hidden-0",
          labels: {},
          dataHidden: true,
          kind: "delivery",
          fromState: null,
          toState: null,
          value: null,
          error: null,
          silenceId: null,
          reason: null,
          contactPointId: null,
          event: "firing",
          attempt: 1,
          result: "ok",
          policyId: null,
          groupId: null,
          stage: null,
          at: Date.now() - 60_000,
        },
      ];
    });
    expect(
      await screen.findByText(
        t("alerting.history.delivered", { name: t("alerting.history.hiddenPoint") }),
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/^Policy “/)).toBeNull();
  });

  it("says that a hidden rule's way follows only its own labels", async () => {
    open("/alerting", "viewer", (s) => {
      s.areas.alerting.rules = [{ ...RULE, dataHidden: true }];
    });
    expect(await screen.findByText(t("alerting.routing.hiddenWayShort"))).toBeTruthy();
  });
});

describe("Slack and Teams contact points", () => {
  it("refuses a URL that is not https at the field and saves a Slack channel", async () => {
    const { server, user } = open("/alerting/contact-points", "admin");
    await user.click(await screen.findByRole("button", { name: t("alerting.contact.add") }));
    const dialog = await screen.findByRole("dialog", { name: t("alerting.contact.newTitle") });
    await user.click(within(dialog).getByRole("radio", { name: "Slack" }));
    expect(within(dialog).getByText(/In Slack, add the app “Incoming Webhooks”/)).toBeTruthy();
    await user.type(
      within(dialog).getByLabelText(t("alerting.editor.name"), { exact: true }),
      "#lager",
    );
    const url = within(dialog).getByLabelText(t("alerting.contact.url"));
    await user.type(url, "http://hooks.slack.com/services/T0");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(
      await within(dialog).findByText(t("alerting.reason.alerts.chat_url_invalid")),
    ).toBeTruthy();
    expect(url.getAttribute("aria-invalid")).toBe("true");
    await user.clear(url);
    await user.type(url, "https://hooks.slack.com/services/T0/B1/9Qx2");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(server.areas.alerting.contactPoints.at(-1)).toMatchObject({
        kind: "slack",
        url: "https://hooks.slack.com/services/T0/B1/9Qx2",
      }),
    );
  });

  it("shows a stored URL only by host and end, and keeps it unless replaced", async () => {
    const { server, user } = open("/alerting/contact-points", "admin");
    await user.click(await screen.findByRole("button", { name: "Actions for “#lager-alerts”" }));
    await user.click(
      await screen.findByRole("menuitem", { name: t("alerting.contact.menu.edit") }),
    );
    const dialog = await screen.findByRole("dialog", { name: "#lager-alerts" });
    expect(within(dialog).getByText("hooks.slack.com/…/…9Qx2")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(server.areas.alerting.contactPoints[1]?.version).toBe(2));
    expect(server.areas.alerting.contactPoints[1]).not.toHaveProperty("url");
  });
});
