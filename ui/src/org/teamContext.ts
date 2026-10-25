import { queryOptions, useQuery } from "@tanstack/react-query";
import { isRecord, request } from "../api/client";
import { useCurrentOrg } from "./useOrg";

/*
 * The team context of the sidebar (docs/api/access.md, "Team spaces"): the team a member works
 * in per organization, stored on the server and checked against their teams there. It scopes the
 * Dashboards page and the start page lists and names where new dashboards go. A view only: the
 * server decides access on every request.
 */

export interface TeamSpaceRef {
  id: string;
  name: string;
}

export interface TeamChoice {
  id: string;
  name: string;
  /** The member belongs to the team (org admins can also pick teams they are not in). */
  member: boolean;
  /** The member maintains the team and may create its team spaces. */
  maintainer: boolean;
  /** The team's spaces the member sees, by name. */
  spaces: TeamSpaceRef[];
}

export interface TeamContext {
  /** The active team; `null` for all areas. */
  teamId: string | null;
  teams: TeamChoice[];
  /** Where "New dashboard" puts a dashboard; `null` for the place the page picks. */
  defaultFolderId: string | null;
}

export const TEAM_CONTEXT_KEY = "teamContext";

const EMPTY: TeamContext = { teamId: null, teams: [], defaultFolderId: null };

const text = (value: unknown): string => (typeof value === "string" ? value : "");

function parseContext(value: unknown): TeamContext {
  if (!isRecord(value) || !Array.isArray(value.teams)) {
    return EMPTY;
  }
  const teams: TeamChoice[] = value.teams.filter(isRecord).map((team) => ({
    id: text(team.id),
    name: text(team.name),
    member: team.member === true,
    maintainer: team.maintainer === true,
    spaces: Array.isArray(team.spaces)
      ? team.spaces
          .filter(isRecord)
          .map((space) => ({ id: text(space.id), name: text(space.name) }))
      : [],
  }));
  return {
    teamId: typeof value.teamId === "string" ? value.teamId : null,
    teams,
    defaultFolderId: typeof value.defaultFolderId === "string" ? value.defaultFolderId : null,
  };
}

function contextPath(orgId: string): string {
  return `/api/orgs/${encodeURIComponent(orgId)}/team-context`;
}

export async function fetchTeamContext(orgId: string, signal?: AbortSignal): Promise<TeamContext> {
  return parseContext(
    await request("GET", contextPath(orgId), undefined, signal ? { signal } : {}),
  );
}

/** Works in `teamId` from now on (`null`: all areas); answers the context as stored. */
export async function setTeamContext(orgId: string, teamId: string | null): Promise<TeamContext> {
  return parseContext(await request("PUT", contextPath(orgId), { teamId }));
}

export function teamContextQuery(orgId: string) {
  return queryOptions({
    queryKey: [TEAM_CONTEXT_KEY, orgId],
    queryFn: ({ signal }) => fetchTeamContext(orgId, signal),
  });
}

export interface TeamContextState {
  context: TeamContext;
  /** The active team, when there is one. */
  team: TeamChoice | undefined;
  /**
   * The `team` parameter for scoped lists; `undefined` for all areas. Lists wait for `settled`,
   * so they do not load once unscoped and again scoped.
   */
  scope: string | undefined;
  settled: boolean;
}

/**
 * The team context of the current organization. Without an organization, or when the server
 * cannot answer, there is no team: everything stays as without teams.
 */
export function useTeamContext(): TeamContextState {
  const org = useCurrentOrg();
  const query = useQuery({ ...teamContextQuery(org?.id ?? ""), enabled: org !== undefined });
  const context = query.data ?? EMPTY;
  const team = context.teams.find((t) => t.id === context.teamId);
  return {
    context,
    team,
    scope: team?.id,
    settled: org === undefined || !query.isPending,
  };
}
