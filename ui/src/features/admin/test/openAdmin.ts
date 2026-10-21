import { screen } from "@testing-library/react";
import type { Me } from "../../../api/auth";
import { installFakeServer, TEST_USER } from "../../../test/fakeServer";
import { generatedUnion } from "../../../test/generated";
import { renderApp } from "../../../test/renderApp";
import { type FakeAdminState, fakeAdmin } from "./fakeAdmin";

/** Every permission the server knows, read from the generated types. */
export const ALL_PERMISSIONS = generatedUnion("Permission");

export interface OpenAdminOptions {
  /** Permissions of the signed-in member's role; all of them by default (an owner). */
  permissions?: string[];
  isServerAdmin?: boolean;
  user?: Partial<Me>;
  /** Changes the fake's data before the first request. */
  setup?: (admin: FakeAdminState) => void;
}

/**
 * Signs in to the fake server as a member of "Analytical Engines" with the given permissions and
 * opens `path`. The member's role is named "tester" so the permissions are exactly these.
 */
export async function openAdmin(path: string, options: OpenAdminOptions = {}) {
  const user: Me = {
    ...TEST_USER,
    isServerAdmin: options.isServerAdmin ?? false,
    orgs: [{ id: "o1", name: "Analytical Engines", role: "tester" }],
    ...options.user,
  };
  const server = installFakeServer({
    signedIn: true,
    user,
    rolePermissions: { tester: options.permissions ?? ALL_PERMISSIONS },
  });
  const admin = fakeAdmin(server);
  // The fake checks the same permissions the UI hides by.
  admin.callerPermissions = new Set(options.permissions ?? ALL_PERMISSIONS);
  options.setup?.(admin);
  const rendered = renderApp(path);
  await screen.findByRole("navigation", { name: "Main navigation" });
  return { ...rendered, server, admin };
}

/** The requests the UI sent, as "METHOD path" lines, for asserting what reached the server. */
export function sent(server: { calls: { method: string; path: string }[] }, method: string) {
  return server.calls.filter((call) => call.method === method).map((call) => call.path);
}
