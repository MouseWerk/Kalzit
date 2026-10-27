import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { forgetDrafts } from "../features/dashboards/draftStore";
import { resetLiveClients } from "../live/client";
import { expectShape, isApiError, isRecord, request } from "./client";

export const ORG_ROLES = ["owner", "admin", "editor", "viewer"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export interface OrgMembership {
  id: string;
  name: string;
  /** One of the fixed roles, or the name of a custom role (planned), which grants no extras here. */
  role: OrgRole | (string & {});
}

export interface Me {
  id: string;
  email: string;
  name: string;
  isServerAdmin: boolean;
  orgs: OrgMembership[];
}

/** Where the setup code can be found on this server; sent only while setup is needed. */
export type SetupCodeHint = "file" | "docker" | "fixed";

export interface SetupStatus {
  needed: boolean;
  codeHint?: SetupCodeHint | undefined;
}

export interface SetupInput {
  token: string;
  orgName: string;
  name: string;
  email: string;
  password: string;
  /** Defaults for everyone: the server's language and theme, the organization's time zone. */
  language?: string;
  theme?: string;
  timeZone?: string;
}

export interface LoginInput {
  email: string;
  password: string;
}

function isOrgMembership(value: unknown): value is OrgMembership {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    // Any string: an unknown (custom) role must not make the whole user unreadable.
    typeof value.role === "string"
  );
}

export function isMe(value: unknown): value is Me {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.email === "string" &&
    typeof value.name === "string" &&
    typeof value.isServerAdmin === "boolean" &&
    Array.isArray(value.orgs) &&
    value.orgs.every(isOrgMembership)
  );
}

const CODE_HINTS: readonly string[] = ["file", "docker", "fixed"];

function isSetupStatus(value: unknown): value is SetupStatus {
  return (
    isRecord(value) &&
    typeof value.needed === "boolean" &&
    (value.codeHint === undefined ||
      (typeof value.codeHint === "string" && CODE_HINTS.includes(value.codeHint)))
  );
}

export async function fetchSetupStatus(): Promise<SetupStatus> {
  return expectShape(await request("GET", "/api/setup"), isSetupStatus, "setup status");
}

/** Checks the setup code on its own; resolves when it is the current one. */
export async function checkSetupCode(token: string): Promise<void> {
  await request("POST", "/api/setup/check", { token });
}

export async function completeSetup(input: SetupInput): Promise<Me> {
  return expectShape(await request("POST", "/api/setup", input), isMe, "setup");
}

export async function login(input: LoginInput): Promise<Me> {
  return expectShape(await request("POST", "/api/auth/login", input), isMe, "login");
}

export async function logout(): Promise<void> {
  await request("POST", "/api/auth/logout");
}

/** The signed-in user, or null when there is no valid session. */
export async function fetchMe(): Promise<Me | null> {
  try {
    return expectShape(await request("GET", "/api/me"), isMe, "me");
  } catch (error) {
    if (isApiError(error, "unauthenticated")) {
      return null;
    }
    throw error;
  }
}

export const setupStatusQuery = queryOptions({
  queryKey: ["setup"],
  queryFn: fetchSetupStatus,
  // Setup happens once per installation; the UI updates the cache itself after it completes.
  staleTime: Number.POSITIVE_INFINITY,
});

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: fetchMe,
  staleTime: 60_000,
});

/**
 * Drops everything cached for the account that was signed in (preferences, organizations, data),
 * keeping only the session itself and the setup status: after a session ends, or when another
 * account signs in, nothing of the previous one may answer for the new one.
 */
export function forgetAccountData(queryClient: QueryClient): void {
  const keep = new Set<unknown>([meQuery.queryKey[0], setupStatusQuery.queryKey[0]]);
  queryClient.removeQueries({ predicate: (query) => !keep.has(query.queryKey[0]) });
  // Unsaved dashboard drafts kept in this tab belong to the account that made them.
  forgetDrafts();
  // Live connections ran with the session that ended.
  resetLiveClients();
}
