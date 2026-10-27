import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { catalogs, type MessageKey, translate } from "../../i18n/i18n";
import { AiGateFor } from "./AiGate";
import { aiErrorText, aiReasonText } from "./reasons";

/** The rows of the "Reasons" table in docs/api/ai.md: codes and their params. */
function documentedReasons(): Map<string, Set<string>> {
  const doc = readFileSync(resolve(import.meta.dirname, "../../../../docs/api/ai.md"), "utf8");
  const reasons = new Map<string, Set<string>>();
  for (const line of doc.slice(doc.indexOf("\n## Reasons")).split("\n")) {
    const [, codes, params] = line.split("|").map((cell) => cell.trim());
    if (codes === undefined || !codes.startsWith("`")) {
      continue;
    }
    const names = new Set([...(params ?? "").matchAll(/`(\w+)`/g)].map(([, name]) => name ?? ""));
    for (const [, code] of codes.matchAll(/`([\w.]+)`/g)) {
      reasons.set(code ?? "", names);
    }
  }
  return reasons;
}

const PREFIX = "ai.reason.";
const documented = documentedReasons();
const en = (key: MessageKey, params?: Record<string, string | number>) =>
  translate("en", key, params);
const de = (key: MessageKey, params?: Record<string, string | number>) =>
  translate("de", key, params);

describe("AI reason texts", () => {
  it("reads the documented reasons", () => {
    expect(documented.size).toBeGreaterThan(20);
    expect(documented.get("ai.limit_user_requests")).toEqual(new Set(["max"]));
  });

  it.each([...documented.keys()])("has a German and an English text for %s", (reason) => {
    expect(Object.hasOwn(catalogs.en, `${PREFIX}${reason}`), `en: ${reason}`).toBe(true);
    expect(Object.hasOwn(catalogs.de, `${PREFIX}${reason}`), `de: ${reason}`).toBe(true);
  });

  it("has no text without a documented reason", () => {
    for (const catalog of [catalogs.en, catalogs.de]) {
      const left = Object.keys(catalog)
        .filter((key) => key.startsWith(PREFIX))
        .map((key) => key.slice(PREFIX.length))
        .filter((reason) => !documented.has(reason));
      expect(left).toEqual([]);
    }
  });

  it.each([...documented])("uses only documented params in %s", (reason, params) => {
    for (const catalog of [catalogs.en, catalogs.de]) {
      const text = catalog[`${PREFIX}${reason}` as MessageKey] ?? "";
      for (const [, name] of text.matchAll(/\{(\w+)\}/g)) {
        expect(params.has(name ?? ""), `${reason}: {${name}}`).toBe(true);
      }
    }
  });

  it("fills params in German with du, and falls back to the data source reasons", () => {
    expect(aiReasonText(de, { reason: "ai.limit_user_requests", params: { max: "200" } })).toBe(
      "Du hast deine 200 KI-Aufrufe für heute verbraucht. Die Grenze beginnt um Mitternacht (UTC) neu.",
    );
    expect(aiReasonText(en, { reason: "target.not_allowed", params: { host: "x" } })).toBe(
      translate("en", "datasources.reason.target.not_allowed" as MessageKey, { host: "x" }),
    );
    expect(aiReasonText(en, { reason: "ai.from_the_future", fallback: "Server text" })).toBe(
      "Server text",
    );
  });

  it("reads the reason of a failed request", () => {
    const error = new ApiError("ai_unavailable", 409, "AI is turned off", undefined, {
      error: { code: "ai_unavailable", message: "AI is turned off", reason: "ai.disabled" },
    });
    expect(aiErrorText(en, error)).toBe("AI is turned off on this server.");
    expect(aiErrorText(en, new Error("x"))).toBeUndefined();
  });
});

function answer(status: number, body: unknown) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function renderGate(orgId: string | undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <p>before</p>
      <AiGateFor orgId={orgId}>
        <button type="button">Explain with AI</button>
      </AiGateFor>
    </QueryClientProvider>,
  );
}

describe("AiGate", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders nothing while AI is off", async () => {
    const fetch = vi.fn((_input: string) => answer(200, { enabled: false, usable: false }));
    vi.stubGlobal("fetch", fetch);
    renderGate("org-1");
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/orgs/org-1/ai/status");
    await screen.findByText("before");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders nothing while AI is on without a provider", async () => {
    const fetch = vi.fn(() =>
      answer(200, { enabled: true, usable: false, reason: "ai.no_provider" }),
    );
    vi.stubGlobal("fetch", fetch);
    renderGate("org-1");
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((done) => setTimeout(done, 0));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders nothing when the status fails", async () => {
    const fetch = vi.fn(() => answer(500, { error: { code: "internal", message: "x" } }));
    vi.stubGlobal("fetch", fetch);
    renderGate("org-1");
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    await new Promise((done) => setTimeout(done, 0));
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("asks nothing without an organization", async () => {
    const fetch = vi.fn(() => answer(200, { enabled: true, usable: true }));
    vi.stubGlobal("fetch", fetch);
    renderGate(undefined);
    await screen.findByText("before");
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders its children once AI is usable", async () => {
    const fetch = vi.fn(() =>
      answer(200, {
        enabled: true,
        usable: true,
        provider: { kind: "openai", model: "m", scope: "server" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    renderGate("org-1");
    expect(await screen.findByRole("button", { name: "Explain with AI" })).toBeTruthy();
  });
});
