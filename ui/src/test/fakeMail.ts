import type { Me } from "../api/auth";
import type { InvitationInfo } from "../auth/linksApi";
import type { Delivered, Invitation } from "../features/admin/invitationsApi";
import type { MailView } from "../features/settings/mailApi";
import { error, type FakeArea, type FakeServer, json } from "./fakeServer";

/**
 * The mail routes of docs/api/mail.md for tests: the mail server settings, an organization's
 * invitations and password links, and the pages behind the links. The server does the checking;
 * here the answers are given or arranged.
 */

export type Refusal = {
  status: number;
  code: string;
  field?: string;
  reason?: string;
  params?: Record<string, string>;
};

export interface FakeMailState {
  view: MailView;
  /** The answer of the next save: a refusal, or nothing (saved). */
  saveAnswer?: Refusal | undefined;
  testAnswer: Delivered | Refusal;
  /** Whether new invitations go by mail (else they answer their links). */
  mailed: boolean;
  invitations: Invitation[];
  /** The answer of the next invitation request, when arranged. */
  inviteAnswer?: Refusal | undefined;
  /** What the invitation page sees per token; unknown tokens answer not found. */
  links: Record<string, InvitationInfo>;
  /** The user an accepted invitation signs in. */
  joined?: Me | undefined;
  acceptAnswer?: Refusal | undefined;
  /** The sign-in's second step a new account must take first (`secondFactor`), if any. */
  acceptSecondFactor?: unknown;
  resetAvailable: boolean;
  /** Password links by token. */
  resets: Record<string, { email: string; expiresAt: number }>;
  resetRequests: string[];
  completed: { token: string; password: string }[];
  passwordLinks: string[];
  passwordLinkAnswer?: Refusal | undefined;
  /** Email confirmation links that work, by token. */
  confirmations: string[];
  confirmRequests: number;
}

export const MAIL_AT = Date.UTC(2026, 9, 29, 13, 20);

export const DELIVERED: Delivered = {
  reply: "250 2.0.0 OK",
  elapsedMs: 640,
  tls: "TLS 1.3",
  certificateNotAfter: Date.UTC(2027, 2, 2),
};

export function invitationInfo(fields: Partial<InvitationInfo> = {}): InvitationInfo {
  return {
    orgName: "Analytical Engines",
    inviterName: "Ada Lovelace",
    email: "nora@example.com",
    role: "editor",
    roleName: "editor",
    teamName: "Analysts",
    expiresAt: MAIL_AT + 7 * 86_400_000,
    state: "valid",
    accountExists: false,
    signedInAs: null,
    password: true,
    sso: [],
    ...fields,
  };
}

export function refusal(answer: Refusal): Response {
  const body: Record<string, unknown> = {
    code: answer.code,
    message: `server message for ${answer.code}`,
  };
  if (answer.field !== undefined) body.field = answer.field;
  if (answer.reason !== undefined) body.reason = answer.reason;
  if (answer.params !== undefined) body.params = answer.params;
  return json(answer.status, { error: body });
}

function take<K extends "saveAnswer" | "inviteAnswer" | "acceptAnswer" | "passwordLinkAnswer">(
  state: FakeMailState,
  key: K,
): Refusal | undefined {
  const answer = state[key];
  state[key] = undefined;
  return answer;
}

export function mailFake(): FakeArea<FakeMailState> {
  const state: FakeMailState = {
    view: {
      settings: null,
      hasPassword: false,
      source: "default",
      editable: true,
      version: 0,
      publicUrl: "https://kalzit.example.com",
    },
    testAnswer: DELIVERED,
    mailed: true,
    invitations: [],
    links: {},
    resetAvailable: true,
    resets: {},
    resetRequests: [],
    completed: [],
    passwordLinks: [],
    confirmations: [],
    confirmRequests: 0,
  };
  let next = 1;
  return {
    state,
    handle: (request) => {
      const parts = request.route.split("/");
      // /api/orgs/{orgId}/members/{userId}/password-link
      if (parts[4] === "members" && parts[6] === "password-link" && request.method === "POST") {
        if (!request.permissions.has("users:write")) return error(403, "forbidden");
        const answer = take(state, "passwordLinkAnswer");
        if (answer !== undefined) return refusal(answer);
        state.passwordLinks.push(parts[5] ?? "");
        return json(200, DELIVERED);
      }
      if (parts[4] !== "invitations") {
        return undefined;
      }
      if (!request.permissions.has("users:invite")) return error(403, "forbidden");
      const [id, action] = [parts[5], parts[6]];
      const found = state.invitations.find((invitation) => invitation.id === id);
      if (id === undefined && request.method === "GET") {
        return json(200, { items: state.invitations, nextCursor: null });
      }
      if (id === undefined && request.method === "POST") {
        const answer = take(state, "inviteAnswer");
        if (answer !== undefined) return refusal(answer);
        const body = request.body as { emails: string[]; role: string; teamId?: string };
        const items = body.emails.map((email) => {
          const invitation: Invitation = {
            id: `i${next++}`,
            email: email.toLowerCase(),
            role: body.role,
            teamId: body.teamId ?? null,
            teamName: body.teamId === undefined ? null : "Analysts",
            invitedByName: "Ada Lovelace",
            createdAt: MAIL_AT,
            expiresAt: MAIL_AT + 7 * 86_400_000,
            state: "pending",
            delivery: state.mailed ? (email.includes("bounce") ? "failed" : "sent") : "none",
            deliveryDetail: email.includes("bounce") ? "550 5.1.1 mailbox unknown" : null,
            deliveredAt: state.mailed ? MAIL_AT : null,
          };
          state.invitations.unshift(invitation);
          const link = state.mailed
            ? null
            : `https://kalzit.example.com/invite#token-${invitation.id}`;
          return { invitation, link };
        });
        return json(201, { items, mailed: state.mailed });
      }
      if (found === undefined) return error(404, "not_found");
      if (action === "link" && request.method === "GET" && found.delivery !== "none") {
        return refusal({ status: 409, code: "conflict", reason: "mail.invite_link_by_mail" });
      }
      if (action === "link" && request.method === "GET") {
        return json(200, {
          link: `https://kalzit.example.com/invite#token-${found.id}`,
          expiresAt: found.expiresAt,
        });
      }
      if (action === "resend" && request.method === "POST") {
        Object.assign(found, {
          state: "pending",
          expiresAt: MAIL_AT + 7 * 86_400_000,
          delivery: state.mailed ? "sent" : "none",
        });
        const link = state.mailed ? null : `https://kalzit.example.com/invite#token-${found.id}-2`;
        return json(200, { invitation: found, link });
      }
      if (action === undefined && request.method === "DELETE") {
        state.invitations = state.invitations.filter((invitation) => invitation.id !== id);
        return new Response(null, { status: 204 });
      }
      return error(404, "not_found");
    },
  };
}

/** The routes outside organizations: the mail server and the pages behind the links. */
export function handleMailRoute(
  state: FakeMailState,
  server: FakeServer,
  path: string,
  method: string,
  body: Record<string, unknown>,
): Response | undefined {
  const route = path.split("?")[0] ?? "";
  if (route.startsWith("/api/admin/mail")) {
    if (!server.state.signedIn) return error(401, "unauthenticated");
    if (!server.state.user.isServerAdmin) return error(403, "forbidden");
    if (route === "/api/admin/mail" && method === "GET") return json(200, state.view);
    if (route === "/api/admin/mail" && method === "PUT") {
      const answer = take(state, "saveAnswer");
      if (answer !== undefined) return refusal(answer);
      if (body.version !== state.view.version) {
        return json(409, {
          error: { code: "version_conflict", message: "changed meanwhile" },
          current: state.view,
        });
      }
      const settings = body.settings as MailView["settings"];
      state.view = {
        ...state.view,
        settings,
        source: settings === null ? "default" : "database",
        hasPassword:
          settings !== null &&
          (typeof body.password === "string" ? body.password !== "" : state.view.hasPassword),
        version: state.view.version + 1,
      };
      return json(200, state.view);
    }
    if (route === "/api/admin/mail/test" && method === "POST") {
      const answer = state.testAnswer;
      return "status" in answer ? refusal(answer) : json(200, answer);
    }
    return undefined;
  }
  if (route === "/api/auth/invitation" && method === "POST") {
    const info = state.links[String(body.token)];
    return info === undefined
      ? refusal({ status: 404, code: "not_found", reason: "mail.invite_invalid" })
      : json(200, info);
  }
  if (route === "/api/auth/invitation/accept" && method === "POST") {
    const answer = take(state, "acceptAnswer");
    if (answer !== undefined) return refusal(answer);
    const info = state.links[String(body.token)];
    if (info === undefined) {
      return refusal({ status: 404, code: "not_found", reason: "mail.invite_invalid" });
    }
    const user: Me = state.joined ?? {
      id: "u9",
      email: info.email,
      name: String(body.name ?? ""),
      isServerAdmin: false,
      orgs: [{ id: "o1", name: info.orgName, role: info.role }],
    };
    info.state = "accepted";
    if (state.acceptSecondFactor !== undefined) {
      return json(200, { secondFactor: state.acceptSecondFactor });
    }
    server.state.signedIn = true;
    server.state.user = user;
    return json(200, user);
  }
  if (route === "/api/me/email-confirmation" && method === "POST") {
    if (!server.state.signedIn) return error(401, "unauthenticated");
    if (!state.resetAvailable) {
      return refusal({ status: 409, code: "conflict", reason: "mail.reset_unavailable" });
    }
    state.confirmRequests += 1;
    return json(200, DELIVERED);
  }
  if (route === "/api/me/email-confirmation/confirm" && method === "POST") {
    if (!server.state.signedIn) return error(401, "unauthenticated");
    const token = String(body.token);
    if (!state.confirmations.includes(token)) {
      return refusal({ status: 404, code: "not_found", reason: "mail.confirm_invalid" });
    }
    state.confirmations = state.confirmations.filter((t) => t !== token);
    return new Response(null, { status: 204 });
  }
  if (route === "/api/auth/password-reset" && method === "GET") {
    return json(200, { available: state.resetAvailable });
  }
  if (route === "/api/auth/password-reset" && method === "POST") {
    if (!state.resetAvailable) {
      return refusal({ status: 409, code: "conflict", reason: "mail.reset_unavailable" });
    }
    state.resetRequests.push(String(body.email));
    return json(202, { accepted: true });
  }
  if (route === "/api/auth/password-reset/inspect" && method === "POST") {
    const link = state.resets[String(body.token)];
    return link === undefined
      ? refusal({ status: 404, code: "not_found", reason: "mail.reset_invalid" })
      : json(200, link);
  }
  if (route === "/api/auth/password-reset/complete" && method === "POST") {
    const token = String(body.token);
    if (state.resets[token] === undefined) {
      return refusal({ status: 404, code: "not_found", reason: "mail.reset_invalid" });
    }
    delete state.resets[token];
    if ("signOutEverywhere" in body) return error(422, "validation");
    state.completed.push({ token, password: String(body.password) });
    return new Response(null, { status: 204 });
  }
  return undefined;
}
