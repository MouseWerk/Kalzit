import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { request } from "../api/client";
import { expectConsoleOutput } from "../test/console";
import { installFakeServer, TEST_PASSWORD, TEST_USER } from "../test/fakeServer";
import { renderApp } from "../test/renderApp";
import { parseLoginSearch } from "./router";

async function signIn(user: ReturnType<typeof renderApp>["user"], password = TEST_PASSWORD) {
  await user.click(await screen.findByLabelText("Email address"));
  await user.paste(TEST_USER.email);
  await user.click(screen.getByLabelText("Password"));
  await user.paste(password);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("route guards", () => {
  it("sends every page to setup while setup is needed", async () => {
    installFakeServer({ setupNeeded: true });
    const { location } = renderApp("/dashboards");
    expect(await screen.findByRole("heading", { name: "Confirm this server" })).toBeTruthy();
    expect(location().pathname).toBe("/setup");
  });

  it("sends the login page to setup while setup is needed", async () => {
    installFakeServer({ setupNeeded: true });
    const { location } = renderApp("/login");
    await screen.findByRole("heading", { name: "Confirm this server" });
    expect(location().pathname).toBe("/setup");
  });

  it("closes the setup page once setup is done: it only says so, with the way to sign in", async () => {
    installFakeServer({ setupNeeded: false });
    const { user, location } = renderApp("/setup");
    await screen.findByRole("heading", { name: "Kalzit is already set up" });
    expect(location().pathname).toBe("/setup");
    expect(screen.queryByRole("navigation", { name: "Setup steps" })).toBeNull();
    expect(screen.queryByLabelText("Setup code")).toBeNull();
    await user.click(screen.getByRole("link", { name: "Go to sign-in" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
  });

  it("sends someone signed in from the closed setup page to Start", async () => {
    installFakeServer({ setupNeeded: false, signedIn: true });
    const { location } = renderApp("/setup");
    await waitFor(() => expect(location().pathname).toBe("/"));
  });

  it("sends a signed-out user to sign in and back to the requested page afterwards", async () => {
    installFakeServer();
    const { user, location } = renderApp("/data-sources?view=all");
    await screen.findByRole("heading", { name: "Sign in" });
    expect(location().pathname).toBe("/login");
    expect(location().search).toEqual({ redirect: "/data-sources?view=all" });

    await signIn(user);
    expect(await screen.findByRole("heading", { level: 1, name: "Data sources" })).toBeTruthy();
    expect(location().pathname).toBe("/data-sources");
  });

  it("adds no redirect parameter for the home page", async () => {
    installFakeServer();
    const { location } = renderApp("/");
    await screen.findByRole("heading", { name: "Sign in" });
    expect(location().search).toEqual({});
  });

  it("ignores a redirect parameter that leaves the site", async () => {
    installFakeServer();
    const { user, location } = renderApp("/login?redirect=%2F%2Fevil.example%2F");
    await signIn(user);
    await screen.findByRole("heading", { name: `Welcome, ${TEST_USER.name}` });
    expect(location().pathname).toBe("/");
  });

  it("skips the login page for a signed-in user", async () => {
    installFakeServer({ signedIn: true });
    const { location } = renderApp("/login?redirect=%2Fexplore");
    await screen.findByRole("heading", { level: 1, name: "Explore" });
    expect(location().pathname).toBe("/explore");
  });

  it("shows the error page when the server cannot be reached, and recovers on retry", async () => {
    const server = installFakeServer({ signedIn: true });
    server.state.offline = true;
    expectConsoleOutput(/Failed to fetch/, /Error in route match/);
    const { user } = renderApp("/");
    expect(
      await screen.findByText(
        "The server cannot be reached. Check that it is running, then try again.",
      ),
    ).toBeTruthy();
    server.state.offline = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: `Welcome, ${TEST_USER.name}` })).toBeTruthy();
  });

  it("shows an unknown server error as an internal error, and recovers on retry", async () => {
    const server = installFakeServer({ signedIn: true });
    server.failNext("/api/setup", 502, "not-a-known-code");
    // React and the router report the error that reached the error boundary.
    expectConsoleOutput(/server message for not-a-known-code/, /Error in route match/);
    const { user } = renderApp("/");
    expect(
      await screen.findByText(
        "Something went wrong on the server. Try again; if it keeps happening, check the server log.",
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: `Welcome, ${TEST_USER.name}` })).toBeTruthy();
  });

  it("does not repeat a sign-in the server answered busy", async () => {
    const server = installFakeServer();
    server.failNext("/api/auth/login", 503, "busy", "POST");
    // Retries on, as in the real app: the sign-in itself opts out.
    const { user } = renderApp("/login", { retry: true });
    await signIn(user);
    expect(
      await screen.findByText("The server is busy right now. Try again in a moment."),
    ).toBeTruthy();
    expect(server.calls.filter((c) => c.path === "/api/auth/login")).toHaveLength(1);
  });

  it("returns to sign in when the session ends while the app is open", async () => {
    const server = installFakeServer({ signedIn: true });
    const { app, location } = renderApp("/dashboards");
    await screen.findByRole("heading", { level: 1, name: "Dashboards" });

    server.state.signedIn = false;
    // Any query that meets the expired session reports it, not only the user query.
    await app.queryClient
      .fetchQuery({ queryKey: ["probe"], queryFn: () => request("GET", "/api/me") })
      .catch(() => undefined);

    await waitFor(() => expect(location().pathname).toBe("/login"));
    expect(location().search).toEqual({ redirect: "/dashboards", expired: true });
    // The sign-in page says why, in a status region.
    const why = await screen.findByText("Your session has expired.");
    expect(why.closest('[role="status"]')).toBeTruthy();
  });

  it("notices a session that ended on the server at the next navigation", async () => {
    const server = installFakeServer({ signedIn: true });
    const { app, user, location } = renderApp("/dashboards");
    await screen.findByRole("heading", { level: 1, name: "Dashboards" });
    // The shell loads data of its own (the setup checklist); a request of it still on its way
    // would meet the ended session before the navigation does.
    await waitFor(() => expect(app.queryClient.isFetching()).toBe(0));

    server.state.signedIn = false;
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    await user.click(await within(nav).findByRole("link", { name: "Explore" }));

    await screen.findByRole("heading", { name: "Sign in" });
    expect(location().search).toEqual({ redirect: "/explore" });
  });

  it("asks the server for the user on a click, but not when a link is only preloaded", async () => {
    const server = installFakeServer({ signedIn: true });
    const { app, user } = renderApp("/dashboards");
    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    const meCalls = () => server.calls.filter((call) => call.path === "/api/me").length;
    const before = meCalls();

    // What hovering a link does (defaultPreload "intent"), awaited so the check is not racy.
    await user.hover(await within(nav).findByRole("link", { name: "Explore" }));
    await app.router.preloadRoute({ to: "/explore" });
    expect(meCalls()).toBe(before);

    await user.click(await within(nav).findByRole("link", { name: "Explore" }));
    await screen.findByRole("heading", { level: 1, name: "Explore" });
    expect(meCalls()).toBe(before + 1);
  });

  it("notices a changed role at the next navigation", async () => {
    // Not a server admin, so the entry depends on the organization's permissions alone.
    const owner = { ...TEST_USER, isServerAdmin: false };
    const server = installFakeServer({ signedIn: true, user: owner });
    const { user } = renderApp("/");
    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    expect(await within(nav).findByRole("link", { name: "Administration" })).toBeTruthy();

    server.state.user = { ...owner, orgs: [{ id: "o1", name: "Org", role: "viewer" }] };
    await user.click(within(nav).getByRole("link", { name: "Dashboards" }));
    await waitFor(() =>
      expect(within(nav).queryByRole("link", { name: "Administration" })).toBeNull(),
    );
  });

  it("asks only for the setup status while setup is needed", async () => {
    const server = installFakeServer({ setupNeeded: true });
    renderApp("/dashboards");
    await screen.findByRole("heading", { name: "Confirm this server" });
    expect(server.calls.map((call) => call.path)).not.toContain("/api/me");
  });

  it("shows unknown addresses as not found", async () => {
    installFakeServer({ signedIn: true });
    renderApp("/does-not-exist");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
  });
});

describe("parseLoginSearch", () => {
  it("keeps a same-origin path", () => {
    expect(parseLoginSearch({ redirect: "/explore?q=1" })).toEqual({ redirect: "/explore?q=1" });
  });

  it("keeps the signed-out marker only as true", () => {
    expect(parseLoginSearch({ signedOut: true }).signedOut).toBe(true);
    expect(parseLoginSearch({ signedOut: "true" }).signedOut).toBe(true);
    expect(parseLoginSearch({ signedOut: "yes" }).signedOut).toBeUndefined();
    expect(parseLoginSearch({ signedOut: 1 }).signedOut).toBeUndefined();
  });

  it("overrides absolute, protocol-relative and non-string targets with undefined", () => {
    // The key must be present: the router merges this result over the raw search.
    const dropped = { redirect: undefined, signedOut: undefined, expired: undefined };
    expect(parseLoginSearch({ redirect: "https://evil.example/" })).toStrictEqual(dropped);
    expect(parseLoginSearch({ redirect: "//evil.example/" })).toStrictEqual(dropped);
    expect(parseLoginSearch({ redirect: 42 })).toStrictEqual(dropped);
    expect(parseLoginSearch({})).toStrictEqual(dropped);
  });
});

describe("login", () => {
  it("announces wrong credentials in the alert region and focuses the password", async () => {
    installFakeServer();
    const { user } = renderApp("/login");
    await signIn(user, "wrong password");
    const alert = await screen.findByText("Email address or password is not correct.");
    expect(alert.closest('[role="alert"]')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Password"));
  });

  it("explains rate limiting in its own words", async () => {
    const server = installFakeServer();
    server.failNext("/api/auth/login", 429, "rate_limited");
    const { user } = renderApp("/login");
    await signIn(user);
    expect(await screen.findByText("Too many failed sign-ins.")).toBeTruthy();
    expect(screen.queryByText(/server message/)).toBeNull();
  });

  it("explains a cross-origin rejection with the settings to fix", async () => {
    const server = installFakeServer();
    server.failNext("/api/auth/login", 403, "cross_origin");
    const { user } = renderApp("/login");
    await signIn(user);
    expect(
      await screen.findByText(/set server\.public_url or security\.trusted_proxies/),
    ).toBeTruthy();
  });

  it("marks and focuses the field a server validation error names", async () => {
    const server = installFakeServer();
    server.failNext("/api/auth/login", 400, "validation", "POST", "email");
    const { user } = renderApp("/login");
    await signIn(user);
    const email = screen.getByLabelText("Email address");
    await waitFor(() => expect(email.getAttribute("aria-invalid")).toBe("true"));
    expect(document.activeElement).toBe(email);
    expect(
      screen.getByText("The server did not accept this value. Check it and try again."),
    ).toBeTruthy();
  });

  it("validates the email address before sending", async () => {
    const server = installFakeServer();
    const { user } = renderApp("/login");
    await user.type(await screen.findByLabelText("Email address"), "not-an-address");
    await user.type(screen.getByLabelText("Password"), "x");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByText("Enter an email address like name@example.com.")).toBeTruthy();
    expect(server.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("sets autocomplete hints for password managers", async () => {
    installFakeServer();
    renderApp("/login");
    expect((await screen.findByLabelText("Email address")).getAttribute("autocomplete")).toBe(
      "username",
    );
    expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe("current-password");
  });
});
