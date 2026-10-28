import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Icon } from "../../../components/Icon";
import { useI18n } from "../../../i18n/i18n";
import { newPanelId, type PanelModel } from "../../dashboards/model";
import { AddToDashboardDialog } from "../../explore/AddToDashboardDialog";
import { handOffToExplore } from "../../explore/handoff";
import { AnswerText } from "../AiAnswer";
import { aiReasonText } from "../reasons";
import type { ChatError, ChatProvider, Outcome, ToolCall, Usage } from "./api";
import { ResultView } from "./ResultView";
import { answerText, queriesRun, queryText, type Step, toolLabelKey } from "./turn";
import "./chat.css";

/** What the answer needs to know of the data sources: which ones the person may query. */
export interface SourceRights {
  orgId: string;
  mayQuery: (datasourceId: string) => boolean;
}

/** The person's question, on the right. */
export function QuestionBubble({
  text,
  when,
  sources = [],
  context,
}: {
  text: string;
  when: string;
  /** The names of the sources chosen for it. */
  sources?: readonly string[] | undefined;
  /** The title of the dashboard it was asked about. */
  context?: string | undefined;
}) {
  const { t } = useI18n();
  return (
    <div className="ask-question">
      <span className="ask-meta">{t("ai.chat.you", { time: when })}</span>
      <p className="ask-question__text">{text}</p>
      {sources.length === 0 && context === undefined ? null : (
        <span className="ask-question__chips">
          {sources.map((name) => (
            <span key={name} className="ask-chip ask-chip--quiet">
              {name}
            </span>
          ))}
          {context === undefined ? null : (
            <span className="ask-chip ask-chip--quiet">
              {t("ai.chat.contextChip", { title: context })}
            </span>
          )}
        </span>
      )}
    </div>
  );
}

function errorText(t: ReturnType<typeof useI18n>["t"], error: ChatError | undefined): string {
  if (error?.reason !== undefined) {
    const text = aiReasonText(t, {
      reason: error.reason,
      params: error.params,
      fallback: error.message,
    });
    if (text !== undefined) {
      return text;
    }
  }
  return error?.message ?? t("ai.call.error.generic");
}

function useCopy() {
  const { t } = useI18n();
  const [said, setSaid] = useState<string | null>(null);
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setSaid(t("ai.chat.copied"));
    } catch {
      setSaid(t("ai.chat.copyFailed"));
    }
  }
  return { said, copy };
}

/** Opens a query in Explore, in its editor and not run, for a source the person may query. */
function OpenInExplore({ datasourceId, query }: { datasourceId: string; query: unknown }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  return (
    <button
      type="button"
      className="button button--secondary button--small"
      onClick={() => {
        handOffToExplore({ datasourceId, query });
        void navigate({ to: "/explore", search: {} });
      }}
    >
      <Icon name="explore" />
      {t("ai.chat.openInExplore")}
    </button>
  );
}

function callSummary(t: ReturnType<typeof useI18n>["t"], call: ToolCall): string | undefined {
  const record = call.record;
  if (record === undefined || record.status !== "ok") {
    return undefined;
  }
  if (call.name === "list_datasources" && Array.isArray(record.items)) {
    return t("ai.chat.tool.sources", { count: record.items.length });
  }
  if (call.name === "find_panels" && Array.isArray(record.items)) {
    return t("ai.chat.tool.dashboards", { count: record.items.length });
  }
  const results = record.results ?? [];
  if (results.length > 0) {
    const rows = results.reduce((sum, result) => sum + result.rows, 0);
    return t("ai.chat.tool.rowsMs", { rows, ms: record.durationMs ?? 0 });
  }
  return undefined;
}

/**
 * What a query reads, for the header of its step: the first table after FROM in SQL, the
 * collection of a MongoDB query, the first label of a Cypher MATCH. Undefined when it is not
 * clear; the query below says the rest.
 */
export function objectRead(
  query: unknown,
): { kind: "table" | "collection" | "label"; name: string } | undefined {
  if (query === null || typeof query !== "object") {
    return undefined;
  }
  const q = query as Record<string, unknown>;
  if (typeof q.collection === "string" && q.collection !== "") {
    return { kind: "collection", name: q.collection };
  }
  if (typeof q.sql === "string") {
    const match = /\bfrom\s+([\w."[\]`]+)/i.exec(q.sql);
    const name = match?.[1]?.replace(/["[\]`]/g, "");
    return name === undefined || name === "" ? undefined : { kind: "table", name };
  }
  if (typeof q.cypher === "string") {
    const match = /\(\s*\w*\s*:\s*`?(\w+)`?/.exec(q.cypher);
    return match?.[1] === undefined ? undefined : { kind: "label", name: match[1] };
  }
  return undefined;
}

/** The names a list of sources or dashboards holds, for a short line under the call. */
function itemNames(items: unknown): string[] {
  if (!Array.isArray(items)) {
    return [];
  }
  return items
    .map((item) => {
      if (item === null || typeof item !== "object") {
        return "";
      }
      const named = item as Record<string, unknown>;
      return typeof named.name === "string"
        ? named.name
        : typeof named.title === "string"
          ? named.title
          : "";
    })
    .filter((name) => name !== "");
}

/**
 * One tool call, folded open where it carries a result: what it did, on which source, the query
 * (read-only), the result in its shape, and Copy and Open in Explore. Every call is shown; the
 * audit log has it too.
 */
function ToolStep({ call, rights }: { call: ToolCall; rights: SourceRights }) {
  const { t } = useI18n();
  const { said, copy } = useCopy();
  const record = call.record;
  const key = toolLabelKey(call.name);
  const panelTitle = record?.dashboard?.panelTitle ?? "";
  // A query that ran is "the data used and the query" of the board, naming what it read.
  const label =
    call.name === "run_query" && record?.status === "ok"
      ? t("ai.chat.usedData")
      : key === undefined
        ? t("ai.chat.tool.unknown", { name: call.name })
        : t(key, { title: panelTitle });
  const read = call.name === "run_query" ? objectRead(record?.query) : undefined;
  const running = record === undefined;
  const failed = record?.status === "error";
  const summary = callSummary(t, call);
  const query = record?.query ?? record?.results?.[0]?.query;
  const datasourceId = record?.datasource?.id ?? record?.results?.[0]?.datasourceId;
  const carriesData = (record?.results ?? []).some((result) => result.data !== undefined);
  const names = itemNames(record?.items);
  return (
    <details className="ask-tool" open={carriesData || failed}>
      <summary className="ask-tool__summary">
        <Icon name="chevronDown" className="ask-tool__chevron" />
        <span
          className={
            running
              ? "ask-tool__state"
              : failed
                ? "ask-tool__state ask-tool__state--failed"
                : "ask-tool__state ask-tool__state--ok"
          }
        >
          <Icon name={running ? "clock" : failed ? "alert" : "check"} />
        </span>
        <span className="ask-tool__label">{label}</span>
        {record?.datasource === undefined ? null : (
          <span className="ask-chip">{record.datasource.name}</span>
        )}
        {record?.dashboard === undefined ? null : (
          <span className="ask-chip">{record.dashboard.title}</span>
        )}
        {read === undefined ? null : (
          <span className="ask-tool__read">
            {t(`ai.chat.read.${read.kind}`, { name: read.name })}
          </span>
        )}
        <span className="ask-tool__meta">
          {running
            ? t("ai.chat.tool.running")
            : failed
              ? t("ai.chat.tool.failed")
              : (summary ?? null)}
        </span>
        <span className="ask-chip ask-chip--quiet">
          <Icon name="lock" />
          {t("ai.chat.readOnly")}
        </span>
      </summary>
      <div className="ask-tool__body">
        {query === undefined ? null : (
          <pre className="ask-tool__query">
            <span className="visually-hidden">{t("ai.chat.queryLabel")}: </span>
            {queryText(query)}
          </pre>
        )}
        {record?.withheld === true ? (
          <p className="ask-result__note">{t("ai.chat.withheld")}</p>
        ) : null}
        {failed ? (
          <p className="ask-tool__error" role="alert">
            {errorText(t, record?.error)}
          </p>
        ) : null}
        {(record?.results ?? []).map((result) =>
          result.error !== undefined && !failed ? (
            <p key={result.refId} className="ask-tool__error">
              {errorText(t, result.error)}
            </p>
          ) : (
            <ResultView key={result.refId} result={result} />
          ),
        )}
        {names.length === 0 ? null : <p className="ask-result__note">{names.join(", ")}</p>}
        <div className="ask-tool__foot">
          <span className="ask-result__note">{t("ai.chat.audited")}</span>
          <span className="ask-spacer" />
          {said === null ? null : (
            <span className="ask-result__note" role="status">
              {said}
            </span>
          )}
          {query === undefined ? null : (
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => void copy(queryText(query))}
            >
              <Icon name="copy" />
              {t("ai.chat.copy")}
            </button>
          )}
          {query !== undefined && datasourceId !== undefined && rights.mayQuery(datasourceId) ? (
            <OpenInExplore datasourceId={datasourceId} query={query} />
          ) : null}
        </div>
      </div>
    </details>
  );
}

/** A query the model proposed: never run; the person opens it in Explore. */
function ProposalCard({ call, rights }: { call: ToolCall; rights: SourceRights }) {
  const { t } = useI18n();
  const { said, copy } = useCopy();
  const record = call.record;
  if (record?.status !== "ok" || record.proposal === undefined || record.query === undefined) {
    return <ToolStep call={call} rights={rights} />;
  }
  const datasourceId = record.datasource?.id;
  return (
    <section className="ask-proposal" aria-label={t("ai.chat.proposal")}>
      <header className="ask-proposal__head">
        <Icon name="sparkle" />
        <span className="ask-proposal__kind">{t("ai.chat.proposal")}</span>
        <span className="ask-proposal__title">{record.proposal.title}</span>
        {record.datasource === undefined ? null : (
          <span className="ask-chip">{record.datasource.name}</span>
        )}
      </header>
      {record.proposal.explanation === undefined || record.proposal.explanation === "" ? null : (
        <p className="ask-proposal__text">{record.proposal.explanation}</p>
      )}
      <pre className="ask-tool__query">
        <span className="visually-hidden">{t("ai.chat.queryLabel")}: </span>
        {queryText(record.query)}
      </pre>
      <div className="ask-tool__foot">
        <span className="ask-result__note">{t("ai.chat.proposalHint")}</span>
        <span className="ask-spacer" />
        {said === null ? null : (
          <span className="ask-result__note" role="status">
            {said}
          </span>
        )}
        <button
          type="button"
          className="button button--ghost button--small"
          onClick={() => void copy(queryText(record.query))}
        >
          <Icon name="copy" />
          {t("ai.chat.copy")}
        </button>
        {datasourceId !== undefined && rights.mayQuery(datasourceId) ? (
          <OpenInExplore datasourceId={datasourceId} query={record.query} />
        ) : null}
      </div>
    </section>
  );
}

/** The last query of an answer that ran or was proposed, on a source the person may query. */
function lastQuery(
  steps: readonly Step[],
  rights: SourceRights,
): { datasourceId: string; query: unknown; title: string | undefined } | undefined {
  for (const step of [...steps].reverse()) {
    if (step.kind !== "call") {
      continue;
    }
    const { name, record } = step.call;
    if (record?.status !== "ok" || (name !== "run_query" && name !== "propose_query")) {
      continue;
    }
    const datasourceId = record.datasource?.id;
    if (datasourceId !== undefined && record.query !== undefined && rights.mayQuery(datasourceId)) {
      return { datasourceId, query: record.query, title: record.proposal?.title };
    }
  }
  return undefined;
}

/**
 * Under an answer (board DataChat.dc.html): its last query "Als Panel speichern" (Explore opens
 * it with the save dialog), "Zum Dashboard hinzufügen", and "Abfrage anpassen" (Explore, not
 * run). Nothing is saved or run without the person's own step.
 */
function QueryActions({ steps, rights }: { steps: readonly Step[]; rights: SourceRights }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const last = lastQuery(steps, rights);
  if (last === undefined) {
    return null;
  }
  const open = (save: boolean) => {
    handOffToExplore({ datasourceId: last.datasourceId, query: last.query, save });
    void navigate({ to: "/explore", search: {} });
  };
  const panel: PanelModel = {
    id: newPanelId(),
    type: "table",
    title: last.title ?? t("ai.chat.panelTitle"),
    grid: { x: 0, y: 0, w: 24, h: 9 },
    targets: [{ refId: "A", datasourceId: last.datasourceId, query: last.query }],
    transformations: [],
    options: {},
    fieldConfig: {},
  };
  return (
    <div className="ask-answer__actions">
      <button
        type="button"
        className="button button--secondary button--small"
        onClick={() => open(true)}
      >
        <Icon name="save" />
        {t("ai.chat.saveAsPanel")}
      </button>
      <button
        type="button"
        className="button button--secondary button--small"
        onClick={() => setAdding(true)}
      >
        <Icon name="plusSquare" />
        {t("ai.chat.addToDashboard")}
      </button>
      <button
        type="button"
        className="button button--secondary button--small"
        onClick={() => open(false)}
      >
        <Icon name="edit" />
        {t("ai.chat.adjustQuery")}
      </button>
      {adding ? (
        <AddToDashboardDialog
          orgId={rights.orgId}
          panel={panel}
          range={{ from: "now-24h", to: "now" }}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </div>
  );
}

export interface AnswerProps {
  steps: readonly Step[];
  provider: ChatProvider | undefined;
  usage: Usage | undefined;
  outcome: Outcome | undefined;
  error: ChatError | undefined;
  when: string;
  /** While the answer is written: Stop is offered, and the card is busy. */
  running: boolean;
  waiting: boolean;
  onStop?: () => void;
  rights: SourceRights;
}

/**
 * The assistant's answer as the board draws it: who answered and how many read-only queries ran,
 * each tool call in turn, the words, proposals, then tokens and Copy. Stop while it runs.
 */
export function ChatAnswer({
  steps,
  provider,
  usage,
  outcome,
  error,
  when,
  running,
  waiting,
  onStop,
  rights,
}: AnswerProps) {
  const { t, language } = useI18n();
  const { said, copy } = useCopy();
  const count = queriesRun(steps);
  const words = answerText(steps);
  const meta = [
    t("ai.chat.assistant", { time: when }),
    provider === undefined ? undefined : `${provider.name} · ${provider.model}`,
    count === 0
      ? undefined
      : count === 1
        ? t("ai.chat.queriesOne")
        : t("ai.chat.queriesMany", { count }),
  ]
    .filter((part) => part !== undefined)
    .join(" · ");
  const tokens =
    usage === undefined
      ? undefined
      : t("ai.chat.tokens", {
          count: new Intl.NumberFormat(language).format(usage.inputTokens + usage.outputTokens),
        });
  return (
    <article
      className="ask-answer"
      aria-label={running ? t("ai.chat.working") : t("ai.chat.answerLabel")}
      aria-busy={running}
    >
      <span className="ask-answer__mark" aria-hidden="true">
        <Icon name="sparkle" />
      </span>
      <div className="ask-answer__body">
        <span className="ask-meta">{meta}</span>
        {steps.map((step, index) => {
          if (step.kind === "text") {
            // biome-ignore lint/suspicious/noArrayIndexKey: the steps are the answer in order.
            return <AnswerText key={index} text={step.text} />;
          }
          return step.call.name === "propose_query" ? (
            <ProposalCard key={step.call.id} call={step.call} rights={rights} />
          ) : (
            <ToolStep key={step.call.id} call={step.call} rights={rights} />
          );
        })}
        {waiting ? <p className="ask-result__note">{t("ai.chat.waiting")}</p> : null}
        {outcome === "failed" || error !== undefined ? (
          <p className="ask-tool__error" role="alert">
            {errorText(t, error)}
          </p>
        ) : null}
        {outcome === "stopped" ? <p className="ask-result__note">{t("ai.chat.stopped")}</p> : null}
        {outcome === "toolLimit" ? (
          <p className="ask-result__note">{t("ai.chat.toolLimit")}</p>
        ) : null}
        {running ? null : <QueryActions steps={steps} rights={rights} />}
        <div className="ask-answer__actions">
          {running && onStop !== undefined ? (
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={onStop}
            >
              {t("ai.chat.stop")}
            </button>
          ) : null}
          {!running && words !== "" ? (
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => void copy(words)}
            >
              <Icon name="copy" />
              {t("ai.chat.copy")}
            </button>
          ) : null}
          {said === null ? null : (
            <span className="ask-result__note" role="status">
              {said}
            </span>
          )}
          <span className="ask-spacer" />
          {tokens === undefined || running ? null : <span className="ask-meta">{tokens}</span>}
        </div>
      </div>
    </article>
  );
}
