import { useMutation } from "@tanstack/react-query";
import { type KeyboardEvent, useId, useState } from "react";
import { isRecord } from "../../api/client";
import type { PlanMode, PlanOperator, QueryPlan } from "../../api/generated/shapes";
import { type MessageKey, useI18n } from "../../i18n/i18n";
import { ConfirmDialog } from "../dashboards/ui/Dialog";
import { errorMessage } from "../dashboards/ui/errors";
import { reasonText } from "../datasources/reasons";
import { fetchPlan } from "./api";
import { dialectOf } from "./pattern";
import "./patterns.css";

/** The steps Kalzit has a sentence for, by the operator's name without the engine's suffix. */
const KNOWN: Record<string, string> = {
  ProduceResults: "produce",
  Produce: "produce",
  Limit: "limit",
  "Expand(All)": "expand",
  "Expand(Into)": "expand",
  Expand: "expand",
  "OptionalExpand(All)": "expand",
  "OptionalExpand(Into)": "expand",
  "VarLengthExpand(All)": "expandPath",
  ExpandVariable: "expandPath",
  Filter: "filter",
  NodeByLabelScan: "labelScan",
  ScanAllByLabel: "labelScan",
  AllNodesScan: "allNodes",
  ScanAll: "allNodes",
  NodeIndexSeek: "indexSeek",
  NodeUniqueIndexSeek: "indexSeek",
  NodeIndexScan: "indexSeek",
  ScanAllByLabelPropertyValue: "indexSeek",
  ScanAllByLabelProperty: "indexSeek",
  Projection: "projection",
  Sort: "sort",
  OrderBy: "sort",
  Top: "sort",
  EagerAggregation: "aggregate",
  Aggregation: "aggregate",
  OrderedAggregation: "aggregate",
  Aggregate: "aggregate",
  Distinct: "distinct",
  Skip: "skip",
  CartesianProduct: "cartesian",
  Cartesian: "cartesian",
  Apply: "apply",
  Optional: "optional",
  Argument: "start",
  Once: "start",
  NodeHashJoin: "join",
  ValueHashJoin: "join",
  DirectedRelationshipTypeScan: "edgeScan",
  UndirectedRelationshipTypeScan: "edgeScan",
  EmptyResult: "empty",
};

const ENGINE: Record<string, string> = { neo4j: "Neo4j", memgraph: "Memgraph" };

interface Row {
  op: PlanOperator;
  depth: number;
  path: string;
  parent: PlanOperator | undefined;
}

/** The tree as rows, the result on top and the first step of the database at the bottom. */
export function planRows(root: PlanOperator): Row[] {
  const out: Row[] = [];
  const walk = (
    op: PlanOperator,
    depth: number,
    path: string,
    parent: PlanOperator | undefined,
  ) => {
    out.push({ op, depth, path, parent });
    op.children.forEach((child, i) => {
      walk(child, depth + 1, `${path}.${i}`, op);
    });
  };
  walk(root, 0, "0", undefined);
  return out;
}

export function knownStep(operator: string): string | undefined {
  return KNOWN[operator.replace(/@\w+$/, "")];
}

/** The hints of decision 18, each with its assumption; Kalzit changes nothing in the database. */
export function planHints(rows: Row[]): ("index" | "cartesian" | "many")[] {
  const hints: ("index" | "cartesian" | "many")[] = [];
  if (
    rows.some(
      (r) =>
        knownStep(r.op.operator) === "labelScan" &&
        r.parent !== undefined &&
        knownStep(r.parent.operator) === "filter",
    )
  ) {
    hints.push("index");
  }
  if (rows.some((r) => knownStep(r.op.operator) === "cartesian")) hints.push("cartesian");
  const out = rows[0]?.op.rows;
  if (
    out !== undefined &&
    rows.some((r) => r.depth > 0 && (r.op.rows ?? 0) > 10_000 && (r.op.rows ?? 0) > out * 10)
  ) {
    hints.push("many");
  }
  return hints;
}

function stepKey(step: string, part: "title" | "text"): MessageKey {
  return `graphPatterns.plan.step.${step}.${part}` as MessageKey;
}

/**
 * The query plan as a readable tree (board Graph083, frames 21 and 22): "Nur planen" asks the
 * database for its plan without running the query, "Mit Messung" runs it once, read-only and
 * within the source's limits, after saying so. Each step has a sentence beside the operator's
 * own name; a few hints in plain language say what may help, with their assumption.
 */
export function PlanView({
  orgId,
  datasource,
  query,
  variables,
  onInspect,
}: {
  orgId: string;
  datasource: { id: string; kind: string };
  query: unknown;
  variables: Record<string, unknown>;
  onInspect?: (() => void) | undefined;
}) {
  const { t, language } = useI18n();
  const id = useId();
  const [confirm, setConfirm] = useState(false);
  const [chosen, setChosen] = useState<string>("0");
  const [asText, setAsText] = useState(false);
  const plan = useMutation({
    mutationFn: (mode: PlanMode) =>
      fetchPlan(orgId, datasource.id, {
        query: isRecord(query) ? query : {},
        mode,
        variables,
      }),
  });
  const [announce, setAnnounce] = useState("");

  if (dialectOf(datasource.kind) === "gsql") {
    return (
      <div className="pattern-plan">
        <div className="pattern-note" role="note">
          <p className="pattern-note__title">{t("graphPatterns.plan.gsqlTitle")}</p>
          <p>{t("graphPatterns.plan.gsqlText")}</p>
          {onInspect === undefined ? null : (
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={onInspect}
            >
              {t("graphPatterns.plan.openInspect")}
            </button>
          )}
        </div>
      </div>
    );
  }

  const ask = (mode: PlanMode) =>
    plan.mutate(mode, {
      onSuccess: (answer) => {
        setChosen("0");
        if (answer.root !== undefined) {
          setAnnounce(t("graphPatterns.plan.loaded", { count: planRows(answer.root).length }));
        }
      },
    });
  const answer: QueryPlan | undefined = plan.data;
  const rows = answer?.root === undefined ? [] : planRows(answer.root);
  const selected = rows.find((r) => r.path === chosen) ?? rows[0];
  const has = (key: keyof PlanOperator) => rows.some((r) => r.op[key] !== undefined);
  const number = (n: number | undefined) => (n === undefined ? "" : n.toLocaleString(language));
  const engine = ENGINE[datasource.kind] ?? datasource.kind;
  const hints = planHints(rows);

  function onRowKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next =
      event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : undefined;
    if (next === undefined || next < 0 || next >= rows.length) return;
    event.preventDefault();
    document.getElementById(`${id}-row-${next}`)?.focus();
  }

  return (
    <div className="pattern-plan">
      <div className="pattern-plan__bar">
        <button
          type="button"
          className="button button--secondary button--small"
          disabled={plan.isPending}
          onClick={() => ask("explain")}
        >
          {t("graphPatterns.plan.explain")}
        </button>
        <button
          type="button"
          className="button button--secondary button--small"
          disabled={plan.isPending}
          onClick={() => setConfirm(true)}
        >
          {t("graphPatterns.plan.profile")}
        </button>
        {rows.length === 0 ? null : (
          <button
            type="button"
            className="button button--ghost button--small"
            aria-pressed={asText}
            onClick={() => setAsText((v) => !v)}
          >
            {t("graphPatterns.plan.asText")}
          </button>
        )}
      </div>
      <p className="visually-hidden" role="status">
        {announce}
      </p>
      {plan.isIdle ? <p className="field__hint">{t("graphPatterns.plan.intro")}</p> : null}
      {plan.isPending ? <p role="status">{t("graphPatterns.plan.loading")}</p> : null}
      {plan.isError ? (
        <div className="pattern-note" role="alert">
          <p>{errorMessage(t, plan.error)}</p>
          {plan.variables === "profile" ? (
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={() => ask("explain")}
            >
              {t("graphPatterns.plan.explain")}
            </button>
          ) : null}
        </div>
      ) : null}
      {answer !== undefined && !answer.available ? (
        <div className="pattern-note" role="note">
          <p>
            {reasonText(t, { reason: answer.reason ?? "plan.empty", fallback: answer.message }) ??
              t("graphPatterns.plan.none")}
          </p>
        </div>
      ) : null}
      {answer?.available === true && answer.mode === "explain" ? (
        <div className="pattern-note" role="note">
          <p>{t("graphPatterns.plan.explained")}</p>
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={() => setConfirm(true)}
          >
            {t("graphPatterns.plan.profileRun")}
          </button>
        </div>
      ) : null}
      {rows.length === 0 ? null : asText ? (
        <pre className="pattern__text">
          {rows
            .map(
              (r) =>
                `${"  ".repeat(r.depth)}${r.depth === 0 ? "" : "└─ "}${r.op.operator}${r.op.details === undefined ? "" : ` ${r.op.details}`}${r.op.rows === undefined ? "" : ` (${r.op.rows})`}`,
            )
            .join("\n")}
        </pre>
      ) : (
        <div className="pattern-plan__body">
          <table className="pattern-table pattern-plan__tree">
            <caption className="visually-hidden">{t("graphPatterns.plan.caption")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("graphPatterns.plan.step")}</th>
                {has("estimatedRows") ? (
                  <th scope="col">{t("graphPatterns.plan.estimated")}</th>
                ) : null}
                {has("rows") ? <th scope="col">{t("graphPatterns.plan.rows")}</th> : null}
                {has("dbHits") ? <th scope="col">{t("graphPatterns.plan.hits")}</th> : null}
                {has("timeShare") ? <th scope="col">{t("graphPatterns.plan.share")}</th> : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, index) => {
                const step = knownStep(r.op.operator);
                return (
                  <tr key={r.path}>
                    <td>
                      <button
                        type="button"
                        id={`${id}-row-${index}`}
                        className="pattern-plan__step"
                        data-depth={Math.min(r.depth, 8)}
                        aria-pressed={selected?.path === r.path}
                        onClick={() => setChosen(r.path)}
                        onKeyDown={(event) => onRowKey(event, index)}
                      >
                        <span aria-hidden="true">{r.depth === 0 ? "" : "└─ "}</span>
                        <span className="pattern-plan__title">
                          {step === undefined ? r.op.operator : t(stepKey(step, "title"))}
                        </span>{" "}
                        <code className="pattern-plan__operator">{r.op.operator}</code>
                      </button>
                    </td>
                    {has("estimatedRows") ? <td>{number(r.op.estimatedRows)}</td> : null}
                    {has("rows") ? <td>{number(r.op.rows)}</td> : null}
                    {has("dbHits") ? <td>{number(r.op.dbHits)}</td> : null}
                    {has("timeShare") ? (
                      <td>
                        {r.op.timeShare === undefined ? "" : `${Math.round(r.op.timeShare)} %`}
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {selected === undefined ? null : (
            <section className="pattern-plan__detail" aria-labelledby={`${id}-detail`}>
              <h3 className="pattern-panel__title" id={`${id}-detail`}>
                {knownStep(selected.op.operator) === undefined
                  ? selected.op.operator
                  : t(stepKey(knownStep(selected.op.operator) ?? "", "title"))}
              </h3>
              <p className="pattern-schema__caption">{t("graphPatterns.plan.what")}</p>
              <p>
                {knownStep(selected.op.operator) === undefined
                  ? t("graphPatterns.plan.unknown")
                  : // A step without details ends after its sentence.
                    t(stepKey(knownStep(selected.op.operator) ?? "", "text"), {
                      details: selected.op.details ?? "",
                    }).replace(/: \.$/, ".")}
              </p>
              <p className="pattern-schema__caption">{t("graphPatterns.plan.measured")}</p>
              <dl className="pattern-schema__properties">
                {selected.op.rows === undefined ? null : (
                  <div>
                    <dt>{t("graphPatterns.plan.rows")}</dt>
                    <dd>
                      {selected.op.estimatedRows === undefined
                        ? number(selected.op.rows)
                        : t("graphPatterns.plan.rowsEstimated", {
                            rows: number(selected.op.rows),
                            estimated: number(selected.op.estimatedRows),
                          })}
                    </dd>
                  </div>
                )}
                {selected.op.dbHits === undefined ? null : (
                  <div>
                    <dt>{t("graphPatterns.plan.hits")}</dt>
                    <dd>{number(selected.op.dbHits)}</dd>
                  </div>
                )}
                <div>
                  <dt>{t("graphPatterns.plan.operator")}</dt>
                  <dd>
                    <code>{selected.op.operator}</code>
                  </dd>
                </div>
                {selected.op.details === undefined ? null : (
                  <div>
                    <dt>{t("graphPatterns.plan.details")}</dt>
                    <dd>
                      <code>{selected.op.details}</code>
                    </dd>
                  </div>
                )}
              </dl>
            </section>
          )}
        </div>
      )}
      {hints.length === 0 ? null : (
        <div className="pattern__warnings">
          {hints.map((hint) => (
            <div key={hint} className="pattern-note" role="note">
              <p className="pattern-note__title">{t("graphPatterns.plan.hint")}</p>
              <p>
                {t(
                  hint === "index"
                    ? "graphPatterns.plan.hint.index"
                    : hint === "cartesian"
                      ? "graphPatterns.plan.hint.cartesian"
                      : "graphPatterns.plan.hint.many",
                )}
              </p>
            </div>
          ))}
        </div>
      )}
      {rows.length === 0 || answer === undefined ? null : (
        <p className="field__hint">
          {t("graphPatterns.plan.footer", { engine, steps: rows.length })}
          {answer.totalDbHits === undefined
            ? ""
            : ` ${t("graphPatterns.plan.footerHits", { hits: number(answer.totalDbHits) })}`}
          {rows[0]?.op.rows === undefined
            ? ""
            : ` ${t("graphPatterns.plan.footerRows", { rows: number(rows[0].op.rows) })}`}
          {datasource.kind === "memgraph" ? ` ${t("graphPatterns.plan.memgraph")}` : ""}
        </p>
      )}
      {confirm ? (
        <ConfirmDialog
          title={t("graphPatterns.plan.confirmTitle")}
          confirmLabel={t("graphPatterns.plan.confirm")}
          onConfirm={() => {
            setConfirm(false);
            ask("profile");
          }}
          onCancel={() => setConfirm(false)}
        >
          {t("graphPatterns.plan.confirmText")}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
