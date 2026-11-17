import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { setLanguage } from "../../i18n/i18n";
import type { FakeAdminState } from "../admin/test/fakeAdmin";
import { openAdmin } from "../admin/test/openAdmin";
import { checkOrigin, originProblem, validHeaderName } from "./corsCheck";
import { validDomain } from "./RegistrationSection";
import { S3_TARGET, sampleRun } from "./test/fake075";

type Stored = FakeAdminState["serverSettings"][number];

const setting = (key: string, value: unknown, extra: Partial<Stored> = {}): Stored => ({
  key,
  scope: "server",
  value,
  default: value,
  source: "default",
  editable: true,
  version: 0,
  description: key,
  updatedAt: null,
  updatedBy: null,
  ...extra,
});

const CORS = (extra: Record<string, Partial<Stored>> = {}) => [
  setting("cors.enabled", true, extra["cors.enabled"]),
  setting(
    "cors.allowed_origins",
    ["https://portal.example.com", "https://*.intranet.example.com"],
    extra["cors.allowed_origins"],
  ),
  setting("cors.allowed_methods", ["GET", "POST"], extra["cors.allowed_methods"]),
  setting("cors.allowed_headers", ["Authorization", "Content-Type"]),
  setting("cors.allow_credentials", false),
  setting("cors.max_age_secs", 600),
];

const REGISTRATION = [
  setting("registration.enabled", false),
  setting("registration.allowed_domains", ["example.com"]),
  setting("registration.default_org", ""),
  setting("registration.default_role", "viewer"),
  setting("registration.require_approval", true),
  setting("registration.max_per_ip_hour", 5),
  setting("registration.max_per_email_day", 3),
  setting("registration.max_per_server_day", 50),
  setting("signin.local_password", "on", { editable: false }),
];

const BACKUPS = [
  setting("backups.schedule_enabled", false),
  setting("backups.interval_hours", 24),
  setting("backups.keep_count", 14),
  setting("backups.encrypt", true),
  setting("backups.allowed_dirs", ["D:\\Backups"]),
];

const open = (path: string, settings: Stored[], setupServer?: Parameters<typeof openAdmin>[1]) =>
  openAdmin(path, {
    isServerAdmin: true,
    setup: (admin) => admin.serverSettings.push(...settings),
    ...setupServer,
  });

const stored = (admin: FakeAdminState, key: string) =>
  admin.serverSettings.find((s) => s.key === key)?.value;

describe("CORS rules of the page", () => {
  it("say why an origin is refused, with the entry it probably meant", () => {
    expect(originProblem("https://portal.example.com")).toBeNull();
    expect(originProblem("https://*.intranet.example.com")).toBeNull();
    expect(originProblem("http://localhost:5173")).toBeNull();
    expect(originProblem("http://[::1]:8080")).toBeNull();
    expect(originProblem("*")).toEqual({ reason: "star" });
    expect(originProblem("https://portal.example.com/dashboards")).toEqual({
      reason: "path",
      origin: "https://portal.example.com",
    });
    expect(originProblem("http://reports.example.com")).toEqual({
      reason: "http",
      origin: "https://reports.example.com",
    });
    // A star needs two labels after it, and https.
    expect(originProblem("https://*.com")).toEqual({ reason: "invalid" });
    expect(originProblem("http://*.example.com")).toEqual({
      reason: "http",
      origin: "https://*.example.com",
    });
    expect(originProblem("ftp://example.com")).toEqual({ reason: "invalid" });
    expect(validHeaderName("X-Request-Id")).toBe(true);
    expect(validHeaderName("X Request")).toBe(false);
  });

  it("answer a check as the server answers a preflight", () => {
    const settings = {
      enabled: true,
      origins: ["https://portal.example.com", "https://*.intranet.example.com"],
      methods: ["GET", "POST"],
      headers: ["Authorization", "X-Request-Id"],
      credentials: false,
      maxAgeSecs: 600,
    };
    expect(checkOrigin(settings, "https://wiki.intranet.example.com", "POST")).toEqual({
      allowed: true,
      entry: "https://*.intranet.example.com",
      headers: [
        ["Access-Control-Allow-Origin", "https://wiki.intranet.example.com"],
        ["Access-Control-Allow-Methods", "GET, POST"],
        ["Access-Control-Allow-Headers", "authorization, x-request-id"],
        ["Access-Control-Max-Age", "600"],
        ["Vary", "Origin"],
      ],
    });
    // The default port is filled in; the domain itself is no subdomain of itself.
    expect(checkOrigin(settings, "https://portal.example.com:443", "GET").allowed).toBe(true);
    expect(checkOrigin(settings, "https://intranet.example.com", "GET")).toEqual({
      allowed: false,
      reason: "origin",
    });
    expect(checkOrigin(settings, "https://portal.example.com", "DELETE")).toEqual({
      allowed: false,
      reason: "method",
    });
    // With the session cookie a star matches nothing.
    const withCookie = { ...settings, credentials: true };
    expect(checkOrigin(withCookie, "https://wiki.intranet.example.com", "GET").allowed).toBe(false);
    const exact = checkOrigin(withCookie, "https://portal.example.com", "GET");
    expect(exact.allowed && exact.headers).toContainEqual([
      "Access-Control-Allow-Credentials",
      "true",
    ]);
    expect(
      checkOrigin({ ...settings, enabled: false }, "https://portal.example.com", "GET"),
    ).toEqual({ allowed: false, reason: "off" });
  });
});

describe("Verwaltung > CORS", () => {
  it("adds an origin at once with undo, and refuses a bad one at its field", async () => {
    const { user, admin } = await open("/settings/cors", CORS());
    const origins = await screen.findByRole("list", { name: "CORS origins" });
    expect(within(origins).getAllByRole("listitem")).toHaveLength(2);
    const field = screen.getByRole("textbox", { name: "CORS origins" });

    await user.type(field, "*{Enter}");
    expect(screen.getByText(/A star alone allows every web page/)).toBeTruthy();
    expect(field.getAttribute("aria-invalid")).toBe("true");
    await user.clear(field);
    await user.type(field, "http://reports.example.com{Enter}");
    expect(
      screen.getByText("HTTP is for localhost only. Use https://reports.example.com."),
    ).toBeTruthy();
    // Nothing reached the server.
    expect(stored(admin, "cors.allowed_origins")).toHaveLength(2);

    await user.clear(field);
    await user.type(field, "http://localhost:5173{Enter}");
    await waitFor(() =>
      expect(stored(admin, "cors.allowed_origins")).toEqual([
        "https://portal.example.com",
        "https://*.intranet.example.com",
        "http://localhost:5173",
      ]),
    );
    expect(field).toHaveProperty("value", "");
    await user.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(stored(admin, "cors.allowed_origins")).toHaveLength(2));

    await user.click(
      within(origins).getByRole("button", { name: "Remove https://portal.example.com" }),
    );
    await waitFor(() =>
      expect(stored(admin, "cors.allowed_origins")).toEqual(["https://*.intranet.example.com"]),
    );
  });

  it("sets the methods as boxes and warns about stars with the session cookie", async () => {
    const { user, admin } = await open("/settings/cors", CORS());
    const methods = await screen.findByRole("group", { name: "CORS methods" });
    expect(within(methods).getByRole("checkbox", { name: "POST" })).toHaveProperty("checked", true);
    await user.click(within(methods).getByRole("checkbox", { name: "DELETE" }));
    await waitFor(() =>
      expect(stored(admin, "cors.allowed_methods")).toEqual(["GET", "POST", "DELETE"]),
    );
    await user.click(screen.getByRole("switch", { name: "CORS with session" }));
    expect(
      await screen.findByText("While this is on, entries with a star match nothing."),
    ).toBeTruthy();
  });

  it("shows values from kalzit.toml locked, with their source", async () => {
    await open(
      "/settings/cors",
      CORS({
        "cors.allowed_origins": { source: "file", editable: false },
        "cors.allowed_methods": { source: "env", editable: false },
      }),
    );
    const field = await screen.findByRole("textbox", { name: "CORS origins" });
    // A locked control sits in a disabled field set, which turns off everything inside.
    expect(field.closest("fieldset")).toHaveProperty("disabled", true);
    expect(
      screen.getByRole("checkbox", { name: "GET" }).closest("fieldset[disabled]"),
    ).not.toBeNull();
    expect(screen.getAllByText("locked").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/kalzit\.toml/)).toBeTruthy();
  });

  it("checks an origin against the settings without asking the server", async () => {
    const { user, server } = await open("/settings/cors", CORS());
    const side = await screen.findByRole("form", { name: "Check an origin" });
    await user.type(
      within(side).getByRole("textbox", { name: "Origin" }),
      "https://wiki.intranet.example.com",
    );
    const before = server.calls.length;
    await user.click(within(side).getByRole("button", { name: "Verify" }));
    const answer = within(side).getByRole("status");
    expect(answer.textContent).toContain("Allowed through https://*.intranet.example.com");
    expect(answer.textContent).toContain(
      "Access-Control-Allow-Origin: https://wiki.intranet.example.com",
    );
    expect(server.calls.length).toBe(before);
    fireEvent.change(within(side).getByRole("textbox", { name: "Origin" }), {
      target: { value: "https://elsewhere.example" },
    });
    await user.click(within(side).getByRole("button", { name: "Verify" }));
    expect(answer.textContent).toContain("Not allowed: no entry matches.");
  });

  it("reads German", async () => {
    await open("/settings/cors", CORS());
    await screen.findByRole("heading", { name: "Check an origin" });
    setLanguage("de");
    expect(await screen.findByRole("heading", { name: "Herkunft prüfen" })).toBeTruthy();
  });
});

describe("Verwaltung > Registrierung", () => {
  it("names what is still missing beside the switch", async () => {
    await open("/settings/registration", REGISTRATION);
    const needs = await screen.findByRole("complementary", { name: "What it needs" });
    const lines = within(needs)
      .getAllByRole("listitem")
      .map((item) => item.textContent);
    expect(lines).toEqual([
      "Password sign-in is on: OK",
      "Mail server and public address are set: missing",
      "At least one allowed domain: OK",
      "An organization for new accounts: missing",
    ]);
    expect(within(needs).getByRole("link", { name: "Set up mail" })).toBeTruthy();
    expect(validDomain("example.com")).toBe(true);
    expect(validDomain("example")).toBe(false);
    expect(validDomain("Example.com")).toBe(false);
  });

  it("adds a domain in lower case and offers only viewer and editor as the role", async () => {
    const { user, admin } = await open("/settings/registration", REGISTRATION);
    const field = await screen.findByRole("textbox", { name: "Allowed domains" });
    await user.type(field, "not a domain{Enter}");
    expect(screen.getByText("A domain such as example.com, without @ and path.")).toBeTruthy();
    await user.clear(field);
    await user.type(field, "@Partner.Example{Enter}");
    await waitFor(() =>
      expect(stored(admin, "registration.allowed_domains")).toEqual([
        "example.com",
        "partner.example",
      ]),
    );
    const role = screen.getByRole("combobox", { name: "Role of new accounts" });
    await user.click(role);
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "Viewer",
      "Editor",
    ]);
  });
});

describe("Verwaltung > Sicherungen", () => {
  it("starts without a target and saves one only after a passed test", async () => {
    const { user, server } = await open("/settings/backups", BACKUPS);
    expect(await screen.findByRole("heading", { name: "No target yet" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back up now" })).toHaveProperty("disabled", true);
    await user.click(screen.getByRole("button", { name: "Set up a target" }));
    const form = await screen.findByRole("form", { name: "Edit target" });
    const save = within(form).getByRole("button", { name: "Save" });
    expect(save).toHaveProperty("disabled", true);
    await user.type(within(form).getByRole("textbox", { name: "Folder" }), "D:\\Backups\\Kalzit");
    await user.click(within(form).getByRole("button", { name: "Test" }));
    expect(await within(form).findByText(/Test passed/)).toBeTruthy();
    expect(save).toHaveProperty("disabled", false);
    // A change after the test asks for a new one.
    await user.type(within(form).getByRole("textbox", { name: "Folder" }), "2");
    expect(save).toHaveProperty("disabled", true);
    await user.click(within(form).getByRole("button", { name: "Test" }));
    await waitFor(() => expect(save).toHaveProperty("disabled", false));
    await user.click(save);
    expect(await screen.findByText("Backup target saved.")).toBeTruthy();
    expect(server.areas.server075.backups.saves).toEqual([
      { target: { kind: "local", path: "D:\\Backups\\Kalzit2" }, version: 1 },
    ]);
    expect(screen.getByRole("button", { name: "Back up now" })).toHaveProperty("disabled", false);
  });

  it("puts a refusal at the field that caused it and saves nothing", async () => {
    const { user, server } = await open("/settings/backups", BACKUPS, {
      setupServer: (s) => {
        s.areas.server075.backups.view.target = S3_TARGET;
        s.areas.server075.backups.view.hasSecret = true;
        s.areas.server075.backups.refuse = {
          status: 502,
          code: "datasource_error",
          reason: "backup.bucket_not_found",
          field: "bucket",
        };
      },
    });
    await user.click(await screen.findByRole("button", { name: "Edit target" }));
    const form = await screen.findByRole("form", { name: "Edit target" });
    expect(within(form).getByRole("radio", { name: /S3-compatible/ })).toHaveProperty(
      "checked",
      true,
    );
    const bucket = within(form).getByRole("textbox", { name: "Bucket" });
    await user.clear(bucket);
    await user.type(bucket, "kalzit-backup");
    await user.click(within(form).getByRole("button", { name: "Test" }));
    expect(
      await within(form).findByText("Bucket not found. Kalzit creates no buckets."),
    ).toBeTruthy();
    expect(within(form).getByText("Test failed, nothing saved.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(bucket));
    expect(bucket.getAttribute("aria-invalid")).toBe("true");
    expect(within(form).getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    // The stored secret is not sent again; the form's values are.
    expect(server.areas.server075.backups.tests).toEqual([
      { target: { ...S3_TARGET, bucket: "kalzit-backup" } },
    ]);
    expect(server.areas.server075.backups.saves).toEqual([]);
  });

  it("shows the schedule, the target and the last runs, and backs up now", async () => {
    const { user } = await open("/settings/backups", BACKUPS, {
      setupServer: (s) => {
        const failed = sampleRun({
          id: "run-0",
          status: "failed",
          sizeBytes: null,
          reason: "backup.target_unreachable",
          detail: "timeout after 10 s",
        });
        s.areas.server075.backups.view = {
          ...s.areas.server075.backups.view,
          target: S3_TARGET,
          lastRun: sampleRun(),
        };
        s.areas.server075.backups.runs = [sampleRun(), failed];
      },
    });
    expect(await screen.findByRole("heading", { name: "S3: kalzit-backups" })).toBeTruthy();
    const runs = await screen.findByRole("table", { name: "Last runs" });
    const rows = within(runs).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1] as HTMLElement).getByText("318 MB")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("Error")).toBeTruthy();
    expect(
      within(rows[2] as HTMLElement).getByText("The store cannot be reached. timeout after 10 s"),
    ).toBeTruthy();
    expect(screen.getByRole("switch", { name: "Encrypt backups" })).toHaveProperty("checked", true);
    expect(screen.getByText(/The secrets key is never in a backup/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "How to restore" }).getAttribute("href")).toMatch(
      /docs\/guide\/backup\.md$/,
    );
    await user.click(screen.getByRole("button", { name: "Back up now" }));
    expect(await screen.findByText("Backup stored.")).toBeTruthy();
  });
});
