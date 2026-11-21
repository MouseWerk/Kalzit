import type { FakeArea } from "../../../test/fakeServer";
import type { MapAdminView, MapTestResult } from "../mapApi";

/**
 * The routes of the map images for tests (docs/api/map.md): Verwaltung > Karte and what a map
 * panel asks. They keep what the tests arrange and answer the refusals the page shows; the server
 * checks the rest itself.
 */
export interface FakeMapState {
  view: MapAdminView;
  /** The refusal of the next test or save; null passes. */
  refuse: { status: number; code: string; reason: string; field?: string; params?: object } | null;
  /** Every body of the test, save and switch routes, in order. */
  tests: unknown[];
  saves: unknown[];
  switches: unknown[];
}

export const TESTED: MapTestResult = {
  z: 6,
  x: 33,
  y: 21,
  bytes: 14_336,
  contentType: "image/png",
  elapsedMs: 180,
  viaProxy: true,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const refusal = (r: NonNullable<FakeMapState["refuse"]>) =>
  json(r.status, {
    error: {
      code: r.code,
      message: `server message for ${r.reason}`,
      reason: r.reason,
      ...(r.field === undefined ? {} : { field: r.field }),
      ...(r.params === undefined ? {} : { params: r.params }),
    },
  });

export function mapFake(): FakeArea<FakeMapState> {
  return {
    state: {
      view: {
        source: null,
        hasKey: false,
        version: 0,
        proxy: "proxy.intern.example:3128",
        cache: { bytes: 0, tiles: 0 },
        lastError: null,
      },
      refuse: null,
      tests: [],
      saves: [],
      switches: [],
    },
    // Only server routes, below.
    handle: () => undefined,
  };
}

export function handleMapRoute(
  state: FakeMapState,
  path: string,
  method: string,
  input: Record<string, unknown>,
): Response | undefined {
  const [route = ""] = path.split("?");
  if (route === "/api/map" && method === "GET") {
    const source = state.view.source;
    return json(
      200,
      source?.enabled === true
        ? { tiles: true, attribution: source.attribution, maxZoom: source.maxZoom }
        : { tiles: false },
    );
  }
  if (route === "/api/admin/map" && method === "GET") {
    return json(200, state.view);
  }
  if (route === "/api/admin/map/test" && method === "POST") {
    state.tests.push(input);
    return state.refuse === null ? json(200, TESTED) : refusal(state.refuse);
  }
  if (route === "/api/admin/map" && method === "PUT") {
    state.saves.push(input);
    if (state.refuse !== null) {
      return refusal(state.refuse);
    }
    if (input.version !== state.view.version) {
      return json(409, { error: { code: "version_conflict", message: "changed" } });
    }
    const source = input.source as Omit<NonNullable<MapAdminView["source"]>, "enabled">;
    state.view = {
      ...state.view,
      source: { ...source, enabled: true },
      hasKey: typeof input.key === "string" ? input.key !== "" : state.view.hasKey,
      version: state.view.version + 1,
    };
    return json(200, state.view);
  }
  if (route === "/api/admin/map/enabled" && method === "PUT") {
    state.switches.push(input);
    const source = state.view.source;
    if (source === null) {
      return refusal({ status: 409, code: "conflict", reason: "map.not_configured" });
    }
    state.view = {
      ...state.view,
      source: { ...source, enabled: input.enabled === true },
      version: state.view.version + 1,
      cache: input.enabled === true ? state.view.cache : { bytes: 0, tiles: 0 },
    };
    return json(200, state.view);
  }
  return undefined;
}
