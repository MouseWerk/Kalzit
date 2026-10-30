import { error, type FakeArea, type FakeRequest, json } from "../../../test/fakeServer";
import type { ApiToken, ServiceAccount } from "../api";

/**
 * The service account and SCIM token routes of docs/api/access.md, "Service accounts", for
 * tests: accounts with their tokens as stored, new tokens with a made-up text, revoking, and the
 * organization's one SCIM token. The server's checks are only hinted at (owner, taken names).
 */

export const SA_AT = Date.UTC(2026, 9, 28, 9, 0);
const DAY = 86_400_000;

export interface FakeAccount extends ServiceAccount {
  tokens: ApiToken[];
}

export interface FakeServiceAccountsState {
  accounts: FakeAccount[];
  scim: ApiToken | null;
  /** How many tokens were made, for their made-up texts. */
  made: number;
}

export function fakeToken(fields: Partial<ApiToken> = {}): ApiToken {
  return {
    id: "tk1",
    name: "backup01",
    prefix: "kz_sa_7f3a9c2e",
    expiresAt: SA_AT + 77 * DAY,
    allowedIps: ["10.20.8.0/24"],
    createdAt: SA_AT - 13 * DAY,
    createdByName: "Ada Lovelace",
    lastUsedAt: SA_AT - 3 * 3_600_000,
    lastUsedAddress: "10.20.8.31",
    revokedAt: null,
    revokedByName: null,
    ...fields,
  };
}

function summary(account: FakeAccount): ServiceAccount {
  const { tokens, ...rest } = account;
  const active = tokens.filter((token) => token.revokedAt === null && token.expiresAt > Date.now());
  return {
    ...rest,
    activeTokens: active.length,
    nextExpiry: active.length === 0 ? null : Math.min(...active.map((token) => token.expiresAt)),
  };
}

function refuse(status: number, code: string, field: string, reason: string) {
  return json(status, {
    error: { code, message: `server message for ${code}`, field, reason },
  });
}

export function serviceAccountsFake(): FakeArea<FakeServiceAccountsState> {
  const state: FakeServiceAccountsState = {
    accounts: [
      {
        id: "sa1",
        name: "export-nightly",
        description: "Nächtlicher Export",
        role: "viewer",
        disabled: false,
        activeTokens: 1,
        nextExpiry: null,
        lastUsedAt: SA_AT - 3 * 3_600_000,
        createdByName: "Ada Lovelace",
        createdAt: SA_AT - 30 * DAY,
        tokens: [fakeToken()],
      },
    ],
    scim: null,
    made: 0,
  };
  return { state, handle: (request) => handle(state, request) };
}

function created(state: FakeServiceAccountsState, prefix: string, fields: Partial<ApiToken>) {
  state.made += 1;
  const random = `${state.made}`.padStart(8, "0");
  const token = fakeToken({
    id: `new${state.made}`,
    prefix: `${prefix}${random}`,
    createdAt: Date.now(),
    lastUsedAt: null,
    lastUsedAddress: null,
    allowedIps: [],
    ...fields,
  });
  return { token, text: `${prefix}${random}${"0".repeat(32)}` };
}

function handle(state: FakeServiceAccountsState, request: FakeRequest): Response | undefined {
  const parts = request.route.split("/").slice(4);
  if (parts[0] === "scim-token") {
    if (!request.permissions.has("users:write")) {
      return error(403, "forbidden");
    }
    if (request.method === "GET") {
      return json(200, { token: state.scim });
    }
    if (request.method === "POST") {
      const { token, text } = created(state, "kz_scim_", {
        name: "SCIM",
        expiresAt: Date.now() + 90 * DAY,
      });
      state.scim = token;
      return json(201, { ...token, token: text });
    }
    if (request.method === "DELETE") {
      if (state.scim === null) {
        return error(404, "not_found");
      }
      state.scim = null;
      return new Response(null, { status: 204 });
    }
    return undefined;
  }
  if (parts[0] !== "service-accounts") {
    return undefined;
  }
  if (!request.permissions.has("serviceaccounts:write")) {
    return error(403, "forbidden");
  }
  const [, accountId, sub, tokenId, action] = parts;
  if (accountId === undefined) {
    if (request.method === "GET") {
      return json(200, { items: state.accounts.map(summary), nextCursor: null });
    }
    if (request.method === "POST") {
      const name = String(request.body.name ?? "");
      if (request.body.role === "owner") {
        return refuse(422, "validation", "role", "serviceaccount.role_owner");
      }
      if (state.accounts.some((account) => account.name === name)) {
        return refuse(409, "conflict", "name", "serviceaccount.name_taken");
      }
      const account: FakeAccount = {
        id: `sa${state.accounts.length + 1}`,
        name,
        description: String(request.body.description ?? ""),
        role: String(request.body.role ?? "viewer"),
        disabled: false,
        activeTokens: 0,
        nextExpiry: null,
        lastUsedAt: null,
        createdByName: "Ada Lovelace",
        createdAt: Date.now(),
        tokens: [],
      };
      state.accounts.push(account);
      return json(201, summary(account));
    }
    return undefined;
  }
  const account = state.accounts.find((candidate) => candidate.id === accountId);
  if (account === undefined) {
    return error(404, "not_found");
  }
  if (sub === undefined) {
    if (request.method === "GET") {
      return json(200, { ...summary(account), tokens: account.tokens });
    }
    if (request.method === "PATCH") {
      if (typeof request.body.role === "string") account.role = request.body.role;
      if (typeof request.body.disabled === "boolean") account.disabled = request.body.disabled;
      return json(200, summary(account));
    }
    if (request.method === "DELETE") {
      state.accounts = state.accounts.filter((candidate) => candidate !== account);
      return new Response(null, { status: 204 });
    }
    return undefined;
  }
  if (sub === "tokens" && tokenId === undefined && request.method === "POST") {
    const ips = (request.body.allowedIps as string[] | undefined) ?? [];
    const days = typeof request.body.expiresInDays === "number" ? request.body.expiresInDays : 90;
    const { token, text } = created(state, "kz_sa_", {
      name: String(request.body.name ?? ""),
      allowedIps: ips,
      expiresAt:
        typeof request.body.expiresAt === "number"
          ? request.body.expiresAt
          : Date.now() + days * DAY,
    });
    account.tokens.unshift(token);
    return json(201, { ...token, token: text });
  }
  if (sub === "tokens" && action === "revoke" && request.method === "POST") {
    const token = account.tokens.find((candidate) => candidate.id === tokenId);
    if (token === undefined) {
      return error(404, "not_found");
    }
    token.revokedAt ??= Date.now();
    token.revokedByName ??= "Ada Lovelace";
    return json(200, token);
  }
  return undefined;
}
