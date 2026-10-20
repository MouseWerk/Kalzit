import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { request } from "../api/client";
import { expectConsoleOutput } from "../test/console";
import { installFakeServer, TEST_PASSWORD, TEST_SETUP_TOKEN, TEST_USER } from "../test/fakeServer";
import { renderApp } from "../test/renderApp";
import { parseLoginSearch } from "./router";

async function signIn(user: ReturnType<typeof renderApp>["user"], password = TEST_PASSWORD) {
  await user.type(await screen.findByLabelText("Email address"), TEST_USER.email);
  await user.type(screen.getByLabelText("Password"), password);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("route guards", () => {
  it("sends every page to setup while setup is needed", async () => {
    installFakeServer({ setupNeeded: true });
    const { location } = renderApp("/dashboards");
    expect(await screen.findByRole("heading", { name: "Set up Granit" })).toBeTruthy();
    expect(location().pathname).toBe("/setup");
  });

  it("sends the login page to setup while setup is needed", async () => {
    installFakeServer({ setupNeeded: true });
    const { location } = renderApp("/login");
    await screen.findByRole("heading", { name: "Set up Granit" });
    expect(location().pathname).toBe("/setup");
  });

  it("closes the setup page once setup is done", async () => {
    installFakeServer({ setupNeeded: false });
    const { location } = renderApp("/setup");
    await screen.findByRole("heading", { name: "Sign in" });
    expect(location().pathname).toBe("/login");
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
    expect(location().search).toEqual({ redirect: "/dashboards" });
  });

  it("notices a session that ended on the server at the next navigation", async () => {
    const server = installFakeServer({ signedIn: true });
    const { user, location } = renderApp("/dashboards");
    await screen.findByRole("heading", { level: 1, name: "Dashboards" });

    server.state.signedIn = false;
    const nav = screen.getByRole("navigation", { name: "Main navigation" });
    await user.click(within(nav).getByRole("link", { name: "Explore" }));

    await screen.findByRole("heading", { name: "Sign in" });
    expect(location().search).toEqual({ redirect: "/explore" });
  });

  it("notices a changed role at the next navigation", async () => {
    const server = installFakeServer({ signedIn: true });
    const { user } = renderApp("/");
    const nav = await screen.findByRole("navigation", { name: "Main navigation" });
    expect(within(nav).getByRole("link", { name: "Administration" })).toBeTruthy();

    server.state.user = {
      ...TEST_USER,
      isServerAdmin: false,
      orgs: [{ id: "o1", name: "Org", role: "viewer" }],
    };
    await user.click(within(nav).getByRole("link", { name: "Dashboards" }));
    await waitFor(() =>
      expect(within(nav).queryByRole("link", { name: "Administration" })).toBeNull(),
    );
  });

  it("asks only for the setup status while setup is needed", async () => {
    const server = installFakeServer({ setupNeeded: true });
    renderApp("/dashboards");
    await screen.findByRole("heading", { name: "Set up Granit" });
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

  it("overrides absolute, protocol-relative and non-string targets with undefined", () => {
    // The key must be present: the router merges this result over the raw search.
    const dropped = { redirect: undefined };
    expect(parseLoginSearch({ redirect: "https://evil.example/" })).toStrictEqual(dropped);
    expect(parseLoginSearch({ redirect: "//evil.example/" })).toStrictEqual(dropped);
    expect(parseLoginSearch({ redirect: 42 })).toStrictEqual(dropped);
    expect(parseLoginSearch({})).toStrictEqual(dropped);
  });
});

describe("setup", () => {
  it("creates the organization and account, then opens the home page", async () => {
    const server = installFakeServer({ setupNeeded: true });
    const { user, location } = renderApp("/setup");

    await user.type(await screen.findByLabelText("Setup code"), `  ${TEST_SETUP_TOKEN}  `);
    await user.type(screen.getByLabelText("Organization name"), "Müller & Söhne");
    await user.type(screen.getByLabelText("Your name"), "Zoë Ångström");
    await user.type(screen.getByLabelText("Email address"), "zoe@example.com");
    await user.type(screen.getByLabelText("Password"), "twelve chars");
    await user.click(screen.getByRole("button", { name: "Set up" }));

    expect(await screen.findByRole("heading", { name: "Welcome, Zoë Ångström" })).toBeTruthy();
    expect(location().pathname).toBe("/");
    expect(server.calls.find((call) => call.method === "POST")?.body).toEqual({
      token: TEST_SETUP_TOKEN,
      orgName: "Müller & Söhne",
      name: "Zoë Ångström",
      email: "zoe@example.com",
      password: "twelve chars",
    });
  });

  it("shows the password rule before the first attempt", async () => {
    installFakeServer({ setupNeeded: true });
    renderApp("/setup");
    const password = await screen.findByLabelText("Password");
    expect(password.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText("At least 12 characters.")).toBeTruthy();
  });

  it("validates locally, focuses the first problem and does not call the server", async () => {
    const server = installFakeServer({ setupNeeded: true });
    const { user } = renderApp("/setup");
    await user.click(await screen.findByRole("button", { name: "Set up" }));

    const token = screen.getByLabelText("Setup code");
    expect(document.activeElement).toBe(token);
    expect(token.getAttribute("aria-invalid")).toBe("true");
    const describedBy = token.getAttribute("aria-describedby") ?? "";
    const messages = describedBy.split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(messages).toContain("Enter the setup code.");
    expect(screen.getByText("Enter a name for the organization.")).toBeTruthy();
    expect(screen.getByText("Enter your name.")).toBeTruthy();
    expect(screen.getByText("Enter your email address.")).toBeTruthy();
    expect(screen.getByText("Enter your password.")).toBeTruthy();
    expect(server.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("clears a field's error as soon as it is edited", async () => {
    installFakeServer({ setupNeeded: true });
    const { user } = renderApp("/setup");
    await user.click(await screen.findByRole("button", { name: "Set up" }));
    await user.type(screen.getByLabelText("Setup code"), "x");
    expect(screen.queryByText("Enter the setup code.")).toBeNull();
    expect(screen.getByText("Enter your name.")).toBeTruthy();
  });

  it("puts a wrong setup code on its field", async () => {
    installFakeServer({ setupNeeded: true });
    const { user } = renderApp("/setup");
    await user.type(await screen.findByLabelText("Setup code"), "wrong");
    await user.type(screen.getByLabelText("Organization name"), "Org");
    await user.type(screen.getByLabelText("Your name"), "Ada");
    await user.type(screen.getByLabelText("Email address"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "long enough password");
    await user.click(screen.getByRole("button", { name: "Set up" }));

    expect(
      await screen.findByText(
        "The setup code is not correct. Copy it again from “setup-token.txt”.",
      ),
    ).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Setup code"));
  });

  it("marks the setup field a server validation error names", async () => {
    const server = installFakeServer({ setupNeeded: true });
    server.failNext("/api/setup", 400, "validation", "POST", "name");
    const { user } = renderApp("/setup");
    await user.type(await screen.findByLabelText("Setup code"), TEST_SETUP_TOKEN);
    await user.type(screen.getByLabelText("Organization name"), "Org");
    await user.type(screen.getByLabelText("Your name"), "Ada");
    await user.type(screen.getByLabelText("Email address"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "long enough password");
    await user.click(screen.getByRole("button", { name: "Set up" }));
    const name = screen.getByLabelText("Your name");
    await waitFor(() => expect(name.getAttribute("aria-invalid")).toBe("true"));
    expect(document.activeElement).toBe(name);
  });

  it("explains a cross-origin rejection of the setup request", async () => {
    const server = installFakeServer({ setupNeeded: true });
    server.failNext("/api/setup", 403, "cross_origin", "POST");
    const { user } = renderApp("/setup");
    await user.type(await screen.findByLabelText("Setup code"), TEST_SETUP_TOKEN);
    await user.type(screen.getByLabelText("Organization name"), "Org");
    await user.type(screen.getByLabelText("Your name"), "Ada");
    await user.type(screen.getByLabelText("Email address"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "long enough password");
    await user.click(screen.getByRole("button", { name: "Set up" }));
    const message = await screen.findByText(/set server\.public_url or security\.trusted_proxies/);
    expect(message.closest('[role="alert"]')).toBeTruthy();
  });

  it("offers the way to sign in when someone else finished setup first", async () => {
    const server = installFakeServer({ setupNeeded: true });
    const { user } = renderApp("/setup");
    await user.type(await screen.findByLabelText("Setup code"), TEST_SETUP_TOKEN);
    await user.type(screen.getByLabelText("Organization name"), "Org");
    await user.type(screen.getByLabelText("Your name"), "Ada");
    await user.type(screen.getByLabelText("Email address"), "ada@example.com");
    await user.type(screen.getByLabelText("Password"), "long enough password");
    server.state.setupNeeded = false;
    await user.click(screen.getByRole("button", { name: "Set up" }));

    const message = await screen.findByText("Granit is already set up. Sign in with your account.");
    expect(message.closest('[role="alert"]')).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "Go to sign in" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
  });
});

describe("login", () => {
  it("announces wrong credentials in the alert region and focuses the password", async () => {
    installFakeServer();
    const { user } = renderApp("/login");
    await signIn(user, "wrong password");
    const alert = await screen.findByText("Email address or password is incorrect.");
    expect(alert.closest('[role="alert"]')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText("Password"));
  });

  it("explains rate limiting in its own words", async () => {
    const server = installFakeServer();
    server.failNext("/api/auth/login", 429, "rate_limited");
    const { user } = renderApp("/login");
    await signIn(user);
    expect(
      await screen.findByText("Too many attempts. Wait a moment, then try again."),
    ).toBeTruthy();
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
