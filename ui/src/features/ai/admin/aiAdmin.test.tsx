import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { openAdmin } from "../../admin/test/openAdmin";
import { addAiSettings, fakeProvider } from "../test/fakeAiAdmin";

const TESTED = { ok: true, at: Date.UTC(2026, 9, 20) };

function calls(server: { calls: { method: string; path: string; body: unknown }[] }, part: string) {
  return server.calls.filter((call) => call.path.includes(part));
}

describe("AI, server section", () => {
  it("lists the server's providers with kind, address, model, destination and status", async () => {
    await openAdmin("/settings/ai", {
      isServerAdmin: true,
      setup: addAiSettings,
      setupServer: (server) => {
        server.areas.aiAdmin.serverProviders.push(
          fakeProvider({ lastTest: TESTED }),
          fakeProvider({
            id: "p2",
            name: "Cloud",
            kind: "anthropic",
            baseUrl: "https://api.anthropic.com",
            model: "claude-x",
            isDefault: false,
            apiKeySet: true,
            lastTest: { ok: false, reason: "ai.provider_unauthorized", at: TESTED.at },
          }),
        );
      },
    });
    expect(await screen.findByRole("heading", { level: 2, name: "AI" })).toBeTruthy();
    const card = await screen.findByRole("region", { name: "Providers" });
    const table = await within(card).findByRole("table");
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    const local = rows[1] as HTMLElement;
    expect(within(local).getByText("Local")).toBeTruthy();
    expect(within(local).getByText("Default")).toBeTruthy();
    expect(within(local).getByText("OpenAI-compatible")).toBeTruthy();
    expect(within(local).getByText("http://llm.internal:11434/v1")).toBeTruthy();
    expect(within(local).getByText("llm.internal:11434")).toBeTruthy();
    expect(within(local).getByText("Ready")).toBeTruthy();
    const cloud = rows[2] as HTMLElement;
    expect(within(cloud).getByText("Anthropic")).toBeTruthy();
    expect(within(cloud).getByText("api.anthropic.com")).toBeTruthy();
    expect(within(cloud).getByText("Key refused")).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Edit Cloud" })).toBeTruthy();
    // The limits, the usage and the notice of what leaves the server are on the same page.
    expect(screen.getByRole("region", { name: "Limits" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Usage" })).toBeTruthy();
    const notice = screen.getByRole("region", { name: "Which data leaves the server" });
    expect(within(notice).getByText(/at most 200 rows of each result/)).toBeTruthy();
    expect(within(notice).getByRole("button", { name: "Edit own addition" })).toBeTruthy();
  });

  it("says why switching AI on is refused without a tested provider", async () => {
    const { user, server } = await openAdmin("/settings/ai", {
      isServerAdmin: true,
      setup: addAiSettings,
    });
    expect(await screen.findByText("Connect a provider first.")).toBeTruthy();
    expect(screen.getByText("No provider yet")).toBeTruthy();
    await user.click(screen.getByRole("switch", { name: "AI functions" }));
    expect(
      await screen.findByText(
        "AI can be turned on once a provider in effect has passed its connection test since its last change.",
      ),
    ).toBeTruthy();
    expect(calls(server, "/api/admin/settings/ai.enabled").at(-1)?.body).toEqual({
      value: true,
      version: 0,
    });
    expect((screen.getByRole("switch", { name: "AI functions" }) as HTMLInputElement).checked).toBe(
      false,
    );
  });

  it("adds a provider: a refused value lands at its field, the test, then one Save", async () => {
    const { user, server } = await openAdmin("/settings/ai", {
      isServerAdmin: true,
      setup: addAiSettings,
    });
    await user.click(await screen.findByRole("button", { name: "Add provider" }));
    const dialog = await screen.findByRole("dialog", { name: "Add provider" });
    await user.click(within(dialog).getByRole("radio", { name: "Anthropic" }));
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Cloud");
    const url = within(dialog).getByRole("textbox", { name: "Base URL" });
    await user.type(url, "ftp://api.anthropic.com");
    await user.type(within(dialog).getByLabelText("API key"), "sk-wrong");
    await user.type(within(dialog).getByRole("textbox", { name: "Model" }), "claude-x");

    // The server refuses the address: its reason shows at the field, which gets focus.
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    const urlError = await within(dialog).findByText(
      "Enter an address starting with http:// or https://, without sign-in details, query or fragment.",
    );
    expect(urlError.closest("[role=alert]")).toBeTruthy();
    expect(url.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(url);
    expect(server.areas.aiAdmin.serverProviders).toHaveLength(0);

    // A refused key: the test stores the provider, and the outcome lands at the key.
    server.areas.aiAdmin.testAnswers.p10 = {
      ok: false,
      latencyMs: 40,
      reason: "ai.provider_unauthorized",
      params: { status: "401" },
      message: "the provider refused the key",
    };
    await user.clear(url);
    await user.type(url, "https://api.anthropic.com");
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    const keyError = await within(dialog).findByText(
      "The AI provider refused the key (401). Check the key and its rights.",
    );
    expect(keyError.closest("[role=alert]")).toBeTruthy();
    const key = within(dialog).getByLabelText("API key");
    expect(key.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(key);
    const created = calls(server, "/api/admin/ai/providers")
      .filter((call) => call.method === "POST" && !call.path.endsWith("/test"))
      .at(-1);
    expect(created?.body).toEqual({
      name: "Cloud",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "claude-x",
      isDefault: false,
      apiKey: "sk-wrong",
    });

    // A new key passes; Save sends nothing more and closes.
    server.areas.aiAdmin.testAnswers.p10 = { ok: true, latencyMs: 210, reply: "OK" };
    await user.type(key, "sk-right");
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    expect(await within(dialog).findByText("Connection OK.")).toBeTruthy();
    expect(within(dialog).getByText(/210 ms · reply: “OK”/)).toBeTruthy();
    const patch = calls(server, "/api/admin/ai/providers/p10").find(
      (call) => call.method === "PATCH",
    );
    expect(patch?.body).toEqual({ apiKey: "sk-right", expectedUpdatedAt: expect.any(Number) });
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const card = screen.getByRole("region", { name: "Providers" });
    expect(await within(card).findByText("Cloud")).toBeTruthy();
    expect(within(card).getByText("Ready")).toBeTruthy();
  });

  it("asks for the key again when the address of a provider with a key changes", async () => {
    const { user, server } = await openAdmin("/settings/ai", {
      isServerAdmin: true,
      setup: addAiSettings,
      setupServer: (s) => {
        s.areas.aiAdmin.serverProviders.push(fakeProvider({ apiKeySet: true, lastTest: TESTED }));
      },
    });
    await user.click(await screen.findByRole("button", { name: "Edit Local" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Local" });
    expect(within(dialog).queryByRole("radio", { name: "Anthropic" })).toBeNull();
    const url = within(dialog).getByRole("textbox", { name: "Base URL" });
    await user.clear(url);
    await user.type(url, "http://gateway.internal/v1");
    expect(
      within(dialog).getByText(
        "The address changed: enter the key again or remove it, so it never reaches another server unasked.",
      ),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(
      await within(dialog).findByText(
        "Enter the key again (or remove it) when you change the address, so it never reaches another server unasked.",
      ),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Remove key" }));
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const patch = calls(server, "/api/admin/ai/providers/p1").filter((c) => c.method === "PATCH");
    expect(patch.at(-1)?.body).toEqual({
      baseUrl: "http://gateway.internal/v1",
      apiKey: null,
      expectedUpdatedAt: expect.any(Number),
    });
  });
});

describe("AI, organization section", () => {
  it("offers no Add while the server does not allow own providers", async () => {
    await openAdmin("/settings/org-ai", {
      isServerAdmin: true,
      setup: (admin) => {
        addAiSettings(admin);
        const allow = admin.serverSettings.find((s) => s.key === "ai.allow_org_providers");
        if (allow !== undefined) allow.value = false;
      },
    });
    expect(
      await screen.findByRole("heading", { level: 2, name: "AI of the organization" }),
    ).toBeTruthy();
    expect(
      await screen.findByText(
        "The server does not allow organizations a provider of their own; existing ones are not used.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add provider" })).toBeNull();
  });

  it("hides Add once the server refuses an own provider", async () => {
    const { user, server } = await openAdmin("/settings/org-ai", {
      setup: addAiSettings,
      setupServer: (s) => {
        s.areas.aiAdmin.allowOrgProviders = false;
      },
    });
    await user.click(await screen.findByRole("button", { name: "Add provider" }));
    const dialog = await screen.findByRole("dialog", { name: "Add provider" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Own");
    await user.type(within(dialog).getByRole("textbox", { name: "Base URL" }), "http://x/v1");
    await user.type(within(dialog).getByRole("textbox", { name: "Model" }), "m");
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(
      await within(dialog).findByText(
        "The server does not allow organizations their own AI provider.",
      ),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("button", { name: "Add provider" })).toBeNull();
    expect(server.areas.aiAdmin.orgProviders).toHaveLength(0);
  });

  it("sets a lower limit of its own and lists what AI may read", async () => {
    const { user, server } = await openAdmin("/settings/org-ai", {
      setup: addAiSettings,
      setupServer: (s) => {
        s.areas.aiAdmin.access["ds-pg"] = { readable: true, excludedFields: [] };
      },
    });
    const row = await waitFor(() => {
      const element = document.getElementById("org.ai.user_requests_per_day");
      if (element === null) throw new Error("no row");
      return element;
    });
    await user.selectOptions(within(row).getByRole("combobox"), "own");
    const amount = within(row).getByRole("spinbutton", {
      name: "Own value for AI calls per user and day",
    });
    await user.type(amount, "50{Enter}");
    await waitFor(() =>
      expect(calls(server, "/settings/ai.user_requests_per_day").at(-1)?.body).toEqual({
        value: 50,
        version: 0,
      }),
    );
    const sources = screen.getByRole("region", { name: "What AI may read" });
    const sales = (await within(sources).findByText("Sales DB")).closest("tr") as HTMLElement;
    expect(within(sales).getByText("AI may read")).toBeTruthy();
    expect(
      within(sales).getByRole("link", { name: "AI settings of Sales DB" }).getAttribute("href"),
    ).toBe("/data-sources/ds-pg#ai");
  });
});
