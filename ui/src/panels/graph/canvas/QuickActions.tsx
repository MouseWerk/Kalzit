import { type ReactNode, useId, useRef, useState } from "react";
import { summaryNumber, summarySentence } from "../../../analysis/algoText";
import type { StepKind } from "../../../analysis/steps";
import { request } from "../../../api/client";
import { reasonText } from "../../../features/datasources/reasons";
import { useI18n } from "../../../i18n/i18n";
import { readPreference, writePreference } from "../../../lib/storage";
import { shortcutSpoken } from "../../../shortcuts/registry";
import type { Emphasis } from "../drawing";
import type { GraphModel } from "../model";
import type { GraphView, Visibility } from "../view";
import {
  type ActionAnswer,
  type ActionStep,
  connectSteps,
  edgeWeights,
  emphasisOf,
  loadedGraph,
  MAX_CONNECT_NODES,
  type PathKind,
  pathStep,
  type Ranked,
  ranking,
  type TopMeasure,
  topStep,
  unconnected,
} from "./quickSteps";

/** The person's choice "Richtung der Kanten beachten", remembered in this browser (decision 11). */
const DIRECTED_KEY = "kalzit.graph.pathDirected";

export type QuickState =
  | {
      kind: "path";
      pathKind: PathKind;
      from: string;
      to: string;
      directed: boolean;
      weight?: string | undefined;
      answer: ActionAnswer | null;
      current: number;
    }
  | { kind: "connect"; ids: string[]; answers: ActionAnswer[] | null }
  | { kind: "top"; measure: TopMeasure; answer: ActionAnswer | null };

export interface QuickActions {
  state: QuickState | null;
  pending: boolean;
  /** A request that failed as a whole (network, rights), in plain words. */
  failure: string | null;
  emphasis: Emphasis | null;
  weights: string[];
  directed: boolean;
  path: (kind: PathKind, from: string, to: string, weight?: string) => void;
  connect: (ids: readonly string[]) => void;
  top: (measure: TopMeasure) => void;
  setDirected: (directed: boolean) => void;
  /** Moves to the next or previous path of the list. */
  step: (by: 1 | -1) => void;
  choose: (index: number) => void;
  close: () => void;
}

/**
 * The state of the quick actions of one canvas: what runs, what came back, and what the drawing
 * holds up. Without an organization (a public link or snapshot) there are none.
 */
export function useQuickActions({
  orgId,
  model,
  view,
  visibility,
  announce,
}: {
  orgId: string | undefined;
  model: GraphModel;
  view: GraphView;
  visibility: Visibility;
  announce: (text: string) => void;
}): QuickActions | null {
  const { t, language } = useI18n();
  const [state, setState] = useState<QuickState | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [directed, setDirectedState] = useState(() => readPreference(DIRECTED_KEY) === "true");
  const run = useRef(0);
  if (orgId === undefined) return null;

  const caption = (id: string) => {
    const at = model.index.get(id);
    return at === undefined ? id : (model.nodes[at]?.caption ?? id);
  };

  async function ask(steps: ActionStep[]): Promise<ActionAnswer[] | null> {
    const mine = ++run.current;
    setPending(true);
    setFailure(null);
    try {
      const answer = (await request("POST", `/orgs/${orgId}/graph/actions`, {
        graph: loadedGraph(model, view, visibility),
        steps,
      })) as { results: ActionAnswer[] };
      return mine === run.current ? answer.results : null;
    } catch {
      if (mine === run.current) {
        setFailure(t("graphCanvas.quick.failed"));
        announce(t("graphCanvas.quick.failed"));
      }
      return null;
    } finally {
      if (mine === run.current) setPending(false);
    }
  }

  const errorOf = (a: ActionAnswer | undefined) =>
    a?.error === undefined
      ? null
      : (reasonText(t, {
          reason: a.error.reason ?? a.error.code,
          params: a.error.params as Record<string, string> | undefined,
          fallback: a.error.message,
        }) ?? a.error.message);

  function path(kind: PathKind, from: string, to: string, weight?: string) {
    const base = { kind: "path" as const, pathKind: kind, from, to, directed, weight, current: 0 };
    setState({ ...base, answer: null });
    void ask([pathStep(kind, from, to, directed, weight)]).then((results) => {
      const answer = results?.[0];
      if (answer === undefined) return;
      setState({ ...base, answer });
      const error = errorOf(answer);
      announce(
        error ??
          (answer.paths?.length === 0
            ? t(directed ? "graphCanvas.quick.noPathDirected" : "graphCanvas.quick.noPath", {
                from: caption(from),
                to: caption(to),
              })
            : (summarySentence(t, language, answer.summary) ?? "")),
      );
    });
  }

  function connect(ids: readonly string[]) {
    const chosen = ids.slice(0, MAX_CONNECT_NODES);
    setState({ kind: "connect", ids: chosen, answers: null });
    void ask(connectSteps(chosen)).then((results) => {
      if (results === null) return;
      setState({ kind: "connect", ids: chosen, answers: results });
      const apart = unconnected(chosen, results);
      announce(
        apart.length === 0
          ? t("graphCanvas.quick.connected", { count: String(chosen.length) })
          : t("graphCanvas.quick.apart", { names: apart.map(caption).join(", ") }),
      );
    });
  }

  function top(measure: TopMeasure) {
    setState({ kind: "top", measure, answer: null });
    void ask([topStep(measure)]).then((results) => {
      const answer = results?.[0];
      if (answer === undefined) return;
      setState({ kind: "top", measure, answer });
      const ranked = ranking(answer.values ?? {});
      announce(
        errorOf(answer) ??
          t("graphCanvas.quick.topSentence", {
            count: String(ranked.length),
            measure: t(`graphCanvas.quick.measure.${measure}`),
            names: ranked.map((r) => caption(r.id)).join(", "),
          }),
      );
    });
  }

  let emphasis: Emphasis | null = null;
  if (state?.kind === "path" && state.answer !== null && state.answer.error === undefined) {
    const paths = state.answer.paths ?? [];
    const chosen = paths[state.current];
    emphasis = emphasisOf(model, view, {
      nodes: [state.from, state.to],
      paths,
      strong: chosen === undefined ? [] : [chosen],
    });
  } else if (state?.kind === "connect" && state.answers !== null) {
    const paths = state.answers.flatMap((a) => a.paths ?? []);
    emphasis = emphasisOf(model, view, { nodes: state.ids, paths, strong: paths });
  } else if (state?.kind === "top" && state.answer !== null && state.answer.error === undefined) {
    emphasis = emphasisOf(model, view, {
      nodes: ranking(state.answer.values ?? {}).map((r) => r.id),
      paths: [],
      strong: [],
    });
  }

  const count = state?.kind === "path" ? (state.answer?.paths?.length ?? 0) : 0;
  return {
    state,
    pending,
    failure,
    emphasis,
    weights: edgeWeights(model),
    directed,
    path,
    connect,
    top,
    setDirected: (next) => {
      setDirectedState(next);
      writePreference(DIRECTED_KEY, String(next));
      if (state?.kind === "path") {
        const { pathKind, from, to, weight } = state;
        // The same question again, with the new choice.
        setTimeout(() => {
          const base = {
            kind: "path" as const,
            pathKind,
            from,
            to,
            directed: next,
            weight,
            current: 0,
          };
          setState({ ...base, answer: null });
          void ask([pathStep(pathKind, from, to, next, weight)]).then((results) => {
            const answer = results?.[0];
            if (answer !== undefined) setState({ ...base, answer });
          });
        });
      }
    },
    step: (by) => {
      if (state?.kind !== "path" || count === 0) return;
      const current = (state.current + by + count) % count;
      setState({ ...state, current });
      announce(t("graphCanvas.quick.pathOf", { n: String(current + 1), count: String(count) }));
    },
    choose: (index) => {
      if (state?.kind === "path") setState({ ...state, current: index });
    },
    close: () => {
      run.current++;
      setPending(false);
      setFailure(null);
      setState(null);
    },
  };
}

/** The buttons that start a quick action, by what is chosen (board Graph082, frame 8). */
export function QuickBar({
  quick,
  chosen,
}: {
  quick: QuickActions;
  /** The model ids of the chosen nodes, in the order they were chosen. */
  chosen: readonly string[];
}) {
  const { t } = useI18n();
  const [menu, setMenu] = useState(false);
  const menuId = useId();
  const two = chosen.length === 2;
  const many = chosen.length >= 3;
  const weight = quick.weights[0];
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of controls, not a field set
    <div className="graph-quick" role="group" aria-label={t("graphCanvas.quick.bar")}>
      {two ? (
        <div className="graph-quick__menu">
          <button
            type="button"
            className="button button--ghost button--small"
            aria-expanded={menu}
            aria-controls={menuId}
            onClick={() => setMenu(!menu)}
          >
            {t("graphCanvas.quick.findPath")}
          </button>
          {menu ? (
            <div className="graph-quick__choices" id={menuId}>
              {(["shortest", "allShortest", "weighted"] as const).map((kind) => {
                const blocked = kind === "weighted" && weight === undefined;
                return (
                  <button
                    key={kind}
                    type="button"
                    className="button button--ghost button--small"
                    aria-disabled={blocked ? true : undefined}
                    title={blocked ? t("graphCanvas.quick.noWeight") : undefined}
                    onClick={() => {
                      if (blocked) return;
                      setMenu(false);
                      quick.path(kind, chosen[0] as string, chosen[1] as string, weight);
                    }}
                  >
                    {t(`graphCanvas.quick.path.${kind}`)}
                    {blocked ? (
                      <span className="graph-quick__why">{t("graphCanvas.quick.noWeight")}</span>
                    ) : null}
                  </button>
                );
              })}
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={quick.directed}
                  onChange={(event) => quick.setDirected(event.currentTarget.checked)}
                />
                <span>{t("graphCanvas.quick.directed")}</span>
              </label>
            </div>
          ) : null}
        </div>
      ) : null}
      {many ? (
        <button
          type="button"
          className="button button--ghost button--small"
          aria-disabled={chosen.length > MAX_CONNECT_NODES ? true : undefined}
          title={
            chosen.length > MAX_CONNECT_NODES
              ? t("graphCanvas.quick.tooMany", { max: String(MAX_CONNECT_NODES) })
              : undefined
          }
          onClick={() => {
            if (chosen.length <= MAX_CONNECT_NODES) quick.connect(chosen);
          }}
        >
          {t("graphCanvas.quick.connect")}
        </button>
      ) : null}
      <button
        type="button"
        className="button button--ghost button--small"
        aria-pressed={quick.state?.kind === "top"}
        onClick={() => (quick.state?.kind === "top" ? quick.close() : quick.top("pageRank"))}
      >
        {t("graphCanvas.quick.top")}
      </button>
    </div>
  );
}

/** The answer of a quick action: its sentence, the list, and what can be done with it. */
export function QuickSheet({
  quick,
  model,
  onSelect,
  onSize,
  onAdopt,
}: {
  quick: QuickActions;
  model: GraphModel;
  /** Chooses these nodes (model ids) on the canvas. */
  onSelect: (ids: readonly string[]) => void;
  /** Adds a size rule by the ranking's measure; absent where the panel cannot be edited. */
  onSize?: ((measure: TopMeasure) => void) | undefined;
  /** Takes the action over as a step of the panel; absent without the right to edit it. */
  onAdopt?: ((step: StepKind) => void) | undefined;
}) {
  const { t, language } = useI18n();
  const titleId = useId();
  const state = quick.state;
  if (state === null) return null;
  const caption = (id: string) => {
    const at = model.index.get(id);
    return at === undefined ? id : (model.nodes[at]?.caption ?? id);
  };
  const errorText = (a: ActionAnswer | null | undefined) =>
    a?.error === undefined
      ? null
      : (reasonText(t, {
          reason: a.error.reason ?? a.error.code,
          params: a.error.params as Record<string, string> | undefined,
          fallback: a.error.message,
        }) ?? a.error.message);

  let title = "";
  let body: ReactNode = null;
  let adopt: StepKind | null = null;
  if (state.kind === "path") {
    title = t(`graphCanvas.quick.path.${state.pathKind}`);
    const paths = state.answer?.paths ?? [];
    const error = errorText(state.answer);
    adopt = {
      ...(pathStep(state.pathKind, state.from, state.to, state.directed, state.weight) as object),
      keepAll: true,
    } as unknown as StepKind;
    body =
      state.answer === null ? null : error !== null ? (
        <p className="steps__error">{error}</p>
      ) : paths.length === 0 ? (
        <>
          <p>
            {t(state.directed ? "graphCanvas.quick.noPathDirected" : "graphCanvas.quick.noPath", {
              from: caption(state.from),
              to: caption(state.to),
            })}
          </p>
          {state.directed ? (
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={() => quick.setDirected(false)}
            >
              {t("graphCanvas.quick.undirected")}
            </button>
          ) : null}
        </>
      ) : (
        <>
          <p className="graph-quick__sentence">
            {summarySentence(t, language, state.answer.summary)}
            {state.pathKind === "shortest" ? ` ${t("graphCanvas.quick.oneOfShortest")}` : ""}
          </p>
          <ol className="graph-quick__list">
            {paths.map((p, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: paths are listed in the server's order
              <li key={i}>
                <button
                  type="button"
                  className="graph-quick__item"
                  aria-pressed={i === state.current}
                  onClick={() => quick.choose(i)}
                >
                  {t("graphCanvas.quick.pathItem", {
                    n: String(i + 1),
                    nodes: p.nodes.map(caption).join(" › "),
                    edges: String(p.edges.length),
                  })}
                </button>
              </li>
            ))}
          </ol>
          {paths.length > 1 ? (
            <p className="field__hint">
              {t("graphCanvas.quick.walkHint", {
                next: shortcutSpoken("graph.nextPath", language),
                previous: shortcutSpoken("graph.previousPath", language),
              })}
            </p>
          ) : null}
        </>
      );
  } else if (state.kind === "connect") {
    title = t("graphCanvas.quick.connect");
    const answers = state.answers;
    const apart = answers === null ? [] : unconnected(state.ids, answers);
    body =
      answers === null ? null : (
        <>
          <p className="graph-quick__sentence">
            {apart.length === 0
              ? t("graphCanvas.quick.connected", { count: String(state.ids.length) })
              : t("graphCanvas.quick.apart", { names: apart.map(caption).join(", ") })}
          </p>
          <p className="field__hint">{t("graphCanvas.quick.connectHint")}</p>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() =>
              onSelect([
                ...new Set(answers.flatMap((a) => (a.paths ?? []).flatMap((p) => p.nodes))),
              ])
            }
          >
            {t("graphCanvas.quick.selectAll")}
          </button>
        </>
      );
  } else {
    title = t("graphCanvas.quick.top");
    const error = errorText(state.answer);
    const ranked: Ranked[] = ranking(state.answer?.values ?? {});
    adopt = topStep(state.measure) as unknown as StepKind;
    body = (
      <>
        <div
          className="graph-quick__measures"
          role="radiogroup"
          aria-label={t("graphCanvas.quick.measure")}
        >
          {(["pageRank", "degree", "betweenness"] as const).map((m) => (
            // biome-ignore lint/a11y/useSemanticElements: a segmented choice of buttons
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={state.measure === m}
              className="button button--ghost button--small"
              onClick={() => quick.top(m)}
            >
              {t(`graphCanvas.quick.measure.${m}`)}
            </button>
          ))}
        </div>
        {state.answer === null ? null : error !== null ? (
          <p className="steps__error">{error}</p>
        ) : (
          <>
            <p className="graph-quick__sentence">
              {t(ranked.length > 5 ? "graphCanvas.quick.topTies" : "graphCanvas.quick.topLead", {
                count: String(ranked.length),
                measure: t(`graphCanvas.quick.measure.${state.measure}`),
              })}
            </p>
            <ol className="graph-quick__list">
              {ranked.map((r) => (
                <li key={r.id}>
                  <span className="graph-quick__rank">{r.rank}</span> {caption(r.id)}{" "}
                  <span className="field__hint">{summaryNumber(r.score, language)}</span>
                </li>
              ))}
            </ol>
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => onSelect(ranked.map((r) => r.id))}
            >
              {t("graphCanvas.quick.selectAll")}
            </button>
            {onSize === undefined ? null : (
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => onSize(state.measure)}
              >
                {t("analysis.algo.useSize")}
              </button>
            )}
          </>
        )}
      </>
    );
  }

  return (
    <section
      className="graph__details graph-quick__sheet"
      aria-labelledby={titleId}
      aria-busy={quick.pending}
    >
      <h3 className="graph-quick__title" id={titleId}>
        {title}
      </h3>
      {quick.pending ? <p className="field__hint">{t("analysis.algo.running")}</p> : null}
      {quick.failure === null ? null : <p className="steps__error">{quick.failure}</p>}
      {body}
      <p className="field__hint">{t("graphCanvas.quick.honest")}</p>
      <div className="graph-quick__actions">
        {adopt !== null && onAdopt !== undefined ? (
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={() => onAdopt(adopt as StepKind)}
          >
            {t("graphCanvas.quick.adopt")}
          </button>
        ) : null}
        <button type="button" className="button button--ghost button--small" onClick={quick.close}>
          {t("graphCanvas.quick.close")}
        </button>
      </div>
    </section>
  );
}
