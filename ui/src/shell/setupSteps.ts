import { useQuery } from "@tanstack/react-query";
import type { LinkProps } from "@tanstack/react-router";
import type { MessageKey } from "../i18n/i18n";
import { readPreference, writePreference } from "../lib/storage";
import { useOrgPermissions } from "../org/useOrg";
import { hasAnyQuery, hasColleagueQuery } from "./startData";

/*
 * The setup checklist: the first things an organization needs, each derived from real data, and
 * only the steps the user may take. It is hidden for good once every step is done, or when the
 * user dismissed it; both are kept in this browser per account and organization (there is no
 * server preference for it), and from then on nothing is asked of the server for it.
 */

export type SetupStepKey = "datasource" | "dashboard" | "members";

export interface SetupStep {
  key: SetupStepKey;
  label: MessageKey;
  action: MessageKey;
  to: NonNullable<LinkProps["to"]>;
  search?: Record<string, string>;
  done: boolean;
}

export interface SetupState {
  /** Undefined until every answer the steps depend on has arrived, or while disabled. */
  steps: SetupStep[] | undefined;
}

/**
 * The steps the user may take, with whether each is done; undefined while loading. Each check is
 * an existence check (one entry, or two members), never a count.
 */
export function useSetupSteps(orgId: string, enabled: boolean): SetupState {
  const permissions = useOrgPermissions();
  const canDatasource = permissions.has("datasources:write");
  const canDashboard = permissions.has("dashboards:write");
  // Inviting needs the right to add members, and reading them to know whether anyone was added.
  const canInvite =
    (permissions.has("users:invite") || permissions.has("users:write")) &&
    permissions.has("users:read");
  const datasources = useQuery({
    ...hasAnyQuery(orgId, "datasource"),
    enabled: enabled && canDatasource,
  });
  const dashboards = useQuery({
    ...hasAnyQuery(orgId, "dashboard"),
    enabled: enabled && canDashboard,
  });
  const members = useQuery({ ...hasColleagueQuery(orgId), enabled: enabled && canInvite });

  if (!enabled || !permissions.loaded) {
    return { steps: undefined };
  }
  const steps: SetupStep[] = [];
  const pending: boolean[] = [];
  if (canDatasource) {
    pending.push(datasources.data === undefined);
    steps.push({
      key: "datasource",
      label: "shell.setup.datasource",
      action: "shell.setup.datasourceAction",
      to: "/data-sources/new",
      done: datasources.data === true,
    });
  }
  if (canDashboard) {
    pending.push(dashboards.data === undefined);
    steps.push({
      key: "dashboard",
      label: "shell.setup.dashboard",
      action: "shell.setup.dashboardAction",
      to: "/dashboards",
      search: { create: "dashboard" },
      done: dashboards.data === true,
    });
  }
  if (canInvite) {
    pending.push(members.data === undefined);
    steps.push({
      key: "members",
      label: "shell.setup.members",
      action: "shell.setup.membersAction",
      to: "/admin/members",
      done: members.data === true,
    });
  }
  return { steps: pending.some(Boolean) ? undefined : steps };
}

export const SETUP_DISMISSED_KEY = "kalzit.setup.dismissed";

function readDismissed(): string[] {
  const raw = readPreference(SETUP_DISMISSED_KEY);
  if (raw === null || raw === "") {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** One entry per account and organization, so hiding it in one never hides it in another. */
export const setupKey = (userId: string, orgId: string) => `${userId}:${orgId}`;

export function isSetupDismissed(userId: string, orgId: string): boolean {
  return readDismissed().includes(setupKey(userId, orgId));
}

/** Hides the checklist for this account and organization: dismissed, or every step done. */
export function dismissSetup(userId: string, orgId: string): void {
  const key = setupKey(userId, orgId);
  const dismissed = readDismissed();
  if (!dismissed.includes(key)) {
    writePreference(SETUP_DISMISSED_KEY, JSON.stringify([...dismissed, key]));
  }
}
