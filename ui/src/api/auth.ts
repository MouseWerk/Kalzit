import { queryOptions } from "@tanstack/react-query";
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

export interface SetupStatus {
  needed: boolean;
}

export interface SetupInput {
  token: string;
  orgName: string;
  name: string;
  email: string;
  password: string;
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

function isSetupStatus(value: unknown): value is SetupStatus {
  return isRecord(value) && typeof value.needed === "boolean";
}

export async function fetchSetupStatus(): Promise<SetupStatus> {
  return expectShape(await request("GET", "/api/setup"), isSetupStatus, "setup status");
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
