import { expectShape, isRecord, request } from "../../api/client";

/**
 * The configuration routes of AI (docs/api/ai.md): providers of the server and of an
 * organization, usage, and what AI may read of each data source. The status and the first-use
 * notice are in api.ts.
 */

export type AiScope = { kind: "server" } | { kind: "org"; orgId: string };

export const AI_KINDS = ["openai", "anthropic"] as const;
export type AiKind = (typeof AI_KINDS)[number];

export const TOKEN_LIMIT_FIELDS = ["auto", "max_tokens", "max_completion_tokens"] as const;
export type TokenLimitField = (typeof TOKEN_LIMIT_FIELDS)[number];

export interface AiProviderLastTest {
  ok: boolean;
  reason?: string;
  at: number;
}

export interface AiProvider {
  id: string;
  scope: "server" | "org";
  name: string;
  /** `openai` or `anthropic`; a newer server may send another kind, shown as it is. */
  kind: string;
  baseUrl: string;
  model: string;
  isDefault: boolean;
  tokenLimitField: string;
  /** Whether a key is stored; the key itself never leaves the server. */
  apiKeySet: boolean;
  createdAt: number;
  updatedAt: number;
  lastTest?: AiProviderLastTest;
}

export interface AiProviderInput {
  name: string;
  kind: AiKind;
  baseUrl: string;
  model: string;
  apiKey?: string;
  isDefault: boolean;
  tokenLimitField?: TokenLimitField;
}

/** A change: absent fields stay; `apiKey: null` removes the stored key. */
export interface AiProviderPatch {
  name?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string | null;
  isDefault?: boolean;
  tokenLimitField?: TokenLimitField;
  expectedUpdatedAt: number;
}

export interface AiProviderTest {
  ok: boolean;
  latencyMs: number;
  reply?: string;
  reason?: string;
  params?: Record<string, string>;
  message?: string;
}

export interface AiUsageRow {
  day: string;
  orgId?: string;
  userId?: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface AiAccess {
  datasourceId: string;
  readable: boolean;
  excludedFields: string[];
}

/** The most fields one data source may exclude, and the longest one (docs/api/ai.md). */
export const MAX_EXCLUDED_FIELDS = 200;
export const MAX_EXCLUDED_FIELD_CHARS = 256;

const enc = encodeURIComponent;

function providersPath(scope: AiScope): string {
  return scope.kind === "server"
    ? "/api/admin/ai/providers"
    : `/api/orgs/${enc(scope.orgId)}/ai/providers`;
}

function isLastTest(value: unknown): value is AiProviderLastTest {
  return (
    isRecord(value) &&
    typeof value.ok === "boolean" &&
    typeof value.at === "number" &&
    (value.reason === undefined || typeof value.reason === "string")
  );
}

export function isAiProvider(value: unknown): value is AiProvider {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.scope === "server" || value.scope === "org") &&
    typeof value.name === "string" &&
    typeof value.kind === "string" &&
    typeof value.baseUrl === "string" &&
    typeof value.model === "string" &&
    typeof value.isDefault === "boolean" &&
    typeof value.tokenLimitField === "string" &&
    typeof value.apiKeySet === "boolean" &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number" &&
    (value.lastTest === undefined || isLastTest(value.lastTest))
  );
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value).map(([name, param]) => [name, String(param)]));
}

function itemsOf<T>(value: unknown, guard: (item: unknown) => item is T, what: string): T[] {
  const page = expectShape(value, isRecord, what);
  const items = Array.isArray(page.items) ? page.items : [];
  return items.map((item) => expectShape(item, guard, what));
}

export async function listAiProviders(scope: AiScope, signal?: AbortSignal): Promise<AiProvider[]> {
  const answer = await request("GET", providersPath(scope), undefined, { signal });
  return itemsOf(answer, isAiProvider, "AI providers");
}

export async function createAiProvider(
  scope: AiScope,
  input: AiProviderInput,
): Promise<AiProvider> {
  return expectShape(
    await request("POST", providersPath(scope), input),
    isAiProvider,
    "AI provider",
  );
}

export async function updateAiProvider(
  scope: AiScope,
  id: string,
  patch: AiProviderPatch,
): Promise<AiProvider> {
  return expectShape(
    await request("PATCH", `${providersPath(scope)}/${enc(id)}`, patch),
    isAiProvider,
    "AI provider",
  );
}

export async function deleteAiProvider(scope: AiScope, id: string): Promise<void> {
  await request("DELETE", `${providersPath(scope)}/${enc(id)}`);
}

/** Sends the tiny test prompt; answers 200 whether the provider passed or not. */
export async function testAiProvider(scope: AiScope, id: string): Promise<AiProviderTest> {
  const answer = expectShape(
    await request("POST", `${providersPath(scope)}/${enc(id)}/test`, {}),
    (value): value is Record<string, unknown> =>
      isRecord(value) && typeof value.ok === "boolean" && typeof value.latencyMs === "number",
    "AI provider test",
  );
  const result: AiProviderTest = { ok: answer.ok === true, latencyMs: Number(answer.latencyMs) };
  if (typeof answer.reply === "string") result.reply = answer.reply;
  if (typeof answer.reason === "string") result.reason = answer.reason;
  if (typeof answer.message === "string") result.message = answer.message;
  const params = stringRecord(answer.params);
  if (params !== undefined) result.params = params;
  return result;
}

function isUsageRow(value: unknown): value is AiUsageRow {
  return (
    isRecord(value) &&
    typeof value.day === "string" &&
    typeof value.requests === "number" &&
    typeof value.inputTokens === "number" &&
    typeof value.outputTokens === "number" &&
    (value.orgId === undefined || typeof value.orgId === "string") &&
    (value.userId === undefined || typeof value.userId === "string")
  );
}

/** Calls and tokens of the last `days` days (today included), newest day first. */
export async function fetchAiUsage(
  scope: AiScope,
  days: number,
  signal?: AbortSignal,
): Promise<AiUsageRow[]> {
  const path =
    scope.kind === "server"
      ? `/api/admin/ai/usage?days=${days}`
      : `/api/orgs/${enc(scope.orgId)}/ai/usage?days=${days}`;
  return itemsOf(await request("GET", path, undefined, { signal }), isUsageRow, "AI usage");
}

function isAiAccess(value: unknown): value is AiAccess {
  return (
    isRecord(value) &&
    typeof value.datasourceId === "string" &&
    typeof value.readable === "boolean" &&
    Array.isArray(value.excludedFields) &&
    value.excludedFields.every((field) => typeof field === "string")
  );
}

function accessPath(orgId: string, datasourceId: string): string {
  return `/api/orgs/${enc(orgId)}/datasources/${enc(datasourceId)}/ai-access`;
}

export async function fetchAiAccess(
  orgId: string,
  datasourceId: string,
  signal?: AbortSignal,
): Promise<AiAccess> {
  return expectShape(
    await request("GET", accessPath(orgId, datasourceId), undefined, { signal }),
    isAiAccess,
    "AI access",
  );
}

export async function saveAiAccess(
  orgId: string,
  datasourceId: string,
  input: { readable: boolean; excludedFields: string[] },
): Promise<AiAccess> {
  return expectShape(
    await request("PUT", accessPath(orgId, datasourceId), input),
    isAiAccess,
    "AI access",
  );
}

/** The ids of the sources open to AI among those the caller may read. */
export async function fetchAiReadableSources(
  orgId: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const items = itemsOf(
    await request("GET", `/api/orgs/${enc(orgId)}/ai/datasources`, undefined, { signal }),
    (item): item is { datasourceId: string } =>
      isRecord(item) && typeof item.datasourceId === "string",
    "AI data sources",
  );
  return items.map((item) => item.datasourceId);
}

/** Query keys; everything of AI's configuration under one prefix. */
export const aiAdminKeys = {
  all: ["aiAdmin"] as const,
  providers: (scope: AiScope) =>
    ["aiAdmin", "providers", scope.kind === "server" ? "server" : scope.orgId] as const,
  usage: (scope: AiScope, days: number) =>
    ["aiAdmin", "usage", scope.kind === "server" ? "server" : scope.orgId, days] as const,
  access: (orgId: string, datasourceId: string) =>
    ["aiAdmin", "access", orgId, datasourceId] as const,
  readable: (orgId: string) => ["aiAdmin", "readable", orgId] as const,
};

/** The host data goes to: the host of the base URL, never the whole URL. */
export function providerHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
