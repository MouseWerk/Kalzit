import { describe, expect, it } from "vitest";
import type { Pattern } from "../../api/generated/shapes";
import { translate } from "../../i18n/i18n";
import { hasQuery } from "../datasources/queryKinds";
import {
  addEdge,
  addNode,
  elementOrder,
  fillTitle,
  isAlias,
  layoutPattern,
  operatorsFor,
  readList,
  readValue,
  removeElement,
  renameElement,
  reverseEdge,
  sampleVariables,
  textForEditing,
  textParameters,
  typedSample,
  updateNode,
  warningsOf,
  withParameters,
} from "./pattern";
import { patternSentence } from "./sentence";
import { SHOP_SCHEMA } from "./test/fixtures";

/** "Kunden von $lieferant" from frame 1. */
function suppliersCustomers(): Pattern {
  let p: Pattern = { nodes: [] };
  p = addNode(p, ["Kunde"]).pattern;
  p = addNode(p, ["Produkt"]).pattern;
  p = addNode(p, ["Lieferant"]).pattern;
  p = addEdge(p, "k", "p", ["KAUFT"]).pattern;
  p = addEdge(p, "l", "p", ["LIEFERT"]).pattern;
  p = updateNode(p, "l", {
    conditions: [{ property: "name", op: "eq", value: { param: "lieferant" } }],
  });
  return withParameters(p, SHOP_SCHEMA);
}

describe("building a pattern", () => {
  it("names nodes after their label and edges in order, never twice", () => {
    let p: Pattern = { nodes: [] };
    const first = addNode(p, ["Kunde"]);
    p = first.pattern;
    const second = addNode(p, ["Kunde"]);
    p = second.pattern;
    const any = addNode(p);
    p = any.pattern;
    expect([first.id, second.id, any.id]).toEqual(["k", "k2", "n"]);
    const edge = addEdge(p, "k", "k2");
    expect(edge.id).toBe("e1");
    expect(addEdge(edge.pattern, "k", "n").id).toBe("e2");
  });

  it("removes a node with its edges and the parameters only they used", () => {
    const p = suppliersCustomers();
    expect(p.parameters).toEqual([{ name: "lieferant", type: "string" }]);
    const without = removeElement(p, { kind: "node", id: "l" });
    expect(without.nodes.map((n) => n.id)).toEqual(["k", "p"]);
    expect(without.edges?.map((e) => e.id)).toEqual(["e1"]);
    expect(without.parameters).toBeUndefined();
  });

  it("renames an element everywhere and turns an edge around", () => {
    const p = renameElement(suppliersCustomers(), "p", "prod");
    expect(p.edges?.map((e) => [e.from, e.to])).toEqual([
      ["k", "prod"],
      ["l", "prod"],
    ]);
    const turned = reverseEdge(p, "e2");
    expect(turned.edges?.[1]?.direction).toBe("in");
    expect(reverseEdge(turned, "e2").edges?.[1]?.direction).toBe("out");
  });

  it("types a parameter by the property it is compared with, as a list after “one of”", () => {
    let p = suppliersCustomers();
    p = updateNode(p, "k", {
      conditions: [{ property: "kundennr", op: "in", value: { param: "nummern" } }],
    });
    p = withParameters(p, SHOP_SCHEMA);
    expect(p.parameters).toEqual([
      { name: "nummern", type: "integerList" },
      { name: "lieferant", type: "string" },
    ]);
    // A label given in the save dialog stays while the parameter keeps its form.
    p = withParameters({
      ...p,
      parameters: [{ name: "lieferant", type: "string", label: "Lieferant" }],
    });
    expect(p.parameters?.find((x) => x.name === "lieferant")?.label).toBe("Lieferant");
  });

  it("keeps only names a query takes", () => {
    expect(isAlias("lieferant")).toBe(true);
    expect(isAlias("1x")).toBe(false);
    expect(isAlias("kz_v0")).toBe(false);
    expect(isAlias("match")).toBe(false);
  });

  it("offers the comparisons of the property's type, without those GSQL lacks", () => {
    expect(operatorsFor("text", "cypher")).toContain("startsWith");
    expect(operatorsFor("text", "gsql")).not.toContain("startsWith");
    expect(operatorsFor("text", "gsql")).not.toContain("isNull");
    expect(operatorsFor("number", "cypher")).toContain("ge");
    expect(operatorsFor("boolean", "cypher")).toEqual(["eq", "isNotNull", "isNull"]);
  });
});

describe("values", () => {
  it("reads a value in the property's type, $name as a variable", () => {
    expect(readValue("$mindestbetrag", "number", "ge")).toEqual({
      operand: { param: "mindestbetrag" },
    });
    expect(readValue("100", "number", "ge")).toEqual({ operand: { value: 100 } });
    expect(readValue("2,5", "number", "ge")).toEqual({ operand: { value: 2.5 } });
    expect(readValue("viel", "number", "ge")).toEqual({ error: "number" });
    expect(readValue("$1", "text", "eq")).toEqual({ error: "alias" });
    expect(readValue("a, b; c", "text", "in")).toEqual({ operand: { value: ["a", "b", "c"] } });
  });

  it("reads pasted values as the server does: repeats and empty lines left out and counted", () => {
    const pasted = "4711\n4712\n4712\n\n4720, 4731; 4733\n4801\nK-4802\n";
    const read = readList(pasted, "integerList");
    expect(read.values).toEqual(["4711", "4712", "4720", "4731", "4733", "4801", "K-4802"]);
    expect(read.duplicates).toBe(1);
    expect(read.empty).toBe(1);
    expect(read.wrong).toEqual(["K-4802"]);
    // Ids split at spaces too.
    expect(readList("4:a:1 4:a:2", "idList").values).toEqual(["4:a:1", "4:a:2"]);
    expect(readList("Nord Handel", "stringList").values).toEqual(["Nord Handel"]);
  });

  it("sends a sample only when it fits its type", () => {
    expect(typedSample("integer", "12")).toBe(12);
    expect(typedSample("integer", "1.5")).toBeUndefined();
    expect(typedSample("float", "1,5")).toBe(1.5);
    expect(typedSample("string", "")).toBeUndefined();
    expect(typedSample("integerList", "1\n2\n2")).toEqual([1, 2]);
    expect(typedSample("integerList", "1\nzwei")).toBeUndefined();
    expect(
      sampleVariables(
        [
          { name: "lieferant", type: "string" },
          { name: "mindest", type: "integer" },
        ],
        { lieferant: "Nordhandel GmbH" },
      ),
    ).toEqual({ lieferant: "Nordhandel GmbH" });
  });
});

describe("the way to the text", () => {
  it("writes Kalzit's own literal parameters back as Cypher literals, the template's stay", () => {
    const text =
      "MATCH kz_p0 = (k:Kunde)-[e:KAUFT]->(p:Produkt)\nWHERE p.preis > $kz_v0 AND p.name = $kz_v1 AND k.name = $kunde AND p.x IN $kz_v10\nRETURN kz_p0\nLIMIT 500";
    const params = { kz_v0: 100, kz_v1: "O'Brien \\ Söhne", kz_v10: ["a", "b"], kunde: "Tom" };
    expect(textForEditing(text, params, "cypher").text).toBe(
      "MATCH kz_p0 = (k:Kunde)-[e:KAUFT]->(p:Produkt)\nWHERE p.preis > 100 AND p.name = 'O\\'Brien \\\\ Söhne' AND k.name = $kunde AND p.x IN ['a', 'b']\nRETURN kz_p0\nLIMIT 500",
    );
  });

  it("keeps GSQL's typed header and hands its own values over as the query's parameters", () => {
    const text = "INTERPRET QUERY (STRING kz_v0, STRING lieferant) FOR GRAPH g SYNTAX v2 { }";
    expect(textForEditing(text, { kz_v0: "x", lieferant: "N" }, "gsql")).toEqual({
      text,
      params: { kz_v0: "x" },
    });
  });

  it("finds the $names of a Cypher text, not those in strings, comments or macros", () => {
    expect(
      textParameters(
        "MATCH (k) WHERE k.name = $kunde AND k.t > $__from // $not\nAND k.x = '$text' RETURN k, $kunde",
      ),
    ).toEqual(["kunde"]);
  });

  it("fills a template's title with the values given", () => {
    expect(fillTitle("Kunden von $lieferant", { lieferant: "Nordhandel GmbH" })).toBe(
      "Kunden von Nordhandel GmbH",
    );
    expect(fillTitle("Kunden von $lieferant", {})).toBe("Kunden von $lieferant");
  });

  it("runs a pattern once it has a node", () => {
    expect(hasQuery({ pattern: { nodes: [] } }, "neo4j")).toBe(false);
    expect(hasQuery({ pattern: { nodes: [{ id: "k" }] } }, "neo4j")).toBe(true);
    expect(hasQuery({ pattern: { nodes: [{ id: "k" }] } }, "tigergraph")).toBe(true);
  });
});

describe("checks before a run", () => {
  it("says when a pattern restricts nothing", () => {
    const open = addEdge(addNode(addNode({ nodes: [] }).pattern).pattern, "n", "n2").pattern;
    expect(warningsOf(open, SHOP_SCHEMA, "cypher")).toEqual([{ kind: "open" }]);
    expect(warningsOf(suppliersCustomers(), SHOP_SCHEMA, "cypher")).toEqual([]);
  });

  it("says when the schema has no such edge type between the labels", () => {
    let p = addNode(addNode({ nodes: [] }, ["Kunde"]).pattern, ["Lieferant"]).pattern;
    p = addEdge(p, "k", "l", ["LIEFERT"]).pattern;
    expect(warningsOf(p, SHOP_SCHEMA, "cypher")).toEqual([
      { kind: "edgeNotInSchema", edge: "e1", type: "LIEFERT", from: "Kunde", to: "Lieferant" },
    ]);
    // Turned around, LIEFERT runs from Lieferant to... Kunde is still not Produkt.
    expect(warningsOf(reverseEdge(p, "e1"), SHOP_SCHEMA, "cypher")).toHaveLength(1);
  });

  it("holds an optional part in GSQL", () => {
    const p = suppliersCustomers();
    const optional = {
      ...p,
      edges: (p.edges ?? []).map((e) => (e.id === "e2" ? { ...e, optional: true } : e)),
    };
    expect(warningsOf(optional, SHOP_SCHEMA, "gsql")).toEqual([
      { kind: "gsqlOptional", edge: "e2" },
    ]);
    expect(warningsOf(optional, SHOP_SCHEMA, "cypher")).toEqual([]);
  });
});

describe("drawing and reading", () => {
  it("lays the pattern out along its edges, the same way each time", () => {
    const layout = layoutPattern(suppliersCustomers());
    expect(layout.nodes.map((n) => [n.id, n.x, n.y])).toEqual([
      ["k", 70, 70],
      ["p", 270, 70],
      ["l", 470, 70],
    ]);
    expect(layoutPattern(suppliersCustomers())).toEqual(layout);
  });

  it("lists the elements in the order of the query", () => {
    expect(elementOrder(suppliersCustomers())).toEqual([
      { kind: "node", id: "k" },
      { kind: "edge", id: "e1" },
      { kind: "node", id: "p" },
      { kind: "edge", id: "e2" },
      { kind: "node", id: "l" },
    ]);
  });

  it("says the pattern in plain language, in German and English", () => {
    const de = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
      translate("de", key, params);
    const en = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
      translate("en", key, params);
    expect(patternSentence(de, "de", suppliersCustomers())).toBe(
      "Finde Kunde k, Produkt p und Lieferant l. k hat eine Kante KAUFT zu p. l hat eine Kante LIEFERT zu p. Bei l: name ist $lieferant. Höchstens 500 Treffer.",
    );
    expect(patternSentence(en, "en", suppliersCustomers())).toBe(
      "Find Kunde k, Produkt p, and Lieferant l. k has an edge KAUFT to p. l has an edge LIEFERT to p. For l: name is $lieferant. At most 500 matches.",
    );
  });
});
