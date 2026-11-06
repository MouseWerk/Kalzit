import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { optionLabels, pickOption } from "../../../test/select";
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
    // With several providers, one can be chosen per function; empty is the default.
    const functions = screen.getByRole("region", { name: "Which provider for what" });
    const chat = within(functions).getByRole("combobox", {
      name: "Provider for Ask (chat with tools)",
    });
    const options = optionLabels(chat);
    expect(options).toEqual(["Default (Local)", "Local · llama3.3:70b", "Cloud · claude-x"]);
    // The limits, the usage and the notice of what leaves the server are on the same page.
    expect(screen.getByRole("region", { name: "Limits" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Usage" })).toBeTruthy();
    const notice = screen.getByRole("region", { name: "Which data leaves the server" });
    expect(within(notice).getByText(/at most 200 rows of each result/)).toBeTruthy();
    expect(within(notice).getByRole("button", { name: "Edit own addition" })).toBeTruthy();
  });

  it("puts the switch into the status strip while AI is on, with who switched it and each organization", async () => {
    const { user, server } = await openAdmin("/settings/ai", {
      isServerAdmin: true,
      setup: (admin) => {
        addAiSettings(admin);
        const enabled = admin.serverSettings.find((setting) => setting.key === "ai.enabled");
        if (enabled !== undefined) enabled.value = true;
      },
      setupServer: (s) => {
        s.areas.aiAdmin.serverProviders.push(
          fakeProvider({ lastTest: TESTED, leavesOwnNetwork: false }),
          fakeProvider({
            id: "p2",
            name: "Cloud",
            kind: "anthropic",
            baseUrl: "https://api.anthropic.com",
            isDefault: false,
            leavesOwnNetwork: true,
            lastTest: { ok: false, reason: "ai.provider_unauthorized", at: TESTED.at },
          }),
        );
        s.areas.aiAdmin.overview = {
          switchedAt: Date.UTC(2026, 9, 20, 9),
          switchedBy: "Lea Hoffmann",
          orgs: [
            { id: "o1", name: "MouseWerk", enabled: true },
            {
              id: "o2",
              name: "Kampagnen GmbH",
              enabled: true,
              provider: { name: "OpenAI", kind: "openai", model: "gpt" },
            },
            { id: "o3", name: "Labor Nord", enabled: false },
          ],
          moreOrgs: false,
        };
      },
    });
    const strip = await screen.findByRole("region", { name: "AI status" });
    const toggle = within(strip).getByRole("switch", { name: "AI" });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    expect(await within(strip).findByText("since 10/20, Lea Hoffmann")).toBeTruthy();
    expect(within(strip).getByText("1 failing: Cloud")).toBeTruthy();
    expect(within(strip).getByText("No")).toBeTruthy();
    // The providers say where each one runs and whether data leaves the server.
    const card = screen.getByRole("region", { name: "Providers" });
    expect(within(card).getByText("Own network")).toBeTruthy();
    expect(within(card).getByText("In the cloud")).toBeTruthy();
    // The organizations, each with AI off, its own provider or the server's.
    const orgs = screen.getByRole("list", { name: "AI per organization" });
    expect(within(orgs).getByText("The server’s provider")).toBeTruthy();
    expect(within(orgs).getByText("Own provider · OpenAI")).toBeTruthy();
    expect(within(orgs).getByText("AI off in the organization")).toBeTruthy();
    expect(screen.getByRole("link", { name: "AI in the audit log" }).getAttribute("href")).toBe(
      "/admin/server/audit?action=ai.",
    );
    // Off again from the strip, with undo.
    await user.click(toggle);
    await waitFor(() =>
      expect(calls(server, "/api/admin/settings/ai.enabled").at(-1)?.body).toMatchObject({
        value: false,
      }),
    );
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
        "The provider must first pass its connection test since its last change; only then can AI be turned on or the provider be chosen for a function.",
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

    // A refused key: the test stores nothing, and the outcome lands at the key.
    server.areas.aiAdmin.testAnswers.draft = {
      ok: false,
      latencyMs: 40,
      reason: "ai.provider_unauthorized",
      params: { status: "401" },
      message: "the provider refused the key",
    };
    await user.clear(url);
    await user.type(url, "https://api.anthropic.com");
    // A cloud model: the administrators say so, instead of the estimate from the address.
    await pickOption(user, within(dialog).getByLabelText("Data leaves the own network"), "yes");
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    const keyError = await within(dialog).findByText(
      "The AI provider refused the key (401). Check the key and its rights.",
    );
    expect(keyError.closest("[role=alert]")).toBeTruthy();
    const key = within(dialog).getByLabelText("API key");
    expect(key.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(key);
    expect(calls(server, "/api/admin/ai/provider-test").at(-1)?.body).toEqual({
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "claude-x",
      apiKey: "sk-wrong",
    });
    expect(server.areas.aiAdmin.serverProviders).toHaveLength(0);

    // Save tests again on the server: refused at the key, and still nothing is stored.
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await within(dialog).findByText(/Nothing is saved until a check passes\./)).toBeTruthy();
    expect(key.getAttribute("aria-invalid")).toBe("true");
    expect(server.areas.aiAdmin.serverProviders).toHaveLength(0);

    // A new key passes; one Save stores the provider with its pass and closes.
    server.areas.aiAdmin.testAnswers.draft = { ok: true, latencyMs: 210, reply: "OK" };
    await user.clear(key);
    await user.type(key, "sk-right");
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    expect(await within(dialog).findByText("Connection OK.")).toBeTruthy();
    expect(within(dialog).getByText(/210 ms · reply: “OK”/)).toBeTruthy();
    expect(server.areas.aiAdmin.serverProviders).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const created = calls(server, "/api/admin/ai/providers")
      .filter((call) => call.method === "POST")
      .at(-1);
    expect(created?.body).toEqual({
      name: "Cloud",
      kind: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "claude-x",
      isDefault: false,
      apiKey: "sk-right",
      leavesNetwork: "yes",
      verify: true,
    });
    const card = screen.getByRole("region", { name: "Providers" });
    expect(await within(card).findByText("Cloud")).toBeTruthy();
    expect(within(card).getByText("Ready")).toBeTruthy();
  });

  it("stores nothing when a test fails, and Cancel leaves nothing behind", async () => {
    const { user, server } = await openAdmin("/settings/ai", {
      isServerAdmin: true,
      setup: addAiSettings,
    });
    await user.click(await screen.findByRole("button", { name: "Add provider" }));
    const dialog = await screen.findByRole("dialog", { name: "Add provider" });
    await user.type(within(dialog).getByRole("textbox", { name: "Name" }), "Lokal");
    await user.type(
      within(dialog).getByRole("textbox", { name: "Base URL" }),
      "http://llm.intern/v1",
    );
    await user.type(within(dialog).getByRole("textbox", { name: "Model" }), "m");
    server.areas.aiAdmin.testAnswers.draft = {
      ok: false,
      latencyMs: 30,
      reason: "ai.provider_unreachable",
      params: { detail: "connection refused" },
      message: "the provider cannot be reached",
    };
    await user.click(within(dialog).getByRole("button", { name: "Test connection" }));
    expect(await within(dialog).findByText(/cannot be reached: connection refused/)).toBeTruthy();
    expect(server.areas.aiAdmin.serverProviders).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(server.areas.aiAdmin.serverProviders).toHaveLength(0);
    expect(calls(server, "/api/admin/ai/providers").some((call) => call.method !== "GET")).toBe(
      false,
    );
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
      verify: true,
    });
  });
});

describe("AI, organization section", () => {
  it("offers no Add while the server does not allow own providers, as the status says", async () => {
    await openAdmin("/settings/org-ai", {
      setup: addAiSettings,
      setupServer: (s) => {
        s.areas.aiAdmin.status = { enabled: false, usable: false, orgProvidersAllowed: false };
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
    await pickOption(user, within(row).getByRole("combobox"), "own");
    const amount = within(row).getByRole("spinbutton", {
      name: "Own value for AI calls per person and day",
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
