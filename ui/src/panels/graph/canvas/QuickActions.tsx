import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { summaryNumber, summarySentence } from "../../../analysis/algoText";
import { request } from "../../../api/client";
import { errorReason, reasonText } from "../../../features/datasources/reasons";
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
  K_PATHS,
  loadedGraph,
  MAX_CONNECT_NODES,
  MAX_RANK_ROWS,
  type PathKind,
  pathDetails,
  pathStep,
  type Ranked,
  ranking,
  type TopMeasure,
  topStep,
  unconnected,
} from "./quickSteps";
import "../../../features/dashboards/ui/shared.css";
import "../../../analysis/analysis.css";
import "../graph.css";
import "./canvas.css";

/** The person's choice "Richtung der Kanten beachten", remembered in this browser (decision 11). */
const DIRECTED_KEY = "kalzit.graph.pathDirected";
const MEASURES: readonly TopMeasure[] = ["pageRank", "degree", "betweenness"];

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
  /** A request that failed as a whole (network, rights, busy), in plain words. */
  failure: string | null;
  emphasis: Emphasis | null;
  weights: string[];
  directed: boolean;
  path: (kind: PathKind, from: string, to: string, weight?: string) => void;
  /** Runs "Wie hängen diese zusammen?"; more than `MAX_CONNECT_NODES` only says so. */
  connect: (ids: readonly string[]) => void;
  top: (measure: TopMeasure) => void;
  setDirected: (directed: boolean) => void;
  /** The same path question with From and To swapped. */
  swap: () => void;
  /** Moves to the next or previous path of the list. */
  step: (by: 1 | -1) => void;
  choose: (index: number) => void;
  close: () => void;
}

/** A step's error in plain words; null without one. */
function errorText(
  t: ReturnType<typeof useI18n>["t"],
  a: ActionAnswer | null | undefined,
): string | null {
  if (a?.error === undefined) return null;
  return (
    reasonText(t, {
      reason: a.error.reason ?? a.error.code,
      params: a.error.params as Record<string, string> | undefined,
      fallback: a.error.message,
    }) ?? a.error.message
  );
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
    } catch (e) {
      if (mine === run.current) {
        // A busy server or user, or a graph too large, is said as such; anything else as "did
        // not come through".
        const reason = errorReason(e);
        const said =
          reason?.reason?.startsWith("graph_actions.") === true ? reasonText(t, reason) : undefined;
        const text = said ?? t("graphCanvas.quick.failed");
        setFailure(text);
        announce(text);
      }
      return null;
    } finally {
      if (mine === run.current) setPending(false);
    }
  }

  function path(kind: PathKind, from: string, to: string, weight?: string, way = directed) {
    const base = {
      kind: "path" as const,
      pathKind: kind,
      from,
      to,
      directed: way,
      weight,
      current: 0,
    };
    setState({ ...base, answer: null });
    void ask([pathStep(kind, from, to, way, weight)]).then((results) => {
      const answer = results?.[0];
      if (answer === undefined) return;
      setState({ ...base, answer });
      announce(
        errorText(t, answer) ??
          (answer.paths === undefined || answer.paths.length === 0
            ? t(way ? "graphCanvas.quick.noPathDirected" : "graphCanvas.quick.noPath", {
                from: caption(from),
                to: caption(to),
              })
            : (summarySentence(t, language, answer.summary) ?? "")),
      );
    });
  }

  function connect(ids: readonly string[]) {
    if (ids.length > MAX_CONNECT_NODES) {
      announce(t("graphCanvas.quick.tooMany", { max: String(MAX_CONNECT_NODES) }));
      return;
    }
    const chosen = [...ids];
    setState({ kind: "connect", ids: chosen, answers: null });
    void ask(connectSteps(chosen)).then((results) => {
      if (results === null) return;
      setState({ kind: "connect", ids: chosen, answers: results });
      announce(connectSentence(t, chosen, results, caption));
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
        errorText(t, answer) ??
          t("graphCanvas.quick.topSentence", {
            count: String(ranked.length),
            measure: t(`graphCanvas.quick.measure.${measure}`),
            names: ranked
              .slice(0, MAX_RANK_ROWS)
              .map((r) => caption(r.id))
              .join(", "),
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
    path: (kind, from, to, weight) => path(kind, from, to, weight),
    connect,
    top,
    setDirected: (next) => {
      setDirectedState(next);
      writePreference(DIRECTED_KEY, String(next));
      // The same question again, with the new choice.
      if (state?.kind === "path") path(state.pathKind, state.from, state.to, state.weight, next);
    },
    swap: () => {
      if (state?.kind === "path") {
        path(state.pathKind, state.to, state.from, state.weight, state.directed);
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

/**
 * What "Wie hängen diese zusammen?" found, in one sentence: a pair that could not be computed
 * says why (then nothing is claimed about who is not connected), else who is apart, or that all
 * are connected.
 */
function connectSentence(
  t: ReturnType<typeof useI18n>["t"],
  ids: readonly string[],
  answers: readonly ActionAnswer[],
  caption: (id: string) => string,
): string {
  const failed = answers.find((a) => a.error !== undefined);
  if (failed !== undefined) {
    return t("graphCanvas.quick.connectFailed", { reason: errorText(t, failed) ?? "" });
  }
  const apart = unconnected(ids, answers);
  return apart.length === 0
    ? t("graphCanvas.quick.connected", { count: String(ids.length) })
    : t("graphCanvas.quick.apart", { names: apart.map(caption).join(", ") });
}

/** The menu "Pfad finden": its kinds, a weight per number on the edges, the direction. */
function PathMenu({
  quick,
  chosen,
  caption,
  onClose,
}: {
  quick: QuickActions;
  chosen: readonly string[];
  caption: (id: string) => string;
  onClose: (refocus: boolean) => void;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const [swapped, setSwapped] = useState(false);
  const from = (swapped ? chosen[1] : chosen[0]) as string;
  const to = (swapped ? chosen[0] : chosen[1]) as string;
  // Focus moves into the menu; Escape or a press outside closes it.
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    const outside = (event: PointerEvent) => {
      const menu = ref.current;
      const opener = menu?.parentElement;
      if (opener !== null && opener !== undefined && !opener.contains(event.target as Node)) {
        onClose(false);
      }
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [onClose]);
  const run = (kind: PathKind, weight?: string) => {
    onClose(false);
    quick.path(kind, from, to, weight);
  };
  const item = (key: string, label: string, onSelect: () => void, why?: string) => (
    <button
      key={key}
      type="button"
      className="button button--ghost button--small"
      aria-disabled={why === undefined ? undefined : true}
      onClick={() => {
        if (why === undefined) onSelect();
      }}
    >
      {label}
      {why === undefined ? null : <span className="graph-quick__why">{why}</span>}
    </button>
  );
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape closes the menu from any of its controls
    <div
      className="graph-quick__choices"
      ref={ref}
      onKeyDown={(event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose(true);
        }
      }}
    >
      <p className="field__hint">
        {t("graphCanvas.quick.fromTo", { from: caption(from), to: caption(to) })}
      </p>
      {item("shortest", t("graphCanvas.quick.path.shortest"), () => run("shortest"))}
      {item("allShortest", t("graphCanvas.quick.path.allShortest"), () => run("allShortest"))}
      {quick.weights.length === 0
        ? item(
            "weighted",
            t("graphCanvas.quick.path.weighted"),
            () => undefined,
            t("graphCanvas.quick.noWeight"),
          )
        : quick.weights.map((w) =>
            item(`weighted-${w}`, t("graphCanvas.quick.path.weightedBy", { property: w }), () =>
              run("weighted", w),
            ),
          )}
      {item("kShortest", t("graphCanvas.quick.path.kShortestN", { k: String(K_PATHS) }), () =>
        run("kShortest", quick.weights[0]),
      )}
      {item("swap", t("graphCanvas.quick.swap"), () => setSwapped(!swapped))}
      <label className="checkbox">
        <input
          type="checkbox"
          checked={quick.directed}
          onChange={(event) => quick.setDirected(event.currentTarget.checked)}
        />
        <span>{t("graphCanvas.quick.directed")}</span>
      </label>
    </div>
  );
}

/** The buttons that start a quick action, by what is chosen (board Graph082, frame 8). */
export function QuickBar({
  quick,
  chosen,
  caption,
}: {
  quick: QuickActions;
  /** The model ids of the chosen nodes, in the order they were chosen. */
  chosen: readonly string[];
  /** A node's caption by its id. */
  caption: (id: string) => string;
}) {
  const { t } = useI18n();
  const [menu, setMenu] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const two = chosen.length === 2;
  const many = chosen.length >= 3;
  const tooMany = chosen.length > MAX_CONNECT_NODES;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of controls, not a field set
    <div className="graph-quick" role="group" aria-label={t("graphCanvas.quick.bar")}>
      {two ? (
        <div className="graph-quick__menu" id={menuId}>
          <button
            type="button"
            ref={opener}
            className="button button--ghost button--small"
            aria-expanded={menu}
            onClick={() => setMenu(!menu)}
          >
            {t("graphCanvas.quick.findPath")}
          </button>
          {menu ? (
            <PathMenu
              quick={quick}
              chosen={chosen}
              caption={caption}
              onClose={(refocus) => {
                setMenu(false);
                if (refocus) opener.current?.focus();
              }}
            />
          ) : null}
        </div>
      ) : null}
      {many ? (
        <button
          type="button"
          className="button button--ghost button--small"
          aria-disabled={tooMany ? true : undefined}
          aria-describedby={tooMany ? `${menuId}-many` : undefined}
          onClick={() => quick.connect(chosen)}
        >
          {t("graphCanvas.quick.connect")}
        </button>
      ) : null}
      {many && tooMany ? (
        <span className="graph-quick__why" id={`${menuId}-many`}>
          {t("graphCanvas.quick.tooMany", { max: String(MAX_CONNECT_NODES) })}
        </span>
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

/** The measures of "Wichtigste Knoten": one tab stop, arrow keys move the choice. */
function Measures({ quick, measure }: { quick: QuickActions; measure: TopMeasure }) {
  const { t } = useI18n();
  const group = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
    const by =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : 0;
    if (by === 0) return;
    event.preventDefault();
    const at = (MEASURES.indexOf(measure) + by + MEASURES.length) % MEASURES.length;
    quick.top(MEASURES[at] as TopMeasure);
    requestAnimationFrame(() =>
      group.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[at]?.focus(),
    );
  };
  return (
    <div
      className="graph-quick__measures"
      role="radiogroup"
      aria-label={t("graphCanvas.quick.measure")}
      ref={group}
    >
      {MEASURES.map((m) => (
        // biome-ignore lint/a11y/useSemanticElements: a segmented choice of buttons
        <button
          key={m}
          type="button"
          role="radio"
          aria-checked={measure === m}
          tabIndex={measure === m ? 0 : -1}
          className="button button--ghost button--small"
          onClick={() => quick.top(m)}
          onKeyDown={move}
        >
          {t(`graphCanvas.quick.measure.${m}`)}
        </button>
      ))}
    </div>
  );
}

/** The answer of a quick action: its sentence, the list, and what can be done with it. */
export function QuickSheet({
  quick,
  model,
  onSelect,
  onOnly,
  onSize,
  onAdopt,
}: {
  quick: QuickActions;
  model: GraphModel;
  /** Chooses these nodes (model ids) on the canvas. */
  onSelect: (ids: readonly string[]) => void;
  /** Shows only these nodes (model ids) and the edges between them. */
  onOnly: (ids: readonly string[]) => void;
  /** Takes "Wichtigste Knoten" over as a step and shows its value as the size; editors only. */
  onSize?: ((measure: TopMeasure) => void) | undefined;
  /** Takes the action over as steps of the panel; absent without the right to edit it. */
  onAdopt?: ((steps: readonly ActionStep[]) => void) | undefined;
}) {
  const { t, language } = useI18n();
  const titleId = useId();
  const state = quick.state;
  if (state === null) return null;
  const caption = (id: string) => {
    const at = model.index.get(id);
    return at === undefined ? id : (model.nodes[at]?.caption ?? id);
  };
  const button = (label: string, onClick: () => void) => (
    <button type="button" className="button button--ghost button--small" onClick={onClick}>
      {label}
    </button>
  );

  let title = "";
  let body: ReactNode = null;
  let adopt: readonly ActionStep[] | null = null;
  if (state.kind === "path") {
    title =
      state.pathKind === "kShortest"
        ? t("graphCanvas.quick.path.kShortestN", { k: String(K_PATHS) })
        : t(`graphCanvas.quick.path.${state.pathKind}`);
    const paths = state.answer?.paths ?? [];
    const error = errorText(t, state.answer);
    adopt = [
      {
        ...pathStep(state.pathKind, state.from, state.to, state.directed, state.weight),
        keepAll: true,
      },
    ];
    const chosen = paths[state.current];
    const details = chosen === undefined ? null : pathDetails(model, chosen, state.weight);
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
          {state.directed
            ? button(t("graphCanvas.quick.undirected"), () => quick.setDirected(false))
            : null}
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
          {details === null ? null : (
            <table className="data-table graph-quick__details">
              <caption className="field__hint">
                {t("graphCanvas.quick.details", { n: String(state.current + 1) })}
              </caption>
              <thead>
                <tr>
                  <th scope="col">{t("graphCanvas.quick.edge")}</th>
                  <th scope="col">{t("graphCanvas.quick.edgeType")}</th>
                  {state.weight === undefined ? null : <th scope="col">{state.weight}</th>}
                </tr>
              </thead>
              <tbody>
                {details.edges.map((e) => (
                  <tr key={e.id}>
                    <td>{`${e.from} › ${e.to}`}</td>
                    <td>{e.type}</td>
                    {state.weight === undefined ? null : (
                      <td>{e.weight === null ? "1" : summaryNumber(e.weight, language)}</td>
                    )}
                  </tr>
                ))}
              </tbody>
              {details.sum === null ? null : (
                <tfoot>
                  <tr>
                    <th scope="row" colSpan={2}>
                      {t("graphCanvas.quick.sum")}
                    </th>
                    <td>{summaryNumber(details.sum, language)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          )}
          <div className="graph-quick__actions">
            {chosen === undefined
              ? null
              : button(t("graphCanvas.quick.onlyPath"), () => onOnly(chosen.nodes))}
            {button(t("graphCanvas.quick.swap"), quick.swap)}
          </div>
        </>
      );
  } else if (state.kind === "connect") {
    title = t("graphCanvas.quick.connect");
    const answers = state.answers;
    adopt = connectSteps(state.ids).map((s) => ({ ...s, keepAll: true }));
    const nodes =
      answers === null
        ? []
        : [
            ...new Set([
              ...state.ids,
              ...answers.flatMap((a) => (a.paths ?? []).flatMap((p) => p.nodes)),
            ]),
          ];
    body =
      answers === null ? null : (
        <>
          <p
            className={
              answers.some((a) => a.error !== undefined) ? "steps__error" : "graph-quick__sentence"
            }
          >
            {connectSentence(t, state.ids, answers, caption)}
          </p>
          <p className="field__hint">{t("graphCanvas.quick.connectHint")}</p>
          <div className="graph-quick__actions">
            {button(t("graphCanvas.quick.selectAll"), () => onSelect(nodes))}
            {button(t("graphCanvas.quick.onlyThese"), () => onOnly(nodes))}
          </div>
        </>
      );
  } else {
    title = t("graphCanvas.quick.top");
    const error = errorText(t, state.answer);
    const ranked: Ranked[] = ranking(state.answer?.values ?? {});
    const shown = ranked.slice(0, MAX_RANK_ROWS);
    adopt = [topStep(state.measure, false)];
    body = (
      <>
        <Measures quick={quick} measure={state.measure} />
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
              {shown.map((r) => (
                <li key={r.id}>
                  <span className="graph-quick__rank">{r.rank}</span> {caption(r.id)}{" "}
                  <span className="field__hint">{summaryNumber(r.score, language)}</span>
                </li>
              ))}
            </ol>
            {ranked.length > shown.length ? (
              <p className="field__hint">
                {t("graphCanvas.quick.andMore", { count: String(ranked.length - shown.length) })}
              </p>
            ) : null}
            <div className="graph-quick__actions">
              {button(t("graphCanvas.quick.selectAll"), () => onSelect(ranked.map((r) => r.id)))}
              {button(t("graphCanvas.quick.onlyThese"), () => onOnly(ranked.map((r) => r.id)))}
              {onSize === undefined
                ? null
                : button(t("graphCanvas.quick.useSize"), () => onSize(state.measure))}
            </div>
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
      {quick.pending ? <p className="field__hint">{t("graphCanvas.quick.running")}</p> : null}
      {quick.failure === null ? null : <p className="steps__error">{quick.failure}</p>}
      {body}
      <p className="field__hint">{t("graphCanvas.quick.honest")}</p>
      <div className="graph-quick__actions">
        {adopt !== null && onAdopt !== undefined ? (
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={() => onAdopt(adopt)}
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
