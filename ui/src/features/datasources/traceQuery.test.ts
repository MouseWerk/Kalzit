import { describe, expect, it } from "vitest";
import { hasQuery } from "./queryKinds";
import {
  EMPTY_SEARCH,
  parseTraceSearch,
  searchTraceQl,
  traceMode,
  traceSearchQuery,
  validDuration,
  validTagName,
  validTraceId,
} from "./traceQuery";

describe("trace queries", () => {
  it("tells the three forms apart", () => {
    expect(traceMode({ service: "shop" })).toBe("search");
    expect(traceMode({})).toBe("search");
    expect(traceMode({ traceql: "{}" })).toBe("traceql");
    expect(traceMode({ traceId: "ab" })).toBe("traceId");
  });

  it("writes only the fields that are filled in, and reads them back", () => {
    const search = {
      ...EMPTY_SEARCH,
      service: " shop ",
      tags: [
        ["http.status_code", "500"],
        ["", "ignored"],
      ] as [string, string][],
      minDuration: "250ms",
      status: "error" as const,
      limit: "5000",
    };
    const query = traceSearchQuery(search);
    expect(query).toEqual({
      service: "shop",
      tags: { "http.status_code": "500" },
      minDuration: "250ms",
      status: "error",
      limit: 1000,
    });
    expect(parseTraceSearch(query)).toEqual({
      ...EMPTY_SEARCH,
      service: "shop",
      tags: [["http.status_code", "500"]],
      minDuration: "250ms",
      status: "error",
      limit: "1000",
    });
    // Nothing filled in is the empty query, which does not run.
    expect(traceSearchQuery(EMPTY_SEARCH)).toEqual({ service: "" });
    expect(hasQuery(traceSearchQuery(EMPTY_SEARCH), "tempo")).toBe(false);
    // A search with only a status, or only a limit, runs; it names no empty service.
    expect(traceSearchQuery({ ...EMPTY_SEARCH, status: "error" })).toEqual({ status: "error" });
    expect(hasQuery({ limit: 20 }, "tempo")).toBe(true);
  });

  it("writes the TraceQL of a search as the server does", () => {
    // server/src/datasources/tempo.rs, `searches_without_traceql_write_it`.
    expect(
      searchTraceQl({
        ...EMPTY_SEARCH,
        service: "kasse",
        status: "error",
        tags: [["http.status_code", "500"]],
      }),
    ).toBe('{ resource.service.name = "kasse" && .http.status_code = 500 && status = error }');
    expect(searchTraceQl(EMPTY_SEARCH)).toBe("{}");
    expect(
      searchTraceQl({
        ...EMPTY_SEARCH,
        operation: 'say "hi"\\now',
        tags: [
          ["span.z", "true"],
          ["resource.env", "prod"],
          [".a", "1.5"],
        ],
        minDuration: "250ms",
        maxDuration: "2s",
      }),
    ).toBe(
      '{ name = "say \\"hi\\"\\\\now" && .a = 1.5 && resource.env = "prod" && span.z = true && duration >= 250ms && duration <= 2s }',
    );
  });

  it("checks durations, tag names and trace ids as the server does", () => {
    for (const good of ["", "250ms", "2s", "1.5m", "10us", "3µs", "1h"]) {
      expect(validDuration(good), good).toBe(true);
    }
    for (const bad of ["250", "ms", "2 s", "1d"]) {
      expect(validDuration(bad), bad).toBe(false);
    }
    expect(validTagName("http.status_code")).toBe(true);
    expect(validTagName("k8s/pod:name-1")).toBe(true);
    expect(validTagName("a b")).toBe(false);
    expect(validTraceId("4bf92f3577b34da6a3ce929d0e0e4736")).toBe(true);
    expect(validTraceId("AB")).toBe(true);
    expect(validTraceId("xyz")).toBe(false);
    expect(validTraceId("4bf92f3577b34da6a3ce929d0e0e47360")).toBe(false);
  });
});
