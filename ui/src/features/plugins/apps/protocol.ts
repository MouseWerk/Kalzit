import { isApiError, isRecord, request } from "../../../api/client";
import { type AppInfo, appStorage } from "./api";

/**
 * The app message API, version 1 (docs/api/plugins.md, "App plugins"): a page in its sandboxed
 * frame asks Kalzit's page around it, which answers each request through the route Kalzit's own
 * pages use, with the signed-in person's rights, read-only except the app's own storage. A type
 * whose capability the manifest does not name is refused; nothing else is answered.
 */
export const APP_API = 1;

export interface AppRequest {
  type: string;
  id: string | number;
  payload: Record<string, unknown>;
}

export type AppMessage = { kind: "ready" } | { kind: "request"; request: AppRequest } | null;

/** A message of an app page, or null for anything that is not one. */
export function parseAppMessage(data: unknown): AppMessage {
  if (!isRecord(data) || data.kalzit !== "app" || data.api !== APP_API) return null;
  if (typeof data.type !== "string") return null;
  if (data.type === "ready") return { kind: "ready" };
  if (typeof data.id !== "string" && typeof data.id !== "number") return null;
  const { kalzit: _k, api: _a, type, id, ...payload } = data;
  return { kind: "request", request: { type, id, payload } };
}

/** The capability each request type needs. */
const NEEDS: Record<string, string> = {
  "dashboards.list": "dashboards:read",
  "dashboards.get": "dashboards:read",
  "analyses.list": "analyses:read",
  "analyses.get": "analyses:read",
  "analyses.run": "analyses:run",
  "storage.list": "storage",
  "storage.get": "storage",
  "storage.put": "storage",
  "storage.delete": "storage",
};

export interface AppError {
  code: string;
  reason?: string;
  message: string;
}

/**
 * How many requests one page may send: `burst` at once, then `perSecond` on average. A page
 * that asks faster is refused with `rate_limited`, not queued, so it cannot keep Kalzit's page
 * or the server busy.
 */
export const APP_BUDGET = { burst: 60, perSecond: 10 } as const;

/** A token bucket for one page; `take` says whether a request may go on now. */
export function requestBudget(now: () => number = () => performance.now()) {
  let tokens: number = APP_BUDGET.burst;
  let last = now();
  return {
    take(): boolean {
      const at = now();
      tokens = Math.min(APP_BUDGET.burst, tokens + ((at - last) / 1000) * APP_BUDGET.perSecond);
      last = at;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}

export class AppRefusal extends Error {
  constructor(readonly error: AppError) {
    super(error.message);
  }
}

const refuse = (code: string, message: string, reason?: string): never => {
  throw new AppRefusal(reason === undefined ? { code, message } : { code, reason, message });
};

/** The ids Kalzit gives out: letters, digits, `-` and `_`. */
const ID = /^[A-Za-z0-9_-]{1,128}$/;
/** A storage key as the server takes it: 1 to 200 letters, digits, `.`, `_`, `-`, `:` or `/`. */
const KEY = /^[A-Za-z0-9._\-:/]{1,200}$/;

/**
 * An id of the payload as one part of an address. Only the id alphabet passes: `.` and `..`
 * would be resolved away by the browser and lead to another route.
 */
function id(payload: Record<string, unknown>, name: string): string {
  const value = payload[name];
  if (typeof value !== "string" || !ID.test(value)) {
    return refuse("validation", `${name} is not an id`);
  }
  return value;
}

/** A storage key; one that is `.` or `..`, or has such a part, is refused for the same reason. */
function key(payload: Record<string, unknown>): string {
  const value = payload.key;
  if (
    typeof value !== "string" ||
    !KEY.test(value) ||
    value.split("/").some((part) => part === "." || part === "..")
  ) {
    return refuse("validation", "key is not a storage key", "plugin.app_storage_key");
  }
  return value;
}

function page(payload: Record<string, unknown>): string {
  const search = new URLSearchParams();
  if (typeof payload.limit === "number") search.set("limit", String(Math.round(payload.limit)));
  if (typeof payload.cursor === "string") search.set("cursor", payload.cursor);
  const text = search.toString();
  return text === "" ? "" : `?${text}`;
}

/** Answers one request of an app's page; throws `AppRefusal` with what the page is told. */
export async function answerAppRequest(
  orgId: string,
  app: Pick<AppInfo, "id" | "capabilities">,
  { type, payload }: AppRequest,
): Promise<unknown> {
  // An own entry only: "constructor" and the like are no request types.
  const capability = Object.hasOwn(NEEDS, type) ? NEEDS[type] : undefined;
  if (capability === undefined) {
    return refuse("validation", `unknown request type ${type}`);
  }
  if (!app.capabilities.includes(capability)) {
    return refuse(
      "forbidden",
      `the app's manifest does not name ${capability}`,
      "plugin.app_capability_missing",
    );
  }
  const org = `/api/orgs/${encodeURIComponent(orgId)}`;
  try {
    switch (type) {
      case "dashboards.list":
        return await request("GET", `${org}/dashboards${page(payload)}`);
      case "dashboards.get":
        return await request("GET", `${org}/dashboards/${id(payload, "dashboardId")}`);
      case "analyses.list":
        return await request("GET", `${org}/analyses${page(payload)}`);
      case "analyses.get":
        return await request("GET", `${org}/analyses/${id(payload, "analysisId")}`);
      case "analyses.run": {
        const range = payload.timeRange;
        const now = Date.now();
        const timeRange =
          isRecord(range) && typeof range.from === "number" && typeof range.to === "number"
            ? { from: range.from, to: range.to }
            : { from: now - 3_600_000, to: now };
        return await request("POST", `${org}/analyses/${id(payload, "analysisId")}/query`, {
          timeRange,
        });
      }
      case "storage.list":
        return await appStorage.list(orgId, app.id);
      case "storage.get":
        return await appStorage.get(orgId, app.id, key(payload));
      case "storage.put":
        await appStorage.put(orgId, app.id, key(payload), payload.value);
        return null;
      default:
        await appStorage.delete(orgId, app.id, key(payload));
        return null;
    }
  } catch (error) {
    if (error instanceof AppRefusal) throw error;
    if (isApiError(error)) {
      const reason =
        isRecord(error.body) && isRecord(error.body.error) ? error.body.error.reason : undefined;
      throw new AppRefusal({
        code: error.code,
        message: error.message,
        ...(typeof reason === "string" ? { reason } : {}),
      });
    }
    throw new AppRefusal({ code: "internal", message: "the request failed" });
  }
}
