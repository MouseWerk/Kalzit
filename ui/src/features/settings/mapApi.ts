/**
 * The source of the map images (docs/api/map.md), server administrators only. Its fields are
 * saved in one step after the server loaded an image with them; switching the map images off
 * applies at once.
 */
import { expectShape, isRecord, request } from "../../api/client";

export interface TileSourceFields {
  urlTemplate: string;
  attribution: string;
  maxZoom: number;
  cacheMaxMb: number;
  cacheTtlDays: number;
}

export interface TileSource extends TileSourceFields {
  enabled: boolean;
}

/** The fields the server names in `error.field`. */
export type MapField = keyof TileSourceFields | "key";

export interface MapLastError {
  reason: string;
  params: Record<string, string>;
  message: string;
  at: number;
}

export interface MapAdminView {
  /** null: never set up. `enabled: false`: switched off, the fields are kept. */
  source: TileSource | null;
  hasKey: boolean;
  version: number;
  /** `host:port` of the outbound proxy the fetches go through, if one is set. */
  proxy: string | null;
  cache: { bytes: number; tiles: number };
  lastError: MapLastError | null;
}

export interface MapTestResult {
  z: number;
  x: number;
  y: number;
  bytes: number;
  contentType: string;
  elapsedMs: number;
  viaProxy: boolean;
}

export const mapAdminKey = ["admin", "map"] as const;

function isSource(value: unknown): value is TileSource {
  return (
    isRecord(value) &&
    typeof value.enabled === "boolean" &&
    typeof value.urlTemplate === "string" &&
    typeof value.attribution === "string" &&
    typeof value.maxZoom === "number" &&
    typeof value.cacheMaxMb === "number" &&
    typeof value.cacheTtlDays === "number"
  );
}

function isLastError(value: unknown): value is MapLastError {
  return (
    isRecord(value) &&
    typeof value.reason === "string" &&
    isRecord(value.params) &&
    typeof value.message === "string" &&
    typeof value.at === "number"
  );
}

function isView(value: unknown): value is MapAdminView {
  return (
    isRecord(value) &&
    (value.source === null || isSource(value.source)) &&
    typeof value.hasKey === "boolean" &&
    typeof value.version === "number" &&
    (value.proxy === null || typeof value.proxy === "string") &&
    isRecord(value.cache) &&
    typeof value.cache.bytes === "number" &&
    typeof value.cache.tiles === "number" &&
    (value.lastError === null || isLastError(value.lastError))
  );
}

function isTestResult(value: unknown): value is MapTestResult {
  return (
    isRecord(value) &&
    typeof value.z === "number" &&
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    typeof value.bytes === "number" &&
    typeof value.contentType === "string" &&
    typeof value.elapsedMs === "number" &&
    typeof value.viaProxy === "boolean"
  );
}

export async function getMapAdmin(): Promise<MapAdminView> {
  return expectShape(await request("GET", "/api/admin/map"), isView, "map settings");
}

/** `key` undefined keeps the stored one (same host), "" uses none. */
function withKey(body: Record<string, unknown>, key: string | undefined) {
  return key === undefined ? body : { ...body, key };
}

export async function testMapSource(
  source: TileSourceFields,
  key: string | undefined,
): Promise<MapTestResult> {
  return expectShape(
    await request("POST", "/api/admin/map/test", withKey({ source }, key)),
    isTestResult,
    "map image test",
  );
}

/** Saves and switches the map images on, after the server loaded an image with these values. */
export async function saveMapSource(
  source: TileSourceFields,
  key: string | undefined,
  version: number,
): Promise<MapAdminView> {
  return expectShape(
    await request("PUT", "/api/admin/map", withKey({ source, version }, key)),
    isView,
    "map settings",
  );
}

/** Off applies at once; on again is its undo and uses the stored source. */
export async function switchMapImages(enabled: boolean, version: number): Promise<MapAdminView> {
  return expectShape(
    await request("PUT", "/api/admin/map/enabled", { enabled, version }),
    isView,
    "map settings",
  );
}
