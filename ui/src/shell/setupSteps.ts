import { useQuery } from "@tanstack/react-query";
import type { LinkProps } from "@tanstack/react-router";
import type { MessageKey } from "../i18n/i18n";
import { readPreference, writePreference } from "../lib/storage";
import { useOrgPermissions } from "../org/useOrg";
import { dashboardCountQuery, datasourceCountQuery, memberCountQuery } from "./startData";

/*
 * The setup checklist: the first things an organization needs, each derived from real data, and
 * only the steps the user may take. It is hidden once every step is done, or when the user
 * dismissed it; that choice is kept in this browser per account and organization (there is no
 * server preference for it).
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
  /** Undefined until every number the steps depend on has arrived. */
  steps: SetupStep[] | undefined;
}

/** The steps the user may take, with whether each is done; undefined while loading. */
export function useSetupSteps(orgId: string): SetupState {
  const permissions = useOrgPermissions();
  const canDatasource = permissions.has("datasources:write");
  const canDashboard = permissions.has("dashboards:write");
  // Inviting needs the right to add members, and reading them to know whether anyone was added.
  const canInvite =
    (permissions.has("users:invite") || permissions.has("users:write")) &&
    permissions.has("users:read");
  const datasources = useQuery({ ...datasourceCountQuery(orgId), enabled: canDatasource });
  const dashboards = useQuery({ ...dashboardCountQuery(orgId), enabled: canDashboard });
  const members = useQuery({ ...memberCountQuery(orgId), enabled: canInvite });

  if (!permissions.loaded) {
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
      done: (datasources.data?.value ?? 0) > 0,
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
      done: (dashboards.data?.value ?? 0) > 0,
    });
  }
  if (canInvite) {
    pending.push(members.data === undefined);
    steps.push({
      key: "members",
      label: "shell.setup.members",
      action: "shell.setup.membersAction",
      to: "/admin/members",
      // The creator is the first member; a colleague makes two.
      done: (members.data?.value ?? 0) > 1,
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

const dismissKey = (userId: string, orgId: string) => `${userId}:${orgId}`;

export function isSetupDismissed(userId: string, orgId: string): boolean {
  return readDismissed().includes(dismissKey(userId, orgId));
}

export function dismissSetup(userId: string, orgId: string): void {
  const key = dismissKey(userId, orgId);
  const dismissed = readDismissed();
  if (!dismissed.includes(key)) {
    writePreference(SETUP_DISMISSED_KEY, JSON.stringify([...dismissed, key]));
  }
}
