import { QueryClient, QueryClientProvider, queryOptions } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SHOP_SCHEMA, t } from "../../graphPatterns/test/fixtures";

const api = vi.hoisted(() => ({ parse: vi.fn(), compile: vi.fn() }));

vi.mock("../../graphPatterns/api", () => ({
  GRAPH_PATTERNS_KEY: "graphPatterns",
  graphSchemaQuery: (orgId: string, id: string) =>
    queryOptions({
      queryKey: ["graphPatterns", orgId, "schema", id],
      queryFn: async () => SHOP_SCHEMA,
    }),
  parsePattern: api.parse,
  compilePattern: api.compile,
  fetchGraphSchema: vi.fn(),
  countInSchema: vi.fn(),
  fetchPlan: vi.fn(),
  fetchChoices: vi.fn(),
}));

const { GraphModes } = await import("./GraphModes");

function renderModes(query: unknown, onChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const text =
    typeof query === "object" && query !== null && "cypher" in query
      ? String((query as { cypher: string }).cypher)
      : "";
  render(
    <QueryClientProvider client={client}>
      <GraphModes
        orgId="org"
        datasource={{ id: "ds", kind: "neo4j" }}
        query={query}
        onChange={onChange}
        language="Cypher"
        text={text}
        textQuery={(cypher) => ({ cypher })}
        drawable
      >
        <p>text editor</p>
      </GraphModes>
    </QueryClientProvider>,
  );
  return onChange;
}

const mode = () => screen.getByRole("group", { name: t("datasources.editor.pattern.mode") });

beforeEach(() => {
  api.parse.mockReset();
  api.compile.mockReset();
});

describe("the two forms of a graph query", () => {
  it("opens the empty builder from an empty text", () => {
    const onChange = renderModes({ cypher: "" });
    expect(screen.getByText("text editor")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: t("datasources.editor.pattern.pattern") }));
    expect(onChange).toHaveBeenCalledWith({ pattern: { nodes: [] } });
    expect(mode()).toBeTruthy();
  });

  it("reads a text back into a pattern when it can be drawn", async () => {
    const pattern = { nodes: [{ id: "k", labels: ["Kunde"] }] };
    api.parse.mockResolvedValue({ representable: true, pattern });
    const onChange = renderModes({ cypher: "MATCH (k:Kunde) RETURN k" });
    fireEvent.click(screen.getByRole("button", { name: t("datasources.editor.pattern.open") }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ pattern }));
    expect(api.parse).toHaveBeenCalledWith("org", "ds", "MATCH (k:Kunde) RETURN k", {});
  });

  it("says why a text cannot be drawn and leaves it as it is", async () => {
    api.parse.mockResolvedValue({
      representable: false,
      reason: "pattern.not_representable",
      params: { part: "WITH" },
      message: "not representable as a pattern: WITH",
    });
    const onChange = renderModes({ cypher: "MATCH (k) WITH k RETURN k" });
    fireEvent.click(screen.getByRole("button", { name: t("datasources.editor.pattern.open") }));
    expect(
      await screen.findByText(t("datasources.reason.pattern.not_representable", { part: "WITH" })),
    ).toBeTruthy();
    expect(onChange).not.toHaveBeenCalled();
    // Clicking "Pattern" on a text that is not empty shows the text is in force.
    fireEvent.click(screen.getByRole("button", { name: t("datasources.editor.pattern.pattern") }));
    expect(await screen.findByText(t("graphPatterns.modes.textOnly"))).toBeTruthy();
  });

  it("takes the generated query into the text, with Kalzit's literals written out", async () => {
    api.compile.mockResolvedValue({
      text: "MATCH kz_p0 = (k:Kunde)\nWHERE k.name = $kz_v0\nRETURN kz_p0\nLIMIT 500",
      parameters: { kz_v0: "Tom" },
      limit: 500,
    });
    const pattern = {
      nodes: [
        {
          id: "k",
          labels: ["Kunde"],
          conditions: [{ property: "name", op: "eq", value: { value: "Tom" } }],
        },
      ],
    };
    const onChange = renderModes({ pattern });
    fireEvent.click(screen.getByRole("button", { name: "Cypher" }));
    await waitFor(() =>
      expect(onChange).toHaveBeenCalledWith({
        cypher: "MATCH kz_p0 = (k:Kunde)\nWHERE k.name = 'Tom'\nRETURN kz_p0\nLIMIT 500",
      }),
    );
  });
});
