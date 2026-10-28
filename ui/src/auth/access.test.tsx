import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareGuide } from "../help/HelpPage";
import { installFakeServer, TEST_PASSWORD, TEST_SETUP_TOKEN, TEST_USER } from "../test/fakeServer";
import { renderApp } from "../test/renderApp";
import { formatWait } from "./countdown";
import { CODE_PATHS, DOCKER_COMMAND } from "./SetupCode";

type User = ReturnType<typeof renderApp>["user"];

afterEach(() => {
  vi.useRealTimers();
});

function describedText(element: HTMLElement): string[] {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter((id) => id !== "")
    .map((id) => document.getElementById(id)?.textContent ?? "");
}

async function fill(user: User, label: string, value: string) {
  const field = screen.getByLabelText(label);
  await user.clear(field);
  await user.click(field);
  await user.paste(value);
}

async function signIn(user: User, password = TEST_PASSWORD) {
  await user.click(await screen.findByLabelText("Email address"));
  await user.paste(TEST_USER.email);
  await user.click(screen.getByLabelText("Password"));
  await user.paste(password);
  await user.click(screen.getByRole("button", { name: "Sign in" }));
}

describe("sign-in page", () => {
  it("shows one card with the product, labels, hints for password managers and the top bar", async () => {
    installFakeServer();
    renderApp("/login");
    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeTruthy();
    expect(screen.getByText("With your account at Kalzit.")).toBeTruthy();
    const email = screen.getByLabelText("Email address");
    expect(email.getAttribute("autocomplete")).toBe("username");
    expect(email.getAttribute("placeholder")).toBe("name@company.com");
    expect(screen.getByLabelText("Password").getAttribute("autocomplete")).toBe("current-password");
    // "Stay signed in" would need short and long sessions, which the server does not have yet;
    // the one choice is not to remember a browser that is not the user's, off by default.
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(1);
    expect(checkboxes[0]?.getAttribute("name")).toBe("forgetBrowser");
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("button", { name: "Language: English" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Theme: System" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Help" }).getAttribute("href")).toBe(
      "/help/getting-started",
    );
    expect(
      screen.getByText("No account yet? Ask an admin of your organization for an invitation."),
    ).toBeTruthy();
    // One primary (copper) button on the screen.
    expect(document.querySelectorAll(".button--primary")).toHaveLength(1);
  });

  it("switches the language from the top bar", async () => {
    installFakeServer();
    const { user } = renderApp("/login");
    await user.click(await screen.findByRole("button", { name: "Language: English" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Deutsch" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Anmelden" })).toBeTruthy();
    expect(screen.getByLabelText("E-Mail-Adresse")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Sprache: Deutsch" }));
    await user.click(screen.getByRole("menuitemradio", { name: "English" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeTruthy();
  });

  it("explains a forgotten password without sending anything", async () => {
    const server = installFakeServer();
    const { user } = renderApp("/login");
    const forgot = await screen.findByRole("button", { name: "Forgot password?" });
    expect(forgot.getAttribute("aria-expanded")).toBe("false");
    await user.click(forgot);
    expect(forgot.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("An admin of your organization can reset your password.")).toBeTruthy();
    expect(server.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("marks empty fields with their own message and focuses the first", async () => {
    const server = installFakeServer();
    const { user } = renderApp("/login");
    await user.click(await screen.findByRole("button", { name: "Sign in" }));
    const email = screen.getByLabelText("Email address");
    expect(document.activeElement).toBe(email);
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(describedText(email)).toContain("Enter your email address.");
    expect(describedText(screen.getByLabelText("Password"))).toContain("Enter your password.");
    expect(server.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("names wrong credentials in an alert with what to do, keeping the email", async () => {
    installFakeServer();
    const { user } = renderApp("/login");
    await signIn(user, "wrong password");
    const alert = await screen.findByText("Email address or password is not correct.");
    expect(alert.closest('[role="alert"]')).toBeTruthy();
    expect(
      screen.getByText(
        "Check what you entered. After several failed attempts you have to wait a while.",
      ),
    ).toBeTruthy();
    expect((screen.getByLabelText("Email address") as HTMLInputElement).value).toBe(
      TEST_USER.email,
    );
    expect(document.activeElement).toBe(screen.getByLabelText("Password"));
  });

  it("keeps the fields readable but fixed while signing in", async () => {
    const server = installFakeServer();
    const release = server.holdNext("/api/auth/login");
    const { user, location } = renderApp("/login");
    await signIn(user);
    const busy = await screen.findByRole("button", { name: "Signing in…" });
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByLabelText("Email address").hasAttribute("readonly")).toBe(true);
    expect(screen.getByLabelText("Password").hasAttribute("readonly")).toBe(true);
    release();
    await waitFor(() => expect(location().pathname).toBe("/"));
  });

  it("counts down the wait after too many failures and announces its end", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const server = installFakeServer();
    server.rateLimitNext("/api/auth/login", 238);
    const { user } = renderApp("/login");
    await signIn(user);

    const alert = await screen.findByText("Too many failed sign-ins.");
    expect(alert.closest('[role="alert"]')).toBeTruthy();
    expect(
      screen.getByText("Try again in about 4 minutes. The button counts down the time."),
    ).toBeTruthy();
    const button = screen.getByRole("button", { name: /^Possible again in 3:5\d$/ });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.classList.contains("button--primary")).toBe(false);

    // A press while waiting sends nothing.
    const sent = server.calls.length;
    fireEvent.click(button);
    expect(server.calls.length).toBe(sent);

    await act(async () => {
      vi.advanceTimersByTime(240_000);
    });
    const ready = await screen.findByText("You can sign in again.");
    expect(ready.closest('[role="status"]')).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" }).getAttribute("aria-disabled")).toBe(
      "false",
    );
  });

  it("says the session expired and where it goes on", async () => {
    installFakeServer();
    renderApp("/login?redirect=%2Fexplore&expired=true");
    const notice = await screen.findByText("Your session has expired.");
    expect(notice.closest('[role="status"]')).toBeTruthy();
    expect(screen.getByText("Sign in again to continue where you left off.")).toBeTruthy();
  });

  it("shows the admin's welcome text and notice", async () => {
    const server = installFakeServer();
    server.state.branding = {
      ...server.state.branding,
      signIn: {
        welcome: "Welcome to the **plant** dashboards.",
        notice: "Maintenance on Saturday.",
      },
    };
    renderApp("/login");
    expect(await screen.findByText("plant")).toBeTruthy();
    expect(screen.queryByText("With your account at Kalzit.")).toBeNull();
    const notice = screen.getByText("Maintenance on Saturday.");
    expect(notice.closest('[role="note"]')).toBeTruthy();
  });
});

describe("countdown", () => {
  it("shows minutes and seconds", () => {
    expect(formatWait(238)).toBe("3:58");
    expect(formatWait(5)).toBe("0:05");
    expect(formatWait(0)).toBe("0:00");
    expect(formatWait(60.2)).toBe("1:01");
  });
});

async function passCode(user: User, code = TEST_SETUP_TOKEN) {
  await user.click(await screen.findByLabelText("Setup code"));
  await user.paste(code);
  await user.click(screen.getByRole("button", { name: "Next" }));
}

async function fillAccount(user: User) {
  await screen.findByRole("heading", { level: 1, name: "Your account" });
  await fill(user, "Your name", "Zoë Ångström");
  await fill(user, "Email address", "zoe@example.com");
  await fill(user, "Password", "Twelve-chars-1");
  await user.click(screen.getByRole("button", { name: "Next" }));
}

async function toOrgStep(user: User) {
  await passCode(user);
  await fillAccount(user);
  await screen.findByRole("heading", { level: 1, name: "Your organization" });
  await fill(user, "Organization name", "Müller & Söhne");
}

function stepper() {
  return screen.getByRole("navigation", { name: "Setup steps" });
}

describe("setup, step 1: the setup code", () => {
  it("starts with the code, the steps and where to find it, preselected for this server", async () => {
    installFakeServer({ setupNeeded: true, codeHint: "docker" });
    renderApp("/setup");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Confirm this server" }),
    ).toBeTruthy();
    expect(within(stepper()).getByRole("listitem", { current: "step" }).textContent).toContain(
      "Setup code",
    );
    const code = screen.getByLabelText("Setup code");
    expect(code.getAttribute("autocomplete")).toBe("one-time-code");
    expect(code.getAttribute("spellcheck")).toBe("false");
    expect(describedText(code)).toContain("Case, spaces and dashes do not matter.");

    const docker = screen.getByRole("tab", { name: /Docker/ });
    expect(docker.getAttribute("aria-selected")).toBe("true");
    expect(within(screen.getByRole("tabpanel")).getByText(DOCKER_COMMAND)).toBeTruthy();
  });

  it("shows only the default paths per system, and moves between tabs with arrow keys", async () => {
    installFakeServer({ setupNeeded: true });
    const { user } = renderApp("/setup");
    const file = await screen.findByRole("tab", { name: /File/ });
    expect(file.getAttribute("aria-selected")).toBe("true");
    const panel = screen.getByRole("tabpanel");
    expect(within(panel).getByText(CODE_PATHS.windows)).toBeTruthy();
    expect(within(panel).getByText(CODE_PATHS.linux)).toBeTruthy();
    expect(within(panel).getByRole("button", { name: `Copy ${CODE_PATHS.linux}` })).toBeTruthy();

    file.focus();
    await user.keyboard("{ArrowRight}");
    const log = screen.getByRole("tab", { name: /Server log/ });
    expect(log.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(log);
    await user.keyboard("{End}");
    expect(screen.getByRole("tab", { name: /Fixed code/ }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByText("KALZIT_SETUP_TOKEN")).toBeTruthy();
  });

  it("asks for a code before checking", async () => {
    const server = installFakeServer({ setupNeeded: true });
    const { user } = renderApp("/setup");
    await user.click(await screen.findByRole("button", { name: "Next" }));
    const code = screen.getByLabelText("Setup code");
    expect(document.activeElement).toBe(code);
    expect(describedText(code)).toContain("Enter the setup code.");
    expect(server.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("puts a wrong code on its field", async () => {
    const server = installFakeServer({ setupNeeded: true });
    const { user } = renderApp("/setup");
    await passCode(user, "wrong-code");
    const code = screen.getByLabelText("Setup code");
    await waitFor(() => expect(code.getAttribute("aria-invalid")).toBe("true"));
    expect(describedText(code)).toContain(
      "The code is not correct. Copy it again from “setup-token.txt”; after several failed attempts you have to wait a while.",
    );
    expect(document.activeElement).toBe(code);
    expect(server.calls.find((call) => call.path === "/api/setup/check")?.body).toEqual({
      token: "wrong-code",
    });
  });

  it("names the variable for a wrong fixed code", async () => {
    installFakeServer({ setupNeeded: true, codeHint: "fixed" });
    const { user } = renderApp("/setup");
    await passCode(user, "wrong-code");
    expect(
      await screen.findByText(
        "The code is not correct. Use the value of KALZIT_SETUP_TOKEN; after several failed attempts you have to wait a while.",
      ),
    ).toBeTruthy();
  });

  it("tells a code of the previous start from a typo", async () => {
    installFakeServer({ setupNeeded: true, previousSetupToken: "old-code-from-before" });
    const { user } = renderApp("/setup");
    await passCode(user, "old-code-from-before");
    expect(
      await screen.findByText(
        "This setup code is no longer valid. The server was restarted and made a new code; copy the current one from “setup-token.txt”.",
      ),
    ).toBeTruthy();
  });

  it("shows the check as busy, with the code readable but fixed", async () => {
    const server = installFakeServer({ setupNeeded: true });
    const release = server.holdNext("/api/setup/check");
    const { user } = renderApp("/setup");
    await passCode(user);
    const busy = await screen.findByRole("button", { name: "Checking…" });
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByLabelText("Setup code").hasAttribute("readonly")).toBe(true);
    release();
    await screen.findByRole("heading", { level: 1, name: "Your account" });
  });

  it("counts down a rate limit on the button", async () => {
    const server = installFakeServer({ setupNeeded: true });
    server.rateLimitNext("/api/setup/check", 42);
    const { user } = renderApp("/setup");
    await passCode(user);
    expect(await screen.findByRole("button", { name: /^Possible again in 0:4\d$/ })).toBeTruthy();
    expect(describedText(screen.getByLabelText("Setup code")).join(" ")).toContain(
      "Too many failed attempts from this device.",
    );
  });

  it("confirms a good code, moves on with focus on the heading, and keeps it when going back", async () => {
    const server = installFakeServer({ setupNeeded: true });
    const { user } = renderApp("/setup");
    await passCode(user, `  ${TEST_SETUP_TOKEN}  `);
    const heading = await screen.findByRole("heading", { level: 1, name: "Your account" });
    expect(document.activeElement).toBe(heading);
    expect(document.title).toContain("Step 2 of 4: Your account");
    const done = within(stepper())
      .getAllByRole("listitem")
      .find((item) => item.textContent?.includes("Setup code"));
    expect(done?.textContent).toContain(", done");
    expect(server.calls.find((call) => call.path === "/api/setup/check")?.body).toEqual({
      token: TEST_SETUP_TOKEN,
    });

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(
      await screen.findByText("Code confirmed. It stays valid until setup is complete."),
    ).toBeTruthy();
    expect((screen.getByLabelText("Setup code") as HTMLInputElement).value).toBe(
      `  ${TEST_SETUP_TOKEN}  `,
    );
    // Confirmed already: Next goes on without asking the server again.
    const checks = server.calls.filter((call) => call.path === "/api/setup/check").length;
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByRole("heading", { level: 1, name: "Your account" });
    expect(server.calls.filter((call) => call.path === "/api/setup/check")).toHaveLength(checks);
  });

  it("shows only the already-set-up card when the check finds setup done", async () => {
    const server = installFakeServer({ setupNeeded: true });
    const { user } = renderApp("/setup");
    await screen.findByLabelText("Setup code");
    server.state.setupNeeded = false;
    await passCode(user);
    expect(await screen.findByRole("heading", { name: "Kalzit is already set up" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Setup steps" })).toBeNull();
    expect(screen.getByRole("link", { name: "Go to sign-in" })).toBeTruthy();
  });
});

describe("setup, step 2: the account", () => {
  it("checks the fields on Next and focuses the first problem", async () => {
    installFakeServer({ setupNeeded: true });
    const { user } = renderApp("/setup");
    await passCode(user);
    await screen.findByRole("heading", { level: 1, name: "Your account" });
    await fill(user, "Email address", "zoe@example");
    await fill(user, "Password", "short");
    await user.click(screen.getByRole("button", { name: "Next" }));
    const name = screen.getByLabelText("Your name");
    expect(document.activeElement).toBe(name);
    expect(describedText(name)).toContain("Enter your name.");
    expect(describedText(screen.getByLabelText("Email address"))).toContain(
      "Enter an email address like name@example.com.",
    );
    expect(describedText(screen.getByLabelText("Password"))).toContain(
      "The password needs at least 12 characters.",
    );
  });

  it("ticks off the password rules while typing; mixed characters are only recommended", async () => {
    installFakeServer({ setupNeeded: true });
    const { user } = renderApp("/setup");
    await passCode(user);
    const password = await screen.findByLabelText("Password");
    expect(password.getAttribute("autocomplete")).toBe("new-password");
    const rules = screen.getByRole("list", { name: "Password rules" });
    expect(within(rules).getAllByText("not yet met")).toHaveLength(2);

    await user.type(password, "abcdefghijklmnop");
    expect(within(rules).getByText("At least 12 characters (16)")).toBeTruthy();
    expect(within(rules).getAllByText("met")).toHaveLength(1);
    expect(describedText(password)).toContain(
      "Good length. A mix of upper and lower case, digits and symbols makes it stronger.",
    );
    await user.type(password, "Q-9");
    expect(within(rules).getAllByText("met")).toHaveLength(2);
  });

  it("goes back to the code and forward again with everything kept", async () => {
    installFakeServer({ setupNeeded: true });
    const { user } = renderApp("/setup");
    await passCode(user);
    await screen.findByRole("heading", { level: 1, name: "Your account" });
    await fill(user, "Your name", "Zoë");
    await user.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("heading", { level: 1, name: "Confirm this server" });
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByRole("heading", { level: 1, name: "Your account" });
    expect((screen.getByLabelText("Your name") as HTMLInputElement).value).toBe("Zoë");
  });
});

describe("setup, step 3 and the finish", () => {
  it("creates organization and account with the chosen defaults, then shows the next steps", async () => {
    const server = installFakeServer({ setupNeeded: true });
    const { user, location } = renderApp("/setup");
    await toOrgStep(user);
    expect(screen.getByLabelText("Organization name").getAttribute("autocomplete")).toBe(
      "organization",
    );
    // Defaults: the language and theme of this page, the browser's time zone.
    expect((screen.getByRole("radio", { name: "English" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("radio", { name: /System/ }) as HTMLInputElement).checked).toBe(true);
    await user.click(screen.getByRole("radio", { name: "Deutsch" }));
    await user.click(screen.getByRole("radio", { name: /High contrast/ }));
    await user.click(screen.getByRole("button", { name: "Finish setup" }));

    expect(await screen.findByRole("heading", { level: 1, name: "All set, Zoë." })).toBeTruthy();
    expect(location().pathname).toBe("/setup");
    const body = server.calls.find((call) => call.path === "/api/setup" && call.method === "POST")
      ?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      token: TEST_SETUP_TOKEN,
      orgName: "Müller & Söhne",
      name: "Zoë Ångström",
      email: "zoe@example.com",
      password: "Twelve-chars-1",
      language: "de",
      theme: "contrast",
    });
    expect(typeof body.timeZone).toBe("string");
    expect(screen.getByText("Müller & Söhne is set up and you are signed in.")).toBeTruthy();
    expect(screen.getByText("Zoë Ångström · zoe@example.com")).toBeTruthy();
    expect(screen.getByText(/Deutsch · theme High contrast/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Add a data source/ }).getAttribute("href")).toBe(
      "/data-sources/new",
    );
    expect(
      screen.getByText("The setup code is deleted; the setup page is closed from now on."),
    ).toBeTruthy();
    expect(within(stepper()).getByRole("listitem", { current: "step" }).textContent).toContain(
      "Done",
    );
  });

  it("adds the sample data in one click and opens Explore on it", async () => {
    const server = installFakeServer({ setupNeeded: true });
    const { user, location } = renderApp("/setup");
    await toOrgStep(user);
    await user.click(screen.getByRole("button", { name: "Finish setup" }));
    await user.click(await screen.findByRole("button", { name: /Explore with sample data/ }));
    await waitFor(() => expect(location().pathname).toBe("/explore"));
    const call = server.calls.find((c) => c.path === "/api/orgs/o1/datasources/sample");
    expect(call?.body).toEqual({ name: "Sample data" });
    expect(location().search).toMatchObject({ source: expect.stringMatching(/^ds-sample-/) });
  });

  it("keeps the inputs and offers to try again when the server cannot be reached", async () => {
    const server = installFakeServer({ setupNeeded: true });
    const { user } = renderApp("/setup");
    await toOrgStep(user);
    server.state.offline = true;
    await user.click(screen.getByRole("button", { name: "Finish setup" }));
    const alert = await screen.findByText(
      "The server cannot be reached. Check that it is running, then try again.",
    );
    expect(alert.closest('[role="alert"]')).toBeTruthy();
    expect(screen.getByText("What you entered is kept.")).toBeTruthy();
    server.state.offline = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { level: 1, name: "All set, Zoë." })).toBeTruthy();
  });

  it("counts down a rate limit on the last step too, inputs kept", async () => {
    const server = installFakeServer({ setupNeeded: true });
    const { user } = renderApp("/setup");
    await toOrgStep(user);
    server.rateLimitNext("/api/setup", 75);
    await user.click(screen.getByRole("button", { name: "Finish setup" }));
    const wait = await screen.findByRole("button", { name: /^Possible again in 1:1\d$/ });
    expect(wait.getAttribute("aria-disabled")).toBe("true");
    const notice = screen.getByText(
      "Too many failed attempts from this device. Wait a moment; the button counts down the time.",
    );
    expect(notice.closest('[role="alert"]')).toBeTruthy();
    expect(screen.queryByText(/Too many attempts/)).toBeNull();
    // A press while waiting sends nothing.
    const sent = server.calls.length;
    await user.click(wait);
    expect(server.calls.length).toBe(sent);
    expect((screen.getByLabelText("Organization name") as HTMLInputElement).value).toBe(
      "Müller & Söhne",
    );
  });

  it("says when someone else finished setup in the meantime", async () => {
    const server = installFakeServer({ setupNeeded: true });
    const { user } = renderApp("/setup");
    await toOrgStep(user);
    server.state.setupNeeded = false;
    await user.click(screen.getByRole("button", { name: "Finish setup" }));
    expect(await screen.findByText("Someone else has set up Kalzit in the meantime.")).toBeTruthy();
    await user.click(screen.getByRole("link", { name: "Go to sign-in" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
  });

  it("goes back to the code, inputs kept, when the server restarted since the check", async () => {
    const server = installFakeServer({ setupNeeded: true });
    const { user } = renderApp("/setup");
    await toOrgStep(user);
    server.failNext("/api/setup", 403, "setup_token_expired", "POST");
    await user.click(screen.getByRole("button", { name: "Finish setup" }));
    expect(
      await screen.findByText("The server was restarted; the setup code has changed."),
    ).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Setup code")));
    await user.click(screen.getByRole("button", { name: "Next" }));
    await screen.findByRole("heading", { level: 1, name: "Your account" });
    expect((screen.getByLabelText("Your name") as HTMLInputElement).value).toBe("Zoë Ångström");
  });

  it("takes the user to the step and field a server validation error names", async () => {
    const server = installFakeServer({ setupNeeded: true });
    const { user } = renderApp("/setup");
    await toOrgStep(user);
    server.failNext("/api/setup", 422, "validation", "POST", "name");
    await user.click(screen.getByRole("button", { name: "Finish setup" }));
    const name = await screen.findByLabelText("Your name");
    await waitFor(() => expect(document.activeElement).toBe(name));
    expect(name.getAttribute("aria-invalid")).toBe("true");
  });
});

describe("help pages", () => {
  it("serves getting started without an account, with links kept inside the app", async () => {
    const server = installFakeServer({ setupNeeded: true });
    renderApp("/help/getting-started");
    expect(await screen.findByRole("heading", { level: 1, name: "Getting started" })).toBeTruthy();
    const body = document.querySelector(".help__body") as HTMLElement;
    const links = within(body).getAllByRole("link", { name: "Installation" });
    expect(links.map((link) => link.getAttribute("href"))).toEqual(
      links.map(() => "/help/installation"),
    );
    expect(document.querySelector(".help__body img")).toBeNull();
    expect(server.calls.map((call) => call.path)).not.toContain("/api/me");
  });

  it("knows only the shipped pages", async () => {
    installFakeServer();
    renderApp("/help/administration");
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
  });

  it("points links to unshipped pages at the repository and drops pictures", () => {
    const out = prepareGuide(
      "See [Installation](installation.md#docker), [Explore](explore.md) and [README](../../README.md#quick-start).\n![A picture](../screenshots/x.png)\n[Web](https://example.com)",
    );
    expect(out).toContain("[Installation](/help/installation#docker)");
    expect(out).toContain(
      "[Explore](https://github.com/MouseWerk/Kalzit/blob/main/docs/guide/explore.md)",
    );
    expect(out).toContain(
      "[README](https://github.com/MouseWerk/Kalzit/blob/main/README.md#quick-start)",
    );
    expect(out).not.toContain("![");
    expect(out).toContain("[Web](https://example.com)");
  });
});
