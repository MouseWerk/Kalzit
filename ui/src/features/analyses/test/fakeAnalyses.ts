import type { QueryOutcome, TimeRange } from "../../../api/generated/shapes";
import {
  error,
  type FakeArea,
  type FakeAreaStates,
  type FakeRequest,
  json,
} from "../../../test/fakeServer";
import { answerQuery } from "../../datasources/test/fakeDatasources";

/**
 * Fake routes of docs/api/analyses.md: list (filters, sort), read, create, save with the version
 * check, trash, restore, purge, uses, versions and running the stored queries. Rights follow the
 * role (`analyses:read`, `analyses:write`); `mayQuery` follows `datasources:query` unless a test
 * sets `noQuery` for an analysis.
 */

export interface StoredAnalysisVersion {
  version: number;
  model: Record<string, unknown>;
  authorId: string;
  authorName: string;
  createdAt: number;
  restoredFrom: number | null;
}

export interface StoredAnalysis {
  id: string;
  folderId: string | null;
  createdBy: string;
  /** The creator's name as the server answers it; `null` once the account is gone. */
  createdByName: string | null;
  createdAt: number;
  deletedAt: number | null;
  teamOnly: boolean;
  versions: StoredAnalysisVersion[];
}

export interface FakeAnalysesState {
  analyses: StoredAnalysis[];
  /** Dashboards linking an analysis, by analysis id (`uses`, and `analysis.in_use`). */
  uses: Record<string, { id: string; title: string; deletedAt: number | null }[]>;
  /** Analyses whose sources the caller may not query (`mayQuery: false`). */
  noQuery: Set<string>;
  /** Every save request body, in order. */
  saves: { id: string | null; body: Record<string, unknown> }[];
  /** Every run of stored queries. */
  runs: { id: string; body: Record<string, unknown> }[];
}

let next = 1;

export function newestOf(analysis: StoredAnalysis): StoredAnalysisVersion {
  const version = analysis.versions.at(-1);
  if (version === undefined) {
    throw new Error("an analysis without versions");
  }
  return version;
}

/** Adds a stored analysis for a test, version 1 unless more models are given. */
export function addAnalysis(
  state: FakeAnalysesState,
  input: {
    id?: string;
    title: string;
    datasourceId: string;
    query: unknown;
    folderId?: string | null;
    type?: string;
    description?: string;
    createdBy?: string;
    createdByName?: string | null;
    updatedAt?: number;
    teamOnly?: boolean;
  },
): StoredAnalysis {
  const id = input.id ?? `an${next++}`;
  const at = input.updatedAt ?? Date.now() - 60_000;
  const model: Record<string, unknown> = {
    schemaVersion: 1,
    title: input.title,
    timeRange: null,
    targets: [{ refId: "A", datasourceId: input.datasourceId, query: input.query }],
    steps: [],
    visualization: { type: input.type ?? "table", options: {}, fieldConfig: {} },
  };
  if (input.description !== undefined) {
    model.description = input.description;
  }
  const analysis: StoredAnalysis = {
    id,
    folderId: input.folderId ?? null,
    createdBy: input.createdBy ?? "u1",
    createdByName: input.createdByName === undefined ? "Ada Lovelace" : input.createdByName,
    createdAt: at,
    deletedAt: null,
    teamOnly: input.teamOnly ?? false,
    versions: [
      {
        version: 1,
        model,
        authorId: input.createdBy ?? "u1",
        authorName: "Ada Lovelace",
        createdAt: at,
        restoredFrom: null,
      },
    ],
  };
  state.analyses.push(analysis);
  return analysis;
}

/** Saves a newer version as someone else would. */
export function saveElsewhere(
  analysis: StoredAnalysis,
  change: (model: Record<string, unknown>) => Record<string, unknown>,
  authorName = "Grace Hopper",
): void {
  const last = newestOf(analysis);
  analysis.versions.push({
    version: last.version + 1,
    model: change(structuredClone(last.model)),
    authorId: "u2",
    authorName,
    createdAt: Date.now(),
    restoredFrom: null,
  });
}

const MODEL_FIELDS = [
  "schemaVersion",
  "title",
  "description",
  "timeRange",
  "targets",
  "steps",
  "visualization",
];

function modelProblem(model: unknown): string | null {
  if (typeof model !== "object" || model === null || Array.isArray(model)) {
    return "model";
  }
  const m = model as Record<string, unknown>;
  const extra = Object.keys(m).find((key) => !MODEL_FIELDS.includes(key));
  if (extra !== undefined) return `model.${extra}`;
  if (typeof m.title !== "string" || m.title.length < 1 || m.title.length > 200) {
    return "model.title";
  }
  if (!Array.isArray(m.targets) || m.targets.length < 1) return "model.targets";
  if (typeof m.description === "string" && m.description.trim() === "") return "model.description";
  return null;
}

export function analysesFake(areas: FakeAreaStates): FakeArea<FakeAnalysesState> {
  const state: FakeAnalysesState = {
    analyses: [],
    uses: {},
    noQuery: new Set(),
    saves: [],
    runs: [],
  };

  function answer(analysis: StoredAnalysis, permissions: ReadonlySet<string>, withModel = true) {
    const last = newestOf(analysis);
    const model = last.model;
    const targets = (model.targets ?? []) as { datasourceId: string }[];
    const body: Record<string, unknown> = {
      id: analysis.id,
      folderId: analysis.folderId,
      title: model.title,
      version: last.version,
      createdBy: analysis.createdBy,
      createdByName: analysis.createdByName,
      createdAt: analysis.createdAt,
      updatedAt: last.createdAt,
      updatedBy: last.authorId,
      updatedByName: last.authorName,
      deletedAt: analysis.deletedAt,
      access: {
        write: permissions.has("analyses:write"),
        delete: permissions.has("analyses:write"),
        permissions: permissions.has("dashboards:share"),
      },
      ownerTeam: null,
      teamOnly: analysis.teamOnly,
      datasourceIds: [...new Set(targets.map((t) => t.datasourceId))],
      mayQuery: permissions.has("datasources:query") && !state.noQuery.has(analysis.id),
      uses: (state.uses[analysis.id] ?? []).length,
    };
    if (withModel) {
      body.model = model;
    }
    return body;
  }

  async function handle({ method, route, search, body, permissions }: FakeRequest) {
    const parts = route.split("/").slice(4);
    if (parts[0] !== "analyses") {
      return undefined;
    }
    const can = (permission: string) => permissions.has(permission);
    if (!can("analyses:read")) {
      return error(403, "forbidden");
    }
    if (parts.length === 1 && method === "GET") {
      const q = search.get("q")?.toLowerCase() ?? "";
      const trashed = search.get("trashed") === "true";
      const folderId = search.get("folderId");
      const source = search.get("datasourceId");
      const createdBy = search.get("createdBy");
      const limit = Number(search.get("limit") ?? 50);
      const items = state.analyses
        .filter((a) => (a.deletedAt !== null) === trashed)
        .filter((a) => folderId === null || a.folderId === folderId)
        .filter((a) => createdBy === null || a.createdBy === createdBy)
        .filter((a) => String(newestOf(a).model.title).toLowerCase().includes(q))
        .filter(
          (a) =>
            source === null ||
            ((newestOf(a).model.targets ?? []) as { datasourceId: string }[]).some(
              (t) => t.datasourceId === source,
            ),
        )
        .sort((a, b) =>
          search.get("sort") === "updated"
            ? newestOf(b).createdAt - newestOf(a).createdAt
            : String(newestOf(a).model.title).localeCompare(String(newestOf(b).model.title)),
        )
        .slice(0, limit)
        .map((a) => answer(a, permissions, false));
      return json(200, { items, nextCursor: null });
    }
    if (parts.length === 1 && method === "POST") {
      if (!can("analyses:write")) return error(403, "forbidden");
      const problem = modelProblem(body.model);
      if (problem !== null) return error(422, "validation", problem);
      state.saves.push({ id: null, body });
      const model = body.model as Record<string, unknown>;
      const created = addAnalysis(state, {
        title: String(model.title),
        datasourceId: "",
        query: null,
        folderId: (body.folderId as string | null | undefined) ?? null,
        updatedAt: Date.now(),
      });
      const first = newestOf(created);
      first.model = model;
      return json(201, answer(created, permissions));
    }
    const analysis = state.analyses.find((a) => a.id === decodeURIComponent(parts[1] ?? ""));
    if (analysis === undefined) {
      return error(404, "not_found");
    }
    if (parts.length === 2 && method === "GET") {
      return json(200, answer(analysis, permissions));
    }
    if (parts.length === 2 && method === "PUT") {
      if (!can("analyses:write")) return error(403, "forbidden");
      if (analysis.deletedAt !== null) return error(409, "conflict");
      const problem = modelProblem(body.model);
      if (problem !== null) return error(422, "validation", problem);
      state.saves.push({ id: analysis.id, body });
      const last = newestOf(analysis);
      if (body.version !== last.version) {
        return json(409, {
          error: { code: "version_conflict", message: "a newer version exists" },
          current: answer(analysis, permissions),
        });
      }
      if (body.folderId !== undefined) {
        analysis.folderId = body.folderId as string | null;
      }
      analysis.versions.push({
        version: last.version + 1,
        model: body.model as Record<string, unknown>,
        authorId: "u1",
        authorName: "Ada Lovelace",
        createdAt: Date.now(),
        restoredFrom: null,
      });
      return json(200, answer(analysis, permissions));
    }
    if (parts.length === 2 && method === "DELETE") {
      if (!can("analyses:write")) return error(403, "forbidden");
      if ((state.uses[analysis.id] ?? []).length > 0) return error(409, "conflict");
      analysis.deletedAt = Date.now();
      return new Response(null, { status: 204 });
    }
    if (parts[2] === "restore" && method === "POST") {
      analysis.deletedAt = null;
      return json(200, answer(analysis, permissions));
    }
    if (parts[2] === "purge" && method === "DELETE") {
      state.analyses = state.analyses.filter((a) => a !== analysis);
      return new Response(null, { status: 204 });
    }
    if (parts[2] === "uses" && method === "GET") {
      return json(200, { items: state.uses[analysis.id] ?? [] });
    }
    if (parts[2] === "versions" && parts.length === 3 && method === "GET") {
      const items = [...analysis.versions]
        .reverse()
        .slice(0, Number(search.get("limit") ?? 50))
        .map(({ version, authorId, authorName, createdAt, restoredFrom }) => ({
          version,
          authorId,
          authorName,
          createdAt,
          restoredFrom,
        }));
      return json(200, { items, nextCursor: null });
    }
    if (parts[2] === "versions" && parts.length === 4 && method === "GET") {
      const version = analysis.versions.find((v) => v.version === Number(parts[3]));
      return version === undefined ? error(404, "not_found") : json(200, version);
    }
    if (parts[2] === "query" && method === "POST") {
      if (analysis.deletedAt !== null) return error(404, "not_found");
      state.runs.push({ id: analysis.id, body });
      const results: Record<string, QueryOutcome> = {};
      const targets = (newestOf(analysis).model.targets ?? []) as {
        refId: string;
        datasourceId: string;
        query: unknown;
      }[];
      for (const target of targets) {
        results[target.refId] = await answerQuery(
          areas.datasources,
          target,
          body.timeRange as TimeRange,
        );
      }
      return json(200, { results });
    }
    return undefined;
  }

  return { state, handle };
}
