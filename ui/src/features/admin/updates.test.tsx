import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { nextWindow } from "./server/UpdatesPage";
import type { UpdateStatus } from "./server/updatesApi";
import { openAdmin } from "./test/openAdmin";

/** A status as docs/api/updates.md describes it: 0.1.0 installed, 0.2.0 downloaded and verified. */
function status(change: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    installed: { version: "0.1.0", platform: "linux", arch: "x64", since: null },
    channel: "stable",
    checkDaily: false,
    window: "02:00-04:00",
    lastCheck: { at: 1_800_000_000_000, latest: "0.2.0", error: null },
    available: {
      version: "0.2.0",
      channel: "stable",
      size: 48_200_000,
      sha256: "9f3c00000000000000000000000000000000000000000000000000000000a71e",
      notes: "Faster dashboards.",
      notesUrl: "https://github.com/MouseWerk/Kalzit/releases/tag/v0.2.0",
      highlights: [
        { kind: "new", text: "Panel editor on its own page" },
        { kind: "improved", text: "Faster typing" },
        { kind: "security", text: "Sessions renew after a role change" },
      ],
      releasedAt: "2026-10-22T00:00:00Z",
      minimumVersion: null,
      keyId: "17e204d64429eae4",
      staged: true,
    },
    skipped: null,
    staged: {
      version: "0.2.0",
      source: "online",
      size: 48_200_000,
      sha256: "9f3c00000000000000000000000000000000000000000000000000000000a71e",
      keyId: "17e204d64429eae4",
      notes: "Faster dashboards.",
      notesUrl: null,
      highlights: [],
    },
    job: { phase: "idle" },
    mode: { automatic: true, reason: null },
    database: "sqlite",
    schedule: null,
    trustedKeys: ["17e204d64429eae4"],
    preflight: {
      backupBytes: 312_000_000,
      freeBytes: 2_100_000_000,
      activeUsers: 3,
      healthTimeoutSecs: 60,
    },
    maxPackageBytes: 512 * 1024 * 1024,
    backups: [
      {
        file: "kalzit-0.0.9-1.db",
        size: 298_000_000,
        version: "0.0.9",
        at: 1_799_000_000_000,
        kind: "switch",
        by: null,
      },
      {
        file: "manual-0.1.0-2.db",
        size: 281_000_000,
        version: "0.1.0",
        at: 1_799_500_000_000,
        kind: "manual",
        by: "u1",
      },
    ],
    history: [
      {
        version: "0.1.0",
        from: "0.0.9",
        at: 1_799_000_100_000,
        kind: "update",
        outcome: "installed",
        reason: null,
        reasonCode: null,
        source: "online",
        scheduled: true,
        actor: "u1",
        durationMs: 41_000,
      },
      {
        version: "0.0.9",
        from: "0.0.8",
        at: 1_798_000_000_000,
        kind: "update",
        outcome: "installed",
        reason: null,
        reasonCode: null,
        source: "online",
        scheduled: false,
        actor: "u1",
        durationMs: 38_000,
      },
      {
        version: "0.0.9",
        from: "0.0.8",
        at: 1_797_000_000_000,
        kind: "update",
        outcome: "aborted",
        reason: "the signature does not match",
        reasonCode: "updates.signature_invalid",
        source: "offline",
        scheduled: false,
        actor: null,
        durationMs: null,
      },
    ],
    people: [{ id: "u1", name: "Ada Lovelace" }],
    rollbackTargets: [
      {
        version: "0.0.9",
        keptAt: 1_799_000_000_000,
        needsDatabaseRestore: true,
        restorePossible: true,
      },
    ],
    ...change,
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** Answers the update routes in front of the fake server; `answer` decides per call. */
function updatesRoutes(
  initial: UpdateStatus,
  answer?: (call: Call, current: UpdateStatus) => UpdateStatus | Response,
) {
  const calls: Call[] = [];
  let current = initial;
  const next = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (!path.startsWith("/api/admin/updates")) {
        return next(input, init);
      }
      const method = init?.method ?? "GET";
      const body =
        init?.body instanceof FormData
          ? init.body
          : typeof init?.body === "string"
            ? (JSON.parse(init.body) as unknown)
            : undefined;
      const call = { method, path, body };
      calls.push(call);
      const result = answer === undefined || method === "GET" ? current : answer(call, current);
      if (result instanceof Response) {
        return result;
      }
      current = result;
      return new Response(JSON.stringify(current), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  return calls;
}

describe("updates page", () => {
  it("shows the installed version, the release with its notes and the checks before it", async () => {
    await openAdmin("/admin/server/updates", {
      isServerAdmin: true,
      setup: () => updatesRoutes(status()),
    });
    expect(await screen.findByRole("heading", { level: 1, name: "Updates" })).toBeTruthy();
    const release = screen.getByRole("region", { name: "Available release" });
    expect(within(release).getByText("0.2.0")).toBeTruthy();
    expect(within(release).getByText("Signature verified (Ed25519)")).toBeTruthy();
    expect(within(release).getByText("Panel editor on its own page")).toBeTruthy();
    expect(within(release).getByText("Security")).toBeTruthy();
    const checks = screen.getByRole("region", { name: "Before the update" });
    expect(within(checks).getByText("Ready")).toBeTruthy();
    expect(within(checks).getByText("Active users in the last 30 minutes: 3")).toBeTruthy();
    const daily = screen.getByRole("switch", { name: "Check automatically" });
    expect(daily.getAttribute("aria-checked")).toBe("false");
    // The shared switch of the settings, not one with its own sizes.
    expect(daily.classList.contains("settings-switch")).toBe(true);
  });

  it("installs after a confirmation", async () => {
    let calls: Call[] = [];
    const { user } = await openAdmin("/admin/server/updates", {
      isServerAdmin: true,
      setup: () => {
        calls = updatesRoutes(status(), (call, current) =>
          call.path.endsWith("/apply")
            ? { ...current, job: { phase: "restarting", version: "0.2.0" } }
            : current,
        );
      },
    });
    await user.click(await screen.findByRole("button", { name: "Install now" }));
    const dialog = screen.getByRole("dialog", { name: "Install 0.2.0 now?" });
    expect(within(dialog).getByText(/returns to 0.1.0 on its own/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Install now" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")).toEqual({
        method: "POST",
        path: "/api/admin/updates/apply",
        body: { version: "0.2.0" },
      }),
    );
    expect(await screen.findByText("Restarting with 0.2.0")).toBeTruthy();
  });

  it("asks for a confirmed PostgreSQL backup before installing", async () => {
    let calls: Call[] = [];
    const { user } = await openAdmin("/admin/server/updates", {
      isServerAdmin: true,
      setup: () => {
        calls = updatesRoutes(
          status({ database: "postgres", backups: [] }),
          (_, current) => current,
        );
      },
    });
    await user.click(await screen.findByRole("button", { name: "Install now" }));
    const dialog = screen.getByRole("dialog");
    const install = within(dialog).getByRole("button", { name: "Install now" });
    expect((install as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(install);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        version: "0.2.0",
        acknowledgeNoBackup: true,
      }),
    );
  });

  it("plans on PostgreSQL only after the own backup is confirmed", async () => {
    let calls: Call[] = [];
    const { user } = await openAdmin("/admin/server/updates", {
      isServerAdmin: true,
      setup: () => {
        calls = updatesRoutes(
          status({ database: "postgres", backups: [] }),
          (_, current) => current,
        );
      },
    });
    await user.click(await screen.findByRole("button", { name: /^Plan for (today|tomorrow)/ }));
    const dialog = screen.getByRole("dialog");
    const plan = within(dialog).getByRole("button", { name: "Plan the update" });
    expect((plan as HTMLButtonElement).disabled).toBe(true);
    await user.click(within(dialog).getByRole("checkbox"));
    await user.click(plan);
    await waitFor(() =>
      expect(calls.find((c) => c.method === "PUT")?.body).toMatchObject({
        version: "0.2.0",
        acknowledgeNoBackup: true,
      }),
    );
  });

  it("names the command where the server does not install on its own", async () => {
    await openAdmin("/admin/server/updates", {
      isServerAdmin: true,
      setup: () =>
        updatesRoutes(
          status({ mode: { automatic: false, reason: "updates.mode_windows_service" } }),
        ),
    });
    expect(await screen.findByText("kalzit update apply")).toBeTruthy();
    expect(screen.getByText(/Kalzit does not run as its Windows service/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install now" })).toBeNull();
  });

  it("uploads an offline package", async () => {
    let calls: Call[] = [];
    const { user } = await openAdmin("/admin/server/updates", {
      isServerAdmin: true,
      setup: () => {
        calls = updatesRoutes(status({ available: null, staged: null }), (_, current) => current);
      },
    });
    const input = await screen.findByLabelText(/Drop the package here/);
    const file = new File(["package"], "kalzit-0.2.0-linux-x64.kalzit-update");
    await user.upload(input as HTMLInputElement, file);
    await waitFor(() =>
      expect(calls.some((c) => c.path === "/api/admin/updates/upload")).toBe(true),
    );
    const sent = calls.find((c) => c.path === "/api/admin/updates/upload")?.body as FormData;
    expect((sent.get("bundle") as File).name).toBe("kalzit-0.2.0-linux-x64.kalzit-update");
    expect(await screen.findByText("The package is verified and ready to install.")).toBeTruthy();
  });

  it("shows a refused upload with its reason", async () => {
    const { user } = await openAdmin("/admin/server/updates", {
      isServerAdmin: true,
      setup: () =>
        updatesRoutes(
          status(),
          () =>
            new Response(
              JSON.stringify({
                error: {
                  code: "validation",
                  message: "the package does not match its signed SHA-256",
                  reason: "updates.hash_mismatch",
                },
              }),
              { status: 422, headers: { "Content-Type": "application/json" } },
            ),
        ),
    });
    const input = await screen.findByLabelText(/Drop the package here/);
    await user.upload(input as HTMLInputElement, new File(["x"], "bad.kalzit-update"));
    expect(
      await screen.findByText(
        "The package does not match its signed checksum. Nothing was installed.",
      ),
    ).toBeTruthy();
  });

  it("lists backups and history, and returns to a kept version after a warning", async () => {
    let calls: Call[] = [];
    const { user } = await openAdmin("/admin/server/updates", {
      isServerAdmin: true,
      setup: () => {
        calls = updatesRoutes(status(), (_, current) => current);
      },
    });
    const backups = await screen.findByRole("list", { name: "Backups" });
    expect(within(backups).getAllByRole("listitem")).toHaveLength(2);
    expect(
      within(backups).getByRole("link", { name: "Download backup Manual" }).getAttribute("href"),
    ).toBe("/api/admin/updates/backups/manual-0.1.0-2.db");
    const history = screen.getByRole("region", { name: "History" });
    expect(within(history).getByText("Stopped, nothing changed")).toBeTruthy();
    expect(
      within(history).getByText(
        "The signature does not match the release files. Nothing was installed.",
      ),
    ).toBeTruthy();
    await user.click(within(history).getByRole("button", { name: "Offline" }));
    expect(within(history).getAllByRole("row")).toHaveLength(2);
    await user.click(within(history).getByRole("button", { name: "All" }));
    await user.click(within(history).getByRole("button", { name: "Return to this version" }));
    const dialog = screen.getByRole("dialog", { name: "Return to 0.0.9?" });
    expect(within(dialog).getByText(/everything changed since then is lost/)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Return to this version" }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === "POST")?.body).toEqual({
        version: "0.0.9",
        restoreDatabase: true,
      }),
    );
  });

  it("plans the update for the next maintenance window", async () => {
    let calls: Call[] = [];
    const { user } = await openAdmin("/admin/server/updates", {
      isServerAdmin: true,
      setup: () => {
        calls = updatesRoutes(status(), (call, current) =>
          call.method === "PUT"
            ? { ...current, schedule: { version: "0.2.0", at: 1, until: 2 } }
            : current,
        );
      },
    });
    await user.click(await screen.findByRole("button", { name: /^Plan for (today|tomorrow)/ }));
    await waitFor(() => expect(calls.some((c) => c.method === "PUT")).toBe(true));
    const body = calls.find((c) => c.method === "PUT")?.body as {
      version: string;
      at: number;
      until: number;
    };
    expect(body.version).toBe("0.2.0");
    expect(body.until - body.at).toBe(2 * 3_600_000);
    expect(body.at).toBeGreaterThan(Date.now());
  });

  it("is closed to members who are not server admins", async () => {
    await openAdmin("/admin/server/updates", { isServerAdmin: false });
    expect(await screen.findByText("No access")).toBeTruthy();
  });
});

describe("maintenance window", () => {
  it("starts today when the window is still ahead, else tomorrow", () => {
    const morning = Date.UTC(2026, 9, 24, 1, 0);
    expect(nextWindow("02:00-04:00", morning, "UTC")).toEqual({
      at: Date.UTC(2026, 9, 24, 2, 0),
      until: Date.UTC(2026, 9, 24, 4, 0),
    });
    const noon = Date.UTC(2026, 9, 24, 12, 0);
    expect(nextWindow("02:00-04:00", noon, "UTC")?.at).toBe(Date.UTC(2026, 9, 25, 2, 0));
    // A window over midnight ends the next day.
    expect(nextWindow("23:00-01:00", noon, "UTC")).toEqual({
      at: Date.UTC(2026, 9, 24, 23, 0),
      until: Date.UTC(2026, 9, 25, 1, 0),
    });
    expect(nextWindow("nonsense", noon, "UTC")).toBeUndefined();
  });
});
