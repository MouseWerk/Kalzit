import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import type { Me } from "../../api/auth";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { AccessDialog, type AccessResource } from "./access";
import { fakeAdmin } from "./test/fakeAdmin";
import { ALL_PERMISSIONS } from "./test/openAdmin";

/**
 * The dialog as another area uses it: a page with a button that opens it. The page sits under a
 * route with the id "_app" that provides the signed-in user, as the app's sign-in guard does.
 */
function Harness({ resource }: { resource: AccessResource }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Access…
      </button>
      <AccessDialog open={open} onClose={() => setOpen(false)} resource={resource} />
    </>
  );
}

function renderHarness(permissions: string[], resource: AccessResource, managesResources = true) {
  const me: Me = {
    ...TEST_USER,
    isServerAdmin: false,
    orgs: [{ id: "o1", name: "Analytical Engines", role: "tester" }],
  };
  const server = installFakeServer({
    signedIn: true,
    user: me,
    rolePermissions: { tester: permissions },
  });
  const admin = fakeAdmin(server);
  admin.callerPermissions = new Set(permissions);
  admin.managesResources = managesResources;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: Outlet });
  const app = createRoute({
    getParentRoute: () => root,
    id: "_app",
    beforeLoad: () => ({ me }),
    component: Outlet,
  });
  const page = createRoute({
    getParentRoute: () => app,
    path: "/",
    component: () => <Harness resource={resource} />,
  });
  const router = createRouter({
    routeTree: root.addChildren([app.addChildren([page])]),
    context: { queryClient },
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { server, admin, user: userEvent.setup() };
}

const DASHBOARD: AccessResource = { type: "dashboard", id: "d1", name: "Revenue" };

describe("access dialog", () => {
  it("lists the grants of a resource and returns focus when closed", async () => {
    const { user } = renderHarness(ALL_PERMISSIONS, DASHBOARD);
    const opener = await screen.findByRole("button", { name: "Access…" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Access to “Revenue”" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const list = await within(dialog).findByRole("list", { name: "Granted access" });
    expect(within(list).getByText("Analysts")).toBeTruthy();
    expect(within(list).getByText("Can edit")).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("gives a user access with a level, removes it with undo and keeps focus in the dialog", async () => {
    const { user, admin } = renderHarness(ALL_PERMISSIONS, DASHBOARD);
    await user.click(await screen.findByRole("button", { name: "Access…" }));
    const dialog = screen.getByRole("dialog");
    await user.selectOptions(await within(dialog).findByLabelText("Give access to"), "user");
    await user.selectOptions(await within(dialog).findByLabelText("User"), "u3");
    await user.selectOptions(within(dialog).getByLabelText("Access"), "view");
    await user.click(within(dialog).getByRole("button", { name: "Give access" }));
    expect(
      await within(dialog).findByText("Alan Turing (alan@example.com) now has access."),
    ).toBeTruthy();
    expect(admin.grants.at(-1)).toMatchObject({
      subjectType: "user",
      subjectId: "u3",
      resourceType: "dashboard",
      resourceId: "d1",
      level: "view",
    });

    await user.click(within(dialog).getByRole("button", { name: "Remove access of Analysts" }));
    expect(await within(dialog).findByText("Access of Analysts was removed.")).toBeTruthy();
    expect(admin.grants.some((grant) => grant.subjectId === "t1")).toBe(false);
    // The removed row's button is gone; focus stays inside the dialog, on the list's heading.
    expect(document.activeElement).toBe(
      within(dialog).getByRole("heading", { name: "Granted access" }),
    );
    await user.click(within(dialog).getByRole("button", { name: "Undo" }));
    expect(await within(dialog).findByText("Access of Analysts was restored.")).toBeTruthy();
    expect(admin.grants.some((grant) => grant.subjectId === "t1")).toBe(true);
  });

  it("changes the level when the subject already has access", async () => {
    const { user, admin } = renderHarness(ALL_PERMISSIONS, DASHBOARD);
    await user.click(await screen.findByRole("button", { name: "Access…" }));
    const dialog = screen.getByRole("dialog");
    await user.selectOptions(await within(dialog).findByLabelText("Give access to"), "team");
    await user.selectOptions(await within(dialog).findByLabelText("Team"), "t1");
    await user.selectOptions(within(dialog).getByLabelText("Access"), "admin");
    await user.click(within(dialog).getByRole("button", { name: "Give access" }));
    const list = within(dialog).getByRole("list", { name: "Granted access" });
    expect(await within(list).findByText("Can manage")).toBeTruthy();
    expect(admin.grants.filter((grant) => grant.subjectId === "t1")).toHaveLength(1);
  });

  it("offers query instead of view for data sources", async () => {
    const { user } = renderHarness(ALL_PERMISSIONS, {
      type: "datasource",
      id: "ds1",
      name: "Sales",
    });
    await user.click(await screen.findByRole("button", { name: "Access…" }));
    const levels = await within(screen.getByRole("dialog")).findByLabelText("Access");
    expect(
      within(levels)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Can query", "Can edit", "Can manage"]);
  });

  it("says so when the server does not let the user see who has access", async () => {
    // Org-wide permissions say nothing here: the manage permission may come from a grant on the
    // resource, so the dialog follows the server's answer to the list.
    const { user, server } = renderHarness(ALL_PERMISSIONS, DASHBOARD, false);
    await user.click(await screen.findByRole("button", { name: "Access…" }));
    const dialog = screen.getByRole("dialog");
    expect(
      await within(dialog).findByText(
        "You cannot see who has access to this. Ask someone who manages its access.",
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: /Remove access/ })).toBeNull();
    expect(within(dialog).queryByRole("button", { name: "Give access" })).toBeNull();
    expect(server.calls.map((call) => call.path)).toContain(
      "/api/orgs/o1/grants?resourceType=dashboard&resourceId=d1",
    );
  });

  it("lets a member manage access through a grant, without the permission in their role", async () => {
    const { user } = renderHarness(["users:read", "teams:read"], DASHBOARD, true);
    await user.click(await screen.findByRole("button", { name: "Access…" }));
    const dialog = screen.getByRole("dialog");
    expect(await within(dialog).findByRole("button", { name: "Give access" })).toBeTruthy();
  });

  it("offers only the kinds of subjects the user may see", async () => {
    const { user } = renderHarness(["dashboards:share", "teams:read"], DASHBOARD);
    await user.click(await screen.findByRole("button", { name: "Access…" }));
    const to = await within(screen.getByRole("dialog")).findByLabelText("Give access to");
    expect(
      within(to)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Team"]);
  });

  it("maps a refused grant to a readable text", async () => {
    const { user, server } = renderHarness(ALL_PERMISSIONS, DASHBOARD);
    await user.click(await screen.findByRole("button", { name: "Access…" }));
    const dialog = screen.getByRole("dialog");
    await within(dialog).findByRole("list", { name: "Granted access" });
    server.failNext("/api/orgs/o1/grants", 403, "forbidden", "POST");
    await user.click(await within(dialog).findByRole("button", { name: "Give access" }));
    expect(
      await within(dialog).findByText(
        "You can only give access up to what you may do on this yourself.",
      ),
    ).toBeTruthy();
  });

  it("closes the topmost layer first on Escape and keeps Tab inside", async () => {
    const { user } = renderHarness(ALL_PERMISSIONS, DASHBOARD);
    const opener = await screen.findByRole("button", { name: "Access…" });
    await user.click(opener);
    const dialog = screen.getByRole("dialog", { name: "Access to “Revenue”" });
    const why = within(dialog).getByRole("button", {
      name: "Why do I have this permission? Give users and teams of this organization access to dashboards.",
    });
    await user.click(why);
    expect(screen.getByRole("dialog", { name: "Where this permission comes from" })).toBeTruthy();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Where this permission comes from" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Access to “Revenue”" })).toBeTruthy();
    expect(document.activeElement).toBe(why);

    // Tab from the last control wraps to the first one inside the dialog.
    const close = within(dialog).getByRole("button", { name: "Close" });
    close.focus();
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(opener);
  });
});
