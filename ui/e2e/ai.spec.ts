import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { Api, fixturesDir, SQL, unique } from "./support/api";
import { t } from "./support/i18n";
import { expect, test } from "./support/test";
import { fillQuery } from "./support/ui";

const EXPLANATION = "The query lists every region of the sales table once, in alphabetical order.";
const SUMMARY = "There are four regions: Nord, Ost, Süd and West.";

interface MockProvider {
  baseUrl: string;
  /** The user messages of every request, in order. */
  prompts: string[];
  close: () => Promise<void>;
}

/**
 * A stand-in for an OpenAI-compatible provider (chat completions, streamed): it answers the
 * connection test with "OK", an explanation and a summary with fixed texts, and keeps what it
 * was sent.
 */
async function mockProvider(): Promise<MockProvider> {
  const prompts: string[] = [];
  const server: Server = createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    request.on("end", () => {
      const body = JSON.parse(raw === "" ? "{}" : raw) as {
        messages?: { role: string; content: unknown }[];
      };
      const user = (body.messages ?? [])
        .filter((message) => message.role === "user")
        .map((message) => (typeof message.content === "string" ? message.content : ""))
        .join("\n");
      prompts.push(user);
      const text = user.includes("Explain this query")
        ? EXPLANATION
        : user.includes("Summarize this result")
          ? SUMMARY
          : "OK";
      const half = Math.ceil(text.length / 2);
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const part of [text.slice(0, half), text.slice(half)]) {
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
      }
      response.write(
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 12 } })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    prompts,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Sets a server setting through the API, as the settings page does. */
async function setServerSetting(api: Api, key: string, value: unknown): Promise<void> {
  const list = (await (await api.context.get("/api/admin/settings")).json()) as {
    items: { key: string; version: number }[];
  };
  const version = list.items.find((item) => item.key === key)?.version ?? 0;
  const response = await api.context.patch(`/api/admin/settings/${key}`, {
    data: { value, version },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

test("an admin connects a provider and turns AI on; Explore explains a query and summarizes its result", async ({
  pageAs,
}) => {
  const mock = await mockProvider();
  // A server admin with an organization of their own: only this organization gets a provider,
  // so while AI is on here, the organizations of the other tests still show nothing of it.
  const owner = await Api.owner();
  const name = unique("Kim KI");
  const email = `${name.toLowerCase().replace(/[^a-z0-9]+/g, ".")}@kalzit.test`;
  const password = `pw-${Math.random().toString(36).slice(2)}-e2e`;
  const user = await owner.context.post("/api/admin/users", {
    data: { name, email, password, isServerAdmin: true },
  });
  expect(user.ok(), await user.text()).toBe(true);
  const userId = ((await user.json()) as { id: string }).id;
  const org = await owner.context.post("/api/admin/orgs", {
    data: { name: unique("KI Labor"), ownerUserId: userId },
  });
  expect(org.ok(), await org.text()).toBe(true);
  const admin = await Api.signIn(email, password);
  const sourceName = unique("KI Umsätze");
  const sourceId = await admin.createSqliteSource(sourceName, join(fixturesDir(), "sales.db"));

  try {
    const page = await pageAs(email, password);

    // Off: Explore has no AI buttons.
    await page.goto("/explore");
    await page.getByLabel(t("explore.datasource")).selectOption({ label: sourceName });
    await fillQuery(page, SQL.regions);
    await expect(page.getByRole("button", { name: t("ai.call.explain") })).toHaveCount(0);

    // The organization's own provider: entered, tested (which stores it), saved.
    await page.goto("/settings/org-ai");
    await page
      .getByRole("button", { name: t("ai.admin.providers.add") })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: t("ai.admin.dialog.addTitle") });
    await dialog.getByLabel(t("ai.admin.dialog.name")).fill("Lokal");
    await dialog.getByLabel(t("ai.admin.dialog.baseUrl")).fill(mock.baseUrl);
    await dialog.getByLabel(t("ai.admin.dialog.model"), { exact: true }).fill("modell-1");
    await dialog.getByRole("button", { name: t("ai.admin.dialog.test") }).click();
    await expect(dialog.getByText(t("ai.admin.dialog.testOk"))).toBeVisible();
    await dialog.getByRole("button", { name: t("ai.admin.dialog.save") }).click();
    await expect(dialog).toBeHidden();

    // The server switch turns on now that a provider in effect passed its test.
    await page.goto("/settings/ai");
    const enabled = page.getByRole("switch", { name: t("admin.settings.ai.enabled.label") });
    // The row applies on the server's answer, so the box turns on after it, not on the click.
    await enabled.click();
    await expect(enabled).toBeChecked();

    // The source is opened to AI where it is configured.
    await page.goto(`/data-sources/${sourceId}`);
    const access = page.getByRole("switch", { name: t("ai.source.readable") });
    await access.click();
    await expect(access).toBeChecked();

    // Explain: the first call shows the notice, then the answer streams in.
    await page.goto("/explore");
    await page.getByLabel(t("explore.datasource")).selectOption({ label: sourceName });
    await fillQuery(page, SQL.regions);
    await page.getByRole("button", { name: t("ai.call.explain") }).click();
    const notice = page.getByRole("dialog", { name: t("ai.notice.title") });
    await expect(notice).toContainText("127.0.0.1");
    await notice.getByRole("button", { name: t("ai.notice.confirm") }).click();
    const explanation = page.getByRole("region", { name: t("ai.call.explanationTitle") });
    await expect(explanation).toContainText(EXPLANATION);
    await expect(explanation).toContainText(t("ai.call.sentSchema"));

    // Summarize the result of the run.
    await page.getByRole("button", { name: t("explore.run") }).click();
    const result = page.getByRole("region", { name: t("explore.result") });
    await expect(result.getByText("Nord").first()).toBeVisible();
    await result.getByRole("button", { name: t("ai.call.summarize") }).click();
    const summary = page.getByRole("region", { name: t("ai.call.summaryTitleExplore") });
    await expect(summary).toContainText(SUMMARY);

    // What went to the provider: the query as data, the schema, the result rows in a block.
    const [explainPrompt, summaryPrompt] = mock.prompts.filter(
      (p) => p !== "Reply with the single word OK.",
    );
    expect(explainPrompt).toContain(`<kalzit:query>\n${SQL.regions}\n</kalzit:query>`);
    expect(explainPrompt).toContain("<kalzit:schema>");
    expect(summaryPrompt).toContain("<kalzit:result>");
    expect(summaryPrompt).toContain("Nord");
  } finally {
    // AI off again, for the tests that run after this one on the same server.
    await setServerSetting(owner, "ai.enabled", false);
    await admin.dispose();
    await owner.dispose();
    await mock.close();
  }
});
