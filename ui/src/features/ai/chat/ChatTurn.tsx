import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Icon } from "../../../components/Icon";
import { useI18n } from "../../../i18n/i18n";
import { handOffToExplore } from "../../explore/handoff";
import { AnswerText } from "../AiAnswer";
import { aiReasonText } from "../reasons";
import type { ChatError, ChatProvider, Outcome, ToolCall, Usage } from "./api";
import { ResultView } from "./ResultView";
import { answerText, queriesRun, queryText, type Step, toolLabelKey } from "./turn";
import "./chat.css";

/** What the answer needs to know of the data sources: which ones the person may query. */
export interface SourceRights {
  mayQuery: (datasourceId: string) => boolean;
}

/** The person's question, on the right. */
export function QuestionBubble({ text, when }: { text: string; when: string }) {
  const { t } = useI18n();
  return (
    <div className="ask-question">
      <span className="ask-meta">{t("ai.chat.you", { time: when })}</span>
      <p className="ask-question__text">{text}</p>
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
  const label =
    key === undefined
      ? t("ai.chat.tool.unknown", { name: call.name })
      : t(key, { title: panelTitle });
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
