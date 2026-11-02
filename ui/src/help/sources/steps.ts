import type { Agg, Step } from "../../analysis/steps";
import { type SqlDialect, sqlName } from "./guides";

/**
 * "Show the query" for steps: the SQL that does in the database what a leading group step does
 * in the browser, so people who built a result without code see the language behind it and can
 * take it over. Only what SQL says the same way is written (a group with count, sum, mean, min or
 * max); for any other step there is nothing to show.
 */

const SQL_AGGS: Partial<Record<Agg, string>> = {
  count: "COUNT",
  sum: "SUM",
  mean: "AVG",
  min: "MIN",
  max: "MAX",
};

/** The query with the first step folded in, or null when it cannot be written in SQL. */
export function groupStepAsSql(
  steps: readonly Step[],
  base: string,
  dialect: SqlDialect,
): { sql: string; stepId: string } | null {
  const step = steps.find((s) => s.disabled !== true);
  const inner = base.trim().replace(/;\s*$/, "");
  if (step === undefined || step.type !== "group" || inner === "" || step.by.length === 0) {
    return null;
  }
  const q = (name: string) => sqlName(dialect, name);
  const aggs: string[] = [];
  for (const a of step.aggregations) {
    const fn = SQL_AGGS[a.op];
    if (fn === undefined) {
      return null;
    }
    const name = a.name ?? `${a.op}(${a.field})`;
    aggs.push(`${fn}(${a.op === "count" ? "*" : q(a.field)}) AS ${q(name)}`);
  }
  const by = step.by.map(q).join(", ");
  const columns = [by, ...aggs].join(", ");
  const from = `(\n${inner
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")}\n) AS q`;
  const sql =
    dialect === "mssql"
      ? `SELECT TOP 1000 ${columns}\nFROM ${from}\nGROUP BY ${by}\nORDER BY ${by}`
      : `SELECT ${columns}\nFROM ${from}\nGROUP BY ${by}\nORDER BY ${by}\nLIMIT 1000`;
  return { sql, stepId: step.id };
}
