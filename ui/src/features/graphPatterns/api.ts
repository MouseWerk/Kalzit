import { queryOptions } from "@tanstack/react-query";
import { expectShape, isRecord } from "../../api/client";
import type {
  ChoicesAnswer,
  Compiled,
  CountAnswer,
  GraphSourceSchema,
  Parsed,
  Pattern,
  PlanMode,
  QueryPlan,
  TimeRange,
} from "../../api/generated/shapes";
import { orgPath, send } from "../datasources/api";

/*
 * The graph routes of a data source (docs/api/datasources.md: "Graph schema", "Query plans",
 * "Graph patterns") and a search template's choices (docs/api/analyses.md). Each needs
 * `datasources:query` on the source, except the choices, which reading the template allows.
 */

export const GRAPH_PATTERNS_KEY = "graphPatterns";

const isSchema = (v: unknown): v is GraphSourceSchema =>
  isRecord(v) && Array.isArray(v.labels) && Array.isArray(v.edgeTypes) && Array.isArray(v.links);

export async function fetchGraphSchema(
  orgId: string,
  datasourceId: string,
  refresh: boolean,
  signal?: AbortSignal,
): Promise<GraphSourceSchema> {
  const path = orgPath(orgId, "datasources", datasourceId, "graph-schema");
  return expectShape(
    await send("GET", refresh ? `${path}?refresh=true` : path, undefined, signal),
    isSchema,
    "graph schema",
  );
}

/** The schema as a graph; kept a few minutes, as the server keeps it. */
export function graphSchemaQuery(orgId: string, datasourceId: string) {
  return queryOptions({
    queryKey: [GRAPH_PATTERNS_KEY, orgId, "schema", datasourceId],
    queryFn: ({ signal }) => fetchGraphSchema(orgId, datasourceId, false, signal),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

export async function countInSchema(
  orgId: string,
  datasourceId: string,
  what: { label: string } | { edgeType: string },
): Promise<number> {
  const answer = expectShape(
    await send("POST", orgPath(orgId, "datasources", datasourceId, "graph-schema", "count"), what),
    (v): v is CountAnswer => isRecord(v) && typeof v.count === "number",
    "count",
  );
  return answer.count;
}

export async function compilePattern(
  orgId: string,
  datasourceId: string,
  pattern: Pattern,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Compiled> {
  return expectShape(
    await send(
      "POST",
      orgPath(orgId, "datasources", datasourceId, "patterns", "compile"),
      { pattern, variables },
      signal,
    ),
    (v): v is Compiled => isRecord(v) && typeof v.text === "string" && isRecord(v.parameters),
    "compiled pattern",
  );
}

export async function parsePattern(
  orgId: string,
  datasourceId: string,
  text: string,
  parameters: Record<string, unknown>,
): Promise<Parsed> {
  return expectShape(
    await send("POST", orgPath(orgId, "datasources", datasourceId, "patterns", "parse"), {
      text,
      parameters,
    }),
    (v): v is Parsed => isRecord(v) && typeof v.representable === "boolean",
    "parsed pattern",
  );
}

export async function fetchPlan(
  orgId: string,
  datasourceId: string,
  body: {
    query: Record<string, unknown>;
    mode: PlanMode;
    timeRange?: TimeRange;
    variables?: Record<string, unknown>;
  },
  signal?: AbortSignal,
): Promise<QueryPlan> {
  return expectShape(
    await send("POST", orgPath(orgId, "datasources", datasourceId, "plan"), body, signal),
    (v): v is QueryPlan => isRecord(v) && typeof v.available === "boolean",
    "plan",
  );
}

export async function fetchChoices(
  orgId: string,
  analysisId: string,
  parameter: string,
  search: string,
  signal?: AbortSignal,
): Promise<ChoicesAnswer> {
  return expectShape(
    await send(
      "POST",
      orgPath(orgId, "analyses", analysisId, "parameters", parameter, "choices"),
      search === "" ? {} : { search },
      signal,
    ),
    (v): v is ChoicesAnswer => isRecord(v) && Array.isArray(v.values),
    "choices",
  );
}
