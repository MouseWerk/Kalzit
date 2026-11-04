import { isRecord } from "../../api/client";
import type { TextRange } from "../dashboards/timeRange";

/*
 * "Share" in Explore: the state on screen (data source, query, time range, steps and
 * visualization) as a link inside the organization. The link carries the state itself, nothing
 * is stored: whoever opens it is signed in, sees only the sources they may query, and running
 * the query is a free query that needs `datasources:query` as always.
 */

export interface SharedExplore {
  orgId: string;
  datasourceId: string;
  query: unknown;
  range: TextRange;
  steps: unknown[];
  /** The visualization; absent follows the suggestion for the result. */
  panel?: string | undefined;
}

/** Longer links break in mail and chat clients and in some proxies; save and share instead. */
export const MAX_SHARE_CHARS = 8000;

const VERSION = 1;

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/** The state as the value of the `share` parameter. */
export function encodeShare(state: SharedExplore): string {
  return toBase64Url(
    JSON.stringify({
      v: VERSION,
      o: state.orgId,
      d: state.datasourceId,
      q: state.query,
      r: state.range,
      s: state.steps,
      ...(state.panel === undefined ? {} : { p: state.panel }),
    }),
  );
}

/** The state of a `share` parameter; `null` for one that is damaged or from a newer version. */
export function decodeShare(value: string): SharedExplore | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64Url(value));
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    parsed.v !== VERSION ||
    typeof parsed.o !== "string" ||
    typeof parsed.d !== "string" ||
    !isRecord(parsed.r) ||
    typeof parsed.r.from !== "string" ||
    typeof parsed.r.to !== "string"
  ) {
    return null;
  }
  return {
    orgId: parsed.o,
    datasourceId: parsed.d,
    query: parsed.q,
    range: { from: parsed.r.from, to: parsed.r.to },
    steps: Array.isArray(parsed.s) ? parsed.s : [],
    ...(typeof parsed.p === "string" ? { panel: parsed.p } : {}),
  };
}

/** The address of a shared state, or of a saved analysis without changes (it follows its saves). */
export function shareUrl(origin: string, search: { share: string } | { analysis: string }): string {
  const url = new URL("/explore", origin);
  if ("share" in search) {
    url.searchParams.set("share", search.share);
  } else {
    url.searchParams.set("analysis", search.analysis);
  }
  return url.toString();
}
