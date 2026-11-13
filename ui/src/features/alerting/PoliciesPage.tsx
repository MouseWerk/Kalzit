import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type DragEvent, type KeyboardEvent, useRef, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { Icon } from "../../components/Icon";
import { PageActions } from "../../components/Page";
import { ToolbarMenu, type ToolbarMenuEntry } from "../../components/ToolbarMenu";
import { type MessageKey, type Translate, useI18n } from "../../i18n/i18n";
import { isComposingKey } from "../../lib/ime";
import { showToast } from "../../lib/toasts";
import { ConfirmDialog } from "../admin/components/Dialog";
import { ALERTING_KEY, type ContactPoint, contactPointsQuery, rulesQuery } from "./api";
import {
  deletePolicy,
  groupsQuery,
  movePolicy,
  policiesQuery,
  policyKeys,
  policyLimits,
  routingAvailable,
} from "./policies";
import {
  applyMove,
  buildTree,
  canAddChild,
  descendants,
  type Move,
  type MoveTarget,
  moveTarget,
  type Policy,
  type PolicyNode,
  visibleRows,
} from "./policyModel";
import { ContactChips, groupByText, MatcherChips, OwnTimes, RouteChecker } from "./policyParts";
import { alertingErrorText } from "./reasons";
import { AlertingLayout, useAlerting } from "./shared";

const MOVED: Record<Move | "drag", MessageKey> = {
  up: "alerting.policies.moved.up",
  down: "alerting.policies.moved.down",
  indent: "alerting.policies.moved.indent",
  outdent: "alerting.policies.moved.outdent",
  drag: "alerting.policies.moved",
};

const MOVE_KEYS: Record<string, Move> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowRight: "indent",
  ArrowLeft: "outdent",
};

/**
 * "Alerting > Richtlinien" (board AlertingRouting.dc.html, frames 1, 2, 8 and 11): the tree of
 * notification policies with conditions, contact points, grouping and times, inherited values as
 * the word "geerbt", and the route checker below. Organization admins (`alerts:contacts`) add,
 * move and delete policies; everyone else with `alerts:read` sees the tree read-only.
 */
export function PoliciesPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { orgId, canContacts, status } = useAlerting();
  const available = routingAvailable(status);
  const policies = useQuery({ ...policiesQuery(orgId), enabled: orgId !== "" && available });
  const points = useQuery({ ...contactPointsQuery(orgId), enabled: orgId !== "" });
  const rules = useQuery({ ...rulesQuery(orgId), enabled: orgId !== "" });
  const groups = useQuery({
    ...groupsQuery(orgId, undefined),
    enabled: orgId !== "" && available,
  });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [focused, setFocused] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<PolicyNode | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const limits = policyLimits(status);

  const list = policies.data ?? [];
  const root = buildTree(list);
  const rows = visibleRows(root, collapsed);
  const contactList = points.data ?? [];
  const ruleList = rules.data ?? [];
  const directRules = ruleList.filter((rule) => rule.routing === "direct");
  // Rules with a way that has no contact point: "Wird nicht zugestellt".
  const undelivered = ruleList.filter(
    (rule) => rule.routing !== "direct" && (rule.routes ?? []).some((route) => !route.delivers),
  ).length;
  const crowded = (groups.data?.items ?? []).filter(
    (group) => group.catchAll && group.policyId !== null,
  );
  // Groups with data the person may not read: one total, never tied to a policy.
  const hiddenGroups = groups.data?.hiddenGroups ?? 0;

  const move = useMutation({
    mutationFn: (input: { node: PolicyNode; target: MoveTarget; move: Move | null }) =>
      movePolicy(orgId, input.node.policy.id, input.target),
    // The tree shows the move at once; the server's answer (the whole tree) replaces it.
    onMutate: async ({ node, target }) => {
      await queryClient.cancelQueries({ queryKey: policyKeys.list(orgId) });
      queryClient.setQueryData<Policy[]>(policyKeys.list(orgId), (old) =>
        old === undefined ? old : applyMove(old, node.policy.id, target),
      );
    },
    onSuccess: (tree, { node, move: kind }) => {
      queryClient.setQueryData(policyKeys.list(orgId), tree);
      const back: MoveTarget = {
        parentId: node.parent?.policy.id ?? "",
        position: node.parent?.children.indexOf(node) ?? 0,
      };
      showToast({
        message: t(MOVED[kind ?? "drag"], { name: node.policy.name }),
        undo: () => undoMove.mutate({ id: node.policy.id, target: back }),
      });
    },
    onError: (error) => showToast({ message: alertingErrorText(t, error), error: true }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: policyKeys.list(orgId) }),
  });
  const undoMove = useMutation({
    mutationFn: (input: { id: string; target: MoveTarget }) =>
      movePolicy(orgId, input.id, input.target),
    onError: (error) => showToast({ message: alertingErrorText(t, error), error: true }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: policyKeys.list(orgId) }),
  });
  const remove = useMutation({
    // The server deletes the policies below it in the same call.
    mutationFn: (node: PolicyNode) => deletePolicy(orgId, node.policy.id),
    onSuccess: async (_, node) => {
      setDeleting(null);
      showToast({ message: t("alerting.policies.deleted", { name: node.policy.name }) });
      await queryClient.invalidateQueries({ queryKey: [ALERTING_KEY, orgId] });
    },
  });

  function doMove(node: PolicyNode, kind: Move) {
    const target = moveTarget(node, kind, limits.maxDepth);
    if (target === null || move.isPending) return;
    move.mutate({ node, target, move: kind });
    setFocused(node.policy.id);
    requestAnimationFrame(() => rowRefs.current.get(node.policy.id)?.focus());
  }

  function focusRow(id: string | undefined) {
    if (id === undefined) return;
    setFocused(id);
    rowRefs.current.get(id)?.focus();
  }

  function toggle(id: string, open: boolean) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (open) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function onRowKeyDown(event: KeyboardEvent<HTMLDivElement>, node: PolicyNode, index: number) {
    if (event.target !== event.currentTarget || isComposingKey(event)) return;
    if (event.altKey && canContacts) {
      const kind = MOVE_KEYS[event.key];
      if (kind !== undefined) {
        event.preventDefault();
        doMove(node, kind);
      }
      return;
    }
    const open = node.children.length > 0 && !collapsed.has(node.policy.id);
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        focusRow(rows[index + 1]?.policy.id);
        break;
      case "ArrowUp":
        event.preventDefault();
        focusRow(rows[index - 1]?.policy.id);
        break;
      case "Home":
        event.preventDefault();
        focusRow(rows[0]?.policy.id);
        break;
      case "End":
        event.preventDefault();
        focusRow(rows.at(-1)?.policy.id);
        break;
      case "ArrowRight":
        event.preventDefault();
        if (node.children.length === 0) break;
        if (open) focusRow(node.children[0]?.policy.id);
        else toggle(node.policy.id, true);
        break;
      case "ArrowLeft":
        event.preventDefault();
        if (open) toggle(node.policy.id, false);
        else focusRow(node.parent?.policy.id);
        break;
      case "Enter":
        event.preventDefault();
        void navigate({ to: "/alerting/policies/$policyId", params: { policyId: node.policy.id } });
        break;
    }
  }

  function onDrop(event: DragEvent<HTMLDivElement>, over: PolicyNode) {
    event.preventDefault();
    const id = dragging;
    setDragging(null);
    if (id === null || id === over.policy.id || over.parent === null || root === null) return;
    const node = rows.find((row) => row.policy.id === id);
    if (node === undefined || descendants(node).includes(over)) return;
    const box = event.currentTarget.getBoundingClientRect();
    const after = event.clientY > box.top + box.height / 2;
    const siblings = over.parent.children.filter((child) => child !== node);
    const position = siblings.indexOf(over) + (after ? 1 : 0);
    move.mutate({ node, target: { parentId: over.parent.policy.id, position }, move: null });
  }

  const tabStop = focused ?? root?.policy.id ?? null;

  return (
    <AlertingLayout
      tab="policies"
      lead={t(canContacts ? "alerting.policies.leadAdmin" : "alerting.policies.lead")}
      actions={
        <PageActions>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => document.getElementById("route-checker")?.focus()}
          >
            {t("alerting.policies.check.title")}
          </button>
          {canContacts && root !== null ? (
            <Link
              to="/alerting/policies/new"
              search={{ parent: root.policy.id }}
              className="button button--primary"
            >
              <Icon name="plus" />
              {t("alerting.policies.add")}
            </Link>
          ) : null}
        </PageActions>
      }
    >
      {!available && status !== undefined ? (
        <EmptyState icon="info" title={t("alerting.policies.missing.title")}>
          {t("alerting.policies.missing.text")}
        </EmptyState>
      ) : null}
      {policies.isError ? (
        <p className="field__error">{alertingErrorText(t, policies.error)}</p>
      ) : null}
      {canContacts ? null : (
        <p className="alert-note">
          <Icon name="lock" />
          <span>{t("alerting.policies.readOnly")}</span>
        </p>
      )}
      {root !== null && root.policy.contactPointIds.length === 0 ? (
        <p className="alert-alarm" role="status">
          <span>
            {t("alerting.policies.rootEmpty", { count: undelivered })}{" "}
            {canContacts ? (
              <Link to="/alerting/policies/$policyId" params={{ policyId: root.policy.id }}>
                {t("alerting.policies.pickContact")}
              </Link>
            ) : null}
          </span>
        </p>
      ) : null}
      {crowded.map((group, index) => (
        <p key={group.id ?? `crowded-${index}`} className="alert-alarm" role="status">
          <span>
            {t("alerting.policies.crowded", {
              name: list.find((policy) => policy.id === group.policyId)?.name ?? "",
              max: status?.limits.maxActiveGroupsPerOrg ?? 1000,
            })}
          </span>
        </p>
      ))}
      {root === null ? null : (
        <>
          <p className="alert-hint">{t("alerting.policies.explain")}</p>
          {hiddenGroups === 0 ? null : (
            <p className="alert-hint">
              {hiddenGroups === 1
                ? t("alerting.policies.hiddenGroupsOne")
                : t("alerting.policies.hiddenGroups", { count: hiddenGroups })}
            </p>
          )}
          <div className="alert-card alert-ptree">
            <div className="alert-prow alert-prow--head" aria-hidden="true">
              <span>{t("alerting.policies.column.policy")}</span>
              <span>{t("alerting.policies.column.matchers")}</span>
              <span>{t("alerting.policies.column.contactPoints")}</span>
              <span>{t("alerting.policies.column.times")}</span>
              <span />
            </div>
            <div role="tree" aria-label={t("alerting.policies.treeLabel")}>
              {rows.map((node, index) => (
                <PolicyRow
                  key={node.policy.id}
                  node={node}
                  points={contactList}
                  canEdit={canContacts}
                  maxDepth={limits.maxDepth}
                  open={!collapsed.has(node.policy.id)}
                  tabbable={tabStop === node.policy.id}
                  dragging={dragging === node.policy.id}
                  rowRef={(element) => {
                    if (element === null) rowRefs.current.delete(node.policy.id);
                    else rowRefs.current.set(node.policy.id, element);
                  }}
                  onFocus={() => setFocused(node.policy.id)}
                  onKeyDown={(event) => onRowKeyDown(event, node, index)}
                  onToggle={() => toggle(node.policy.id, collapsed.has(node.policy.id))}
                  onMove={(kind) => doMove(node, kind)}
                  onDelete={() => setDeleting(node)}
                  onDragStart={() => setDragging(node.policy.id)}
                  onDragEnd={() => setDragging(null)}
                  onDrop={(event) => onDrop(event, node)}
                />
              ))}
            </div>
          </div>
          {directRules.length === 0 ? null : (
            <p className="alert-note">
              <span>
                {t("alerting.policies.directNote", { count: directRules.length })}{" "}
                <Link to="/alerting">{t("alerting.policies.directShow")}</Link>
              </span>
            </p>
          )}
          <RouteChecker
            id="route-checker"
            orgId={orgId}
            root={root}
            points={contactList}
            rules={ruleList}
          />
        </>
      )}
      <ConfirmDialog
        open={deleting !== null}
        title={t("alerting.policies.deleteTitle", { name: deleting?.policy.name ?? "" })}
        confirmLabel={t("alerting.policies.menu.delete")}
        busy={remove.isPending}
        error={remove.isError ? alertingErrorText(t, remove.error) : null}
        onConfirm={() => deleting !== null && remove.mutate(deleting)}
        onClose={() => {
          setDeleting(null);
          remove.reset();
        }}
      >
        {deleting === null ? null : deleteText(t, deleting)}
      </ConfirmDialog>
    </AlertingLayout>
  );
}

/**
 * What deleting a policy does: the policies below it go with it; their groups end, and the
 * contact points that had their instances get a resolve unless the new way reaches them too.
 */
export function deleteText(t: Translate, node: PolicyNode): string {
  const below = descendants(node);
  const groups = [node, ...below].reduce((sum, at) => sum + at.policy.activeGroups, 0);
  const parent = node.parent?.policy.name ?? "";
  return [
    below.length === 0
      ? null
      : below.length === 1
        ? t("alerting.policies.deleteChild")
        : t("alerting.policies.deleteChildren", { count: below.length }),
    groups === 0
      ? t("alerting.policies.deleteText", { parent })
      : t("alerting.policies.deleteGroups", { count: groups, parent }),
  ]
    .filter((part) => part !== null)
    .join(" ");
}

function PolicyRow({
  node,
  points,
  canEdit,
  maxDepth,
  open,
  tabbable,
  dragging,
  rowRef,
  onFocus,
  onKeyDown,
  onToggle,
  onMove,
  onDelete,
  onDragStart,
  onDragEnd,
  onDrop,
}: {
  node: PolicyNode;
  points: readonly ContactPoint[];
  canEdit: boolean;
  maxDepth: number;
  open: boolean;
  tabbable: boolean;
  dragging: boolean;
  rowRef: (element: HTMLDivElement | null) => void;
  onFocus: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => void;
  onToggle: () => void;
  onMove: (move: Move) => void;
  onDelete: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDrop: (event: DragEvent<HTMLDivElement>) => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { policy } = node;
  const isRoot = node.parent === null;
  const siblings = node.parent?.children.length ?? 1;
  const position = (node.parent?.children.indexOf(node) ?? 0) + 1;
  const where = isRoot
    ? t("alerting.policies.rootWhere")
    : t("alerting.policies.where", {
        parent: node.parent?.policy.name ?? "",
        position,
        count: siblings,
      });
  const steps = policy.escalations.length;
  const open_ = () =>
    void navigate({ to: "/alerting/policies/$policyId", params: { policyId: policy.id } });
  const can = (move: Move) => moveTarget(node, move, maxDepth) !== null;
  const entries: ToolbarMenuEntry[] = [
    {
      key: "edit",
      label: t("alerting.policies.menu.edit"),
      icon: "edit",
      shortcut: "Enter",
      onSelect: open_,
    },
    {
      key: "child",
      label: t("alerting.policies.menu.child"),
      icon: "plus",
      disabled: !canAddChild(node, maxDepth),
      onSelect: () =>
        void navigate({ to: "/alerting/policies/new", search: { parent: policy.id } }),
    },
    ...(isRoot
      ? []
      : ([
          {
            key: "duplicate",
            label: t("alerting.policies.menu.duplicate"),
            icon: "copy",
            onSelect: () =>
              void navigate({
                to: "/alerting/policies/new",
                search: { parent: node.parent?.policy.id ?? "", from: policy.id },
              }),
          },
          { kind: "separator", key: "sep1" },
          {
            key: "up",
            label: t("alerting.policies.menu.up"),
            icon: "arrowUp",
            // glyph-ok: the keys to press
            shortcut: "Alt ↑",
            disabled: !can("up"),
            onSelect: () => onMove("up"),
          },
          {
            key: "down",
            label: t("alerting.policies.menu.down"),
            icon: "arrowDown",
            // glyph-ok: the keys to press
            shortcut: "Alt ↓",
            disabled: !can("down"),
            onSelect: () => onMove("down"),
          },
          {
            key: "indent",
            label: t("alerting.policies.menu.indent"),
            icon: "arrowRight",
            // glyph-ok: the keys to press
            shortcut: "Alt →",
            disabled: !can("indent"),
            onSelect: () => onMove("indent"),
          },
          {
            key: "outdent",
            label: t("alerting.policies.menu.outdent"),
            icon: "back",
            // glyph-ok: the keys to press
            shortcut: "Alt ←",
            disabled: !can("outdent"),
            onSelect: () => onMove("outdent"),
          },
          { kind: "separator", key: "sep2" },
          {
            key: "delete",
            label: t("alerting.policies.menu.delete"),
            icon: "trash",
            danger: true,
            onSelect: onDelete,
          },
        ] satisfies ToolbarMenuEntry[])),
  ];
  return (
    <div
      ref={rowRef}
      role="treeitem"
      aria-level={node.depth + 1}
      aria-setsize={siblings}
      aria-posinset={position}
      aria-expanded={node.children.length === 0 ? undefined : open}
      aria-label={`${policy.name}, ${where}`}
      tabIndex={tabbable ? 0 : -1}
      className="alert-prow"
      data-dragging={dragging || undefined}
      onFocus={(event) => event.target === event.currentTarget && onFocus()}
      onKeyDown={onKeyDown}
      onDragOver={(event) => canEdit && !isRoot && event.preventDefault()}
      onDrop={onDrop}
    >
      <span className="alert-pname" data-depth={Math.min(node.depth, 6)}>
        <span className="alert-pname__line">
          {canEdit && !isRoot ? (
            <span
              className="alert-grip"
              draggable
              aria-hidden="true"
              title={t("alerting.policies.drag")}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", policy.id);
                onDragStart();
              }}
              onDragEnd={onDragEnd}
            >
              <Icon name="grip" />
            </span>
          ) : null}
          {node.children.length === 0 ? (
            <span className="alert-elbow" aria-hidden="true" />
          ) : (
            <button
              type="button"
              tabIndex={-1}
              className="button button--ghost button--small alert-elbow"
              aria-label={t("alerting.policies.toggle", { name: policy.name })}
              aria-expanded={open}
              onClick={onToggle}
            >
              <Icon name={open ? "chevronDown" : "chevron"} />
            </button>
          )}
          <Link
            to="/alerting/policies/$policyId"
            params={{ policyId: policy.id }}
            className="alert-rule-name"
            tabIndex={-1}
          >
            {policy.name}
          </Link>
          {policy.continue ? (
            <span className="alert-chip">{t("alerting.policies.continue")}</span>
          ) : null}
          {steps === 0 ? null : (
            <span className="alert-chip">
              {steps === 1
                ? t("alerting.policies.stepsOne")
                : t("alerting.policies.steps", { count: steps })}
            </span>
          )}
        </span>
      </span>
      <span className="alert-cells">
        {isRoot ? (
          <span className="alert-muted">{t("alerting.policies.rootMatches")}</span>
        ) : (
          <MatcherChips matchers={policy.matchers} />
        )}
      </span>
      <span className="alert-cells">
        {policy.contactPointIds.length > 0 ? (
          <ContactChips ids={policy.contactPointIds} points={points} />
        ) : isRoot ? (
          <span className="alert-warn-text">{t("alerting.policies.notDelivered")}</span>
        ) : (
          <span className="alert-inherited">{t("alerting.policies.inherited")}</span>
        )}
      </span>
      <span className="alert-times">
        {policy.groupBy === null ? (
          <span className="alert-inherited">{t("alerting.policies.inherited")}</span>
        ) : (
          <span translate="no">{groupByText(t, policy.groupBy)}</span>
        )}
        <OwnTimes policy={policy} />
      </span>
      <span className="alert-row-end">
        {canEdit ? (
          <ToolbarMenu
            label={t("alerting.policies.menu.label", { name: policy.name })}
            icon="more"
            entries={entries}
          />
        ) : null}
      </span>
    </div>
  );
}
