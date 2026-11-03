// biome-ignore-all lint/suspicious/noTemplateCurlyInString: link placeholders such as ${__value} are typed by users, not template literals
import { describe, expect, it } from "vitest";
import { variablesFromSearch } from "../features/dashboards/links";
import {
  type DataLink,
  dataLinkHref,
  graphValue,
  isDataLinkUrl,
  linksForField,
  linksForRecord,
  MAX_DATA_LINKS,
  parseDataLinks,
} from "./dataLinks";

const link = (url: string, field = "customer.id"): DataLink => ({
  field,
  title: "Open",
  url,
  newTab: false,
});

describe("data link addresses", () => {
  it("take web addresses and pages of this server only, as the server does", () => {
    for (const url of [
      "https://shop.example/p/${__value}",
      "HTTP://intranet/x",
      "/dashboards/d-1?var-kunde=${__value}",
      "/explore",
    ]) {
      expect(isDataLinkUrl(url), url).toBe(true);
    }
    for (const url of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      " javascript:alert(1)",
      "data:text/html,x",
      "vbscript:x",
      "mailto:a@example.org",
      "//evil.example",
      "/\\evil.example",
      "https:\\\\evil.example",
      "https://",
      "https:///x",
      "https:evil",
      "${__value}",
      "x/y",
      "/a\nb",
      "/a\tb",
      "",
    ]) {
      expect(isDataLinkUrl(url), JSON.stringify(url)).toBe(false);
    }
  });
});

describe("filling in a data link", () => {
  it("encodes the value, the field and dashboard variables for the address", () => {
    const href = dataLinkHref(
      link("https://shop.example/c/${__value}?f=${__field}&r=${region}&h=$hosts"),
      "a b&c/?#ä",
      { region: "eu west", hosts: ["a", "b/c"] },
    );
    expect(href).toBe(
      "https://shop.example/c/a%20b%26c%2F%3F%23%C3%A4?f=customer.id&r=eu%20west&h=a,b%2Fc",
    );
  });

  it("links to another dashboard with the value as its variable", () => {
    expect(dataLinkHref(link("/dashboards/d-1?var-kunde=${__value}"), 42)).toBe(
      "/dashboards/d-1?var-kunde=42",
    );
    // Typed values (int64, ObjectId) give their value.
    expect(
      dataLinkHref(link("/dashboards/d-1?var-id=${__value}"), { $type: "int64", value: "9" }),
    ).toBe("/dashboards/d-1?var-id=9");
  });

  it("never lets a value choose the scheme or another site", () => {
    expect(dataLinkHref(link("/x/${__value}"), "//evil.example")).toBe("/x/%2F%2Fevil.example");
    expect(dataLinkHref(link("/r?to=${__value}"), "javascript:alert(1)")).toBe(
      "/r?to=javascript%3Aalert(1)",
    );
    // A stored template that is not allowed gives no link whatever the value.
    expect(dataLinkHref(link("${__value}"), "https://ok.example")).toBeNull();
    expect(dataLinkHref(link("javascript:${__value}"), "alert(1)")).toBeNull();
  });

  it("gives no link without a plain value or with an incomplete link", () => {
    const ok = link("/x/${__value}");
    expect(dataLinkHref(ok, undefined)).toBeNull();
    expect(dataLinkHref(ok, null)).toBeNull();
    expect(dataLinkHref(ok, "")).toBeNull();
    expect(dataLinkHref(ok, { a: 1 })).toBeNull();
    expect(dataLinkHref(ok, [1, 2])).toBeNull();
    expect(dataLinkHref({ ...ok, title: " " }, "1")).toBeNull();
    expect(dataLinkHref({ ...ok, field: "" }, "1")).toBeNull();
  });

  it("offers a field's links for its value and a record's links for the values it has", () => {
    const links = [
      link("/a/${__value}", "status"),
      { ...link("https://x.example/${__value}", "customer.name"), title: "Shop", newTab: true },
    ];
    expect(linksForField(links, "status", "paid")).toEqual([
      { title: "Open", href: "/a/paid", newTab: false },
    ]);
    expect(linksForField(links, "rating", 5)).toEqual([]);
    const record: Record<string, unknown> = { status: "open", customer: { name: "Ada Lovelace" } };
    const read = (field: string) =>
      field.split(".").reduce<unknown>((v, k) => (v as Record<string, unknown>)?.[k], record);
    expect(linksForRecord(links, read)).toEqual([
      { title: "Open", href: "/a/open", newTab: false },
      { title: "Shop", href: "https://x.example/Ada%20Lovelace", newTab: true },
    ]);
  });

  it("reads a graph element's property, and its own id for `id`", () => {
    expect(graphValue({ name: "Ada" }, "4:x:0", "name")).toBe("Ada");
    expect(graphValue({ name: "Ada" }, "4:x:0", "id")).toBe("4:x:0");
    expect(graphValue({ id: 7 }, "4:x:0", "id")).toBe(7);
    expect(graphValue({}, "4:x:0", "toString")).toBeUndefined();
  });
});

describe("stored data links", () => {
  it("keep what is typed, drop control characters and keep at most the limit", () => {
    const stored = [
      { field: "a\tb", title: "Open ", url: "https://x.example/\n", newTab: true },
      "not a link",
      { field: 3, title: null },
      ...Array.from({ length: MAX_DATA_LINKS + 5 }, () => ({ field: "f", title: "t", url: "/x" })),
    ];
    const links = parseDataLinks(stored, 100);
    expect(links).toHaveLength(MAX_DATA_LINKS);
    expect(links[0]).toEqual({
      field: "ab",
      title: "Open ",
      url: "https://x.example/",
      newTab: true,
    });
    expect(links[1]).toEqual({ field: "", title: "", url: "", newTab: false });
    expect(parseDataLinks("x", 100)).toEqual([]);
    expect(parseDataLinks([{ field: "x".repeat(200) }], 100)[0]?.field).toHaveLength(100);
  });
});

describe("variables from a dashboard's address", () => {
  it("reads var- parameters as text, several values as a list", () => {
    expect(variablesFromSearch("?var-kunde=007&var-hosts=a&var-hosts=b&from=now-1h")).toEqual({
      kunde: "007",
      hosts: ["a", "b"],
    });
    expect(variablesFromSearch("?var-region=eu%20west&var-=x&var-1x=y&var-a.b=z")).toEqual({
      region: "eu west",
    });
    const odd = variablesFromSearch("?var-__proto__=x");
    expect(Object.getPrototypeOf(odd)).toBe(Object.prototype);
    expect(Object.hasOwn(odd, "__proto__")).toBe(true);
    expect(variablesFromSearch("")).toEqual({});
  });
});
