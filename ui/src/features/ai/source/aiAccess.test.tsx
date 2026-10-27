import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { openAdmin } from "../../admin/test/openAdmin";
import { PG_ID } from "../../datasources/test/fakeDatasources";

const USABLE = {
  enabled: true,
  usable: true,
  noticeAcknowledged: true,
  provider: {
    id: "p1",
    name: "Local",
    kind: "openai",
    model: "m",
    host: "llm.internal",
    scope: "server",
  },
  maxRowsToModel: 150,
};

function puts(server: { calls: { method: string; path: string; body: unknown }[] }) {
  return server.calls
    .filter((call) => call.method === "PUT" && call.path.endsWith("/ai-access"))
    .map((call) => call.body);
}

/** The AI part of the source's settings, once its access has loaded. */
async function aiPart(): Promise<HTMLElement> {
  const part = await screen.findByRole("region", { name: "AI" });
  await within(part).findByRole("switch", { name: "AI may read" });
  return part;
}

describe("AI access of a data source", () => {
  it("is absent while AI is off, and the list shows no badge", async () => {
    const { server } = await openAdmin(`/data-sources/${PG_ID}`, {
      setupServer: (s) => {
        s.areas.aiAdmin.access[PG_ID] = { readable: true, excludedFields: ["email"] };
      },
    });
    expect(await screen.findByRole("heading", { level: 1, name: "Sales DB" })).toBeTruthy();
    await waitFor(() =>
      expect(server.calls.some((call) => call.path.endsWith("/ai/status"))).toBe(true),
    );
    expect(screen.queryByRole("region", { name: "AI" })).toBeNull();
    expect(screen.queryByText("AI may read")).toBeNull();
    expect(server.calls.some((call) => call.path.includes("/ai-access"))).toBe(false);
  });

  it("opens the source to AI and edits the excluded fields, with the row limit", async () => {
    const { user, server } = await openAdmin(`/data-sources/${PG_ID}`, {
      setupServer: (s) => {
        s.areas.aiAdmin.status = USABLE;
      },
    });
    const part = await aiPart();
    expect(within(part).getByText(/At most 150 rows, documents or nodes per result/)).toBeTruthy();
    const toggle = await within(part).findByRole("switch", { name: "AI may read" });
    expect((toggle as HTMLInputElement).checked).toBe(false);
    await user.click(toggle);
    await waitFor(() => expect(puts(server)).toEqual([{ readable: true, excludedFields: [] }]));
    await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(true));

    const field = within(part).getByRole("textbox", { name: "Excluded fields" });
    await user.type(field, "kunden.email{Enter}");
    await waitFor(() =>
      expect(puts(server).at(-1)).toEqual({ readable: true, excludedFields: ["kunden.email"] }),
    );
    expect(await within(part).findByText("kunden.email")).toBeTruthy();

    // A path with an empty part is refused at the field before anything is sent.
    await user.type(field, "kunden..iban{Enter}");
    const problem = await within(part).findByText(
      "Enter a name or dotted path of at most 256 characters, without empty parts.",
    );
    expect(problem.closest("[role=alert]")).toBeTruthy();
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(puts(server)).toHaveLength(2);

    await user.click(within(part).getByRole("button", { name: "Remove kunden.email" }));
    await waitFor(() =>
      expect(puts(server).at(-1)).toEqual({ readable: true, excludedFields: [] }),
    );
    expect(server.areas.aiAdmin.access[PG_ID]).toEqual({ readable: true, excludedFields: [] });
  });

  it("shows the server's reason at the field when it refuses the list", async () => {
    const { user } = await openAdmin(`/data-sources/${PG_ID}`, {
      setupServer: (s) => {
        s.areas.aiAdmin.status = USABLE;
        s.areas.aiAdmin.access[PG_ID] = {
          readable: true,
          excludedFields: Array.from({ length: 199 }, (_, i) => `f${i}`),
        };
        // An entry the server refuses, so the next change is answered with the reason.
        s.areas.aiAdmin.access[PG_ID].excludedFields.push("f.");
      },
    });
    const part = await aiPart();
    const field = within(part).getByRole("textbox", { name: "Excluded fields" });
    await user.click(within(part).getByRole("button", { name: "Remove f0" }));
    const reason = await within(part).findByText(
      "Enter at most 200 fields, each a name or a dotted path without empty parts.",
    );
    expect(reason.closest("[role=alert]")).toBeTruthy();
    expect(field.getAttribute("aria-invalid")).toBe("true");
  });

  it("is read-only with the reason for those who may not edit the source", async () => {
    const { server } = await openAdmin(`/data-sources/${PG_ID}`, {
      permissions: ["datasources:read", "datasources:query"],
      setupServer: (s) => {
        s.areas.aiAdmin.status = USABLE;
        s.areas.aiAdmin.access[PG_ID] = { readable: true, excludedFields: ["email"] };
      },
    });
    const part = await aiPart();
    expect(
      within(part).getByText("Only those who may edit this data source can open it to AI."),
    ).toBeTruthy();
    const toggle = await within(part).findByRole("switch", { name: "AI may read" });
    expect((toggle as HTMLInputElement).disabled).toBe(true);
    expect(within(part).getByText("email")).toBeTruthy();
    expect(within(part).queryByRole("textbox")).toBeNull();
    expect(within(part).queryByRole("button", { name: "Remove email" })).toBeNull();
    expect(puts(server)).toEqual([]);
  });

  it("marks opened sources in the list while AI is usable", async () => {
    await openAdmin("/data-sources", {
      setupServer: (s) => {
        s.areas.aiAdmin.status = USABLE;
        s.areas.aiAdmin.access[PG_ID] = { readable: true, excludedFields: [] };
      },
    });
    const table = await screen.findByRole("table");
    const row = (await within(table).findByRole("link", { name: "Sales DB" })).closest(
      "tr",
    ) as HTMLElement;
    expect(await within(row).findByText("AI may read")).toBeTruthy();
    expect(within(table).getAllByText("AI may read")).toHaveLength(1);
  });
});
