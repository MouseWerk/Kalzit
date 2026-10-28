import { Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import type { TimeRange } from "../../api/generated/shapes";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { isComposingKey } from "../../lib/ime";
import { AiAnswer } from "./AiAnswer";
import { useAiNotice } from "./AiNotice";
import { type AiCallMeta, aiLimitReason } from "./calls";
import { aiReasonText } from "./reasons";
import { useAiReadableSources } from "./source/useAiReadable";
import { useAiCall } from "./useAiCall";
import { useAiStatusFor } from "./useAiStatus";
import "./ai-calls.css";

/** The longest request of a draft, as the server takes it. */
export const MAX_DRAFT_REQUEST = 4000;

export interface AiSource {
  id: string;
  kind: string;
  name: string;
}

/** "Why is this button off": the used-up limit, as text for `aria-describedby` and the tooltip. */
function useLimitText(orgId: string): string | undefined {
  const { t } = useI18n();
  const { status } = useAiStatusFor(orgId);
  const limit = aiLimitReason(status);
  return limit === undefined ? undefined : aiReasonText(t, limit);
}

/** The line under an explanation or a draft: who answered, and whether the schema went along. */
function schemaNote(
  t: ReturnType<typeof useI18n>["t"],
  meta: AiCallMeta | undefined,
): string | undefined {
  if (meta === undefined) {
    return undefined;
  }
  return meta.schema === true ? t("ai.call.sentSchema") : t("ai.call.sentQueryOnly");
}

/**
 * "Explain" and "Draft" in the query header of Explore (board frame 8). Renders nothing unless
 * AI is usable (the caller wraps it in `AiGate`). A draft is only offered: "Apply" puts it into
 * the editor, where Run sends it through the same read-only checks as any query.
 */
export function ExploreAiTools({
  orgId,
  source,
  query,
  hasQuery,
  onApply,
}: {
  orgId: string;
  source: AiSource;
  query: unknown;
  /** Whether the editor holds a query to explain. */
  hasQuery: boolean;
  /** Replaces the query in the editor with the draft. */
  onApply: (query: unknown) => void;
}) {
  const { t } = useI18n();
  const explain = useAiCall(orgId);
  const draft = useAiCall(orgId);
  const notice = useAiNotice(orgId);
  const limitText = useLimitText(orgId);
  const limitId = useId();
  const requestId = useId();
  const [asking, setAsking] = useState(false);
  const [request, setRequest] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const blocked = limitText !== undefined;

  function runExplain() {
    notice.guard("explain", () => {
      draft.reset();
      explain.start({ kind: "explain", datasourceId: source.id, query });
    });
  }

  function runDraft(event: FormEvent) {
    event.preventDefault();
    const text = request.trim();
    if (text === "") {
      inputRef.current?.focus();
      return;
    }
    notice.guard("draft", () => {
      explain.reset();
      draft.start({ kind: "draft", datasourceId: source.id, request: text, query });
    });
  }

  const drafted = draft.state.done?.draft;
  const draftText = draft.state.done?.draftText ?? draft.state.text;

  return (
    <div className="ai-tools">
      <div className="ai-tools__bar">
        <button
          type="button"
          className="button button--ghost button--small"
          onClick={runExplain}
          disabled={blocked || !hasQuery}
          aria-describedby={blocked ? limitId : undefined}
          title={limitText}
        >
          <Icon name="sparkle" />
          {t("ai.call.explain")}
        </button>
        <button
          type="button"
          className="button button--ghost button--small"
          aria-expanded={asking}
          aria-controls={asking ? requestId : undefined}
          onClick={() => {
            setAsking(!asking);
            if (!asking) {
              window.setTimeout(() => inputRef.current?.focus(), 0);
            }
          }}
          disabled={blocked}
          aria-describedby={blocked ? limitId : undefined}
          title={limitText}
        >
          <Icon name="sparkle" />
          {t("ai.call.draft")}
        </button>
        {blocked ? (
          <span className="ai-tools__limit" id={limitId}>
            {limitText}
          </span>
        ) : null}
      </div>
      {asking ? (
        <form className="ai-tools__ask" id={requestId} onSubmit={runDraft}>
          <label className="visually-hidden" htmlFor={`${requestId}-text`}>
            {t("ai.call.draftLabel")}
          </label>
          <textarea
            ref={inputRef}
            id={`${requestId}-text`}
            className="input ai-tools__request"
            rows={2}
            maxLength={MAX_DRAFT_REQUEST}
            placeholder={t("ai.call.draftPlaceholder")}
            value={request}
            onChange={(event) => setRequest(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                (event.ctrlKey || event.metaKey) &&
                !isComposingKey(event)
              ) {
                runDraft(event);
              }
            }}
          />
          <div className="ai-tools__ask-actions">
            {draft.state.phase === "waiting" || draft.state.phase === "streaming" ? (
              <button
                type="button"
                className="button button--secondary button--small"
                onClick={draft.stop}
              >
                {t("ai.call.stop")}
              </button>
            ) : (
              <button
                type="submit"
                className="button button--secondary button--small"
                disabled={blocked || request.trim() === ""}
              >
                {t("ai.call.draftSend")}
              </button>
            )}
          </div>
        </form>
      ) : null}
      <AiAnswer
        title={t("ai.call.explanationTitle")}
        call={explain}
        footnote={schemaNote(t, explain.state.meta)}
        onClose={explain.reset}
      />
      <AiAnswer
        title={t("ai.call.draftTitle")}
        call={draft}
        code
        body={
          <>
            <pre className="ai-answer__code ai-answer__code--draft">
              <code>{draftText}</code>
            </pre>
            {draft.state.phase === "done" && drafted === null ? (
              <p className="ai-answer__hint">{t("ai.call.draftUnfit")}</p>
            ) : null}
          </>
        }
        footnote={
          draft.state.phase === "done" || draft.state.phase === "stopped"
            ? `${t("ai.call.draftNotRun")} ${schemaNote(t, draft.state.meta) ?? ""}`.trim()
            : undefined
        }
        actions={
          <>
            <button
              type="button"
              className="button button--primary button--small"
              disabled={drafted === undefined || drafted === null}
              onClick={() => {
                if (drafted !== undefined && drafted !== null) {
                  onApply(drafted);
                  draft.reset();
                  setAsking(false);
                }
              }}
            >
              {t("ai.call.apply")}
            </button>
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={draft.reset}
            >
              {t("ai.call.discard")}
            </button>
          </>
        }
      />
      {notice.dialog}
    </div>
  );
}

/**
 * "Summarize" at the result of Explore (board frame 9): the button for the result bar and the
 * summary below it. Both are empty unless AI is usable.
 */
export function useExploreAiSummary(
  orgId: string,
  source: AiSource,
  /** The query that gave the result shown, and its range. */
  run: { query: unknown; timeRange: TimeRange; intervalMs?: number } | null,
): { button: ReactNode; card: ReactNode } {
  const { t } = useI18n();
  const { usable } = useAiStatusFor(orgId);
  const call = useAiCall(orgId);
  const notice = useAiNotice(orgId);
  const limitText = useLimitText(orgId);
  const readable = useAiReadableSources(orgId).has(source.id);
  const reasonId = useId();
  const reason =
    limitText ?? (readable ? undefined : t("ai.call.closedSource", { name: source.name }));

  function summarize() {
    if (run === null) {
      return;
    }
    notice.guard("summarize", () =>
      call.start({
        kind: "summarize",
        query: { refId: "A", datasourceId: source.id, query: run.query },
        timeRange: run.timeRange,
        ...(run.intervalMs === undefined ? {} : { intervalMs: run.intervalMs }),
      }),
    );
  }

  if (!usable) {
    return { button: null, card: null };
  }
  const button = (
    <>
      <button
        type="button"
        className="button button--ghost button--small"
        onClick={summarize}
        disabled={run === null || reason !== undefined}
        aria-describedby={reason === undefined ? undefined : reasonId}
        title={reason}
      >
        <Icon name="sparkle" />
        {t("ai.call.summarize")}
      </button>
      {reason === undefined ? null : (
        <span className="visually-hidden" id={reasonId}>
          {reason}
        </span>
      )}
      {notice.dialog}
    </>
  );
  const card = (
    <SummaryCard
      call={call}
      title={t("ai.call.summaryTitleExplore")}
      sourceLink={{ datasourceId: source.id, name: source.name }}
      followUp={{ source: source.id, q: t("ai.chat.followUpExplore", { name: source.name }) }}
    />
  );
  return { button, card };
}

/** What a summary sent, in one line: rows per query, cut or not, excluded values. */
export function sentNote(
  t: ReturnType<typeof useI18n>["t"],
  meta: AiCallMeta | undefined,
): string | undefined {
  const provider = meta?.provider;
  const results = meta?.results;
  if (provider === undefined || results === undefined) {
    return undefined;
  }
  const rows = results.reduce((sum, r) => sum + r.rows, 0);
  const excluded = results.reduce((sum, r) => sum + r.excludedValues, 0);
  const parts = [
    t(meta?.title === true ? "ai.call.sentSummaryTitled" : "ai.call.sentSummary", {
      queries: results.map((r) => r.refId).join(", "),
      rows,
      provider: provider.name,
      host: provider.host,
    }),
  ];
  if (results.some((r) => r.truncated)) {
    parts.push(t("ai.call.sentTruncated"));
  }
  if (excluded > 0) {
    parts.push(t("ai.call.sentExcluded", { count: excluded }));
  }
  return parts.join(" ");
}

export function SummaryCard({
  call,
  title,
  sourceLink,
  onClose,
  followUp,
}: {
  call: ReturnType<typeof useAiCall>;
  title: string;
  sourceLink?: { datasourceId: string; name: string } | undefined;
  onClose?: () => void;
  /** Where "In Fragen weiterfragen" starts a chat: a dashboard or a source as its context. */
  followUp?: { dashboard?: string; source?: string; q: string } | undefined;
}) {
  const { t } = useI18n();
  return (
    <AiAnswer
      title={title}
      call={call}
      footnote={sentNote(t, call.state.meta)}
      sourceLink={sourceLink}
      onClose={onClose ?? call.reset}
      actions={
        followUp === undefined ? undefined : (
          <Link
            to="/ask"
            search={followUp}
            className="button button--secondary button--small"
            onClick={() => onClose?.()}
          >
            <Icon name="ask" />
            {t("ai.chat.followUp")}
          </Link>
        )
      }
    />
  );
}
