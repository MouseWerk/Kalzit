import { Link } from "@tanstack/react-router";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useState } from "react";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { isComposingKey } from "../../lib/ime";
import { useOrgPermissions } from "../../org/useOrg";
import { errorReason } from "../datasources/reasons";
import { aiReasonText } from "./reasons";
import type { AiCall } from "./useAiCall";
import "./ai-calls.css";

/** After this long without text, the card says the provider takes longer than usual. */
export const SLOW_AFTER_MS = 2000;

/**
 * The newest finished sentence of a text, for the screen reader: the answer is announced one
 * sentence at a time as it streams, never per token.
 */
export function lastSentence(text: string): string {
  const ends = [...text.matchAll(/[.!?:](?=\s|$)/g)].map((m) => (m.index ?? 0) + 1);
  const end = ends.at(-1);
  if (end === undefined) {
    return "";
  }
  const start = ends.at(-2) ?? 0;
  return text.slice(start, end).trim();
}

/** Text in paragraphs, with fenced code blocks as code. Never HTML: the answer stays text. */
export function AnswerText({ text }: { text: string }) {
  const parts = text.split("```");
  return (
    <div className="ai-answer__text">
      {parts.map((part, index) => {
        if (index % 2 === 1) {
          // The info string (`sql`) is the rest of the fence's first line.
          const body = part.includes("\n") ? part.slice(part.indexOf("\n") + 1) : part;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: the parts are the answer in order
            <pre key={index} className="ai-answer__code">
              <code>{body.replace(/\n$/, "")}</code>
            </pre>
          );
        }
        return part
          .split(/\n{2,}/)
          .map((paragraph) => paragraph.trim())
          .filter((paragraph) => paragraph !== "")
          .map((paragraph, inner) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the parts are the answer in order
            <p key={`${index}:${inner}`}>{paragraph}</p>
          ));
      })}
    </div>
  );
}

export interface AiAnswerProps {
  /** The heading ("Explanation of query A"). */
  title: string;
  call: AiCall;
  /** Shown while waiting and when nothing arrived; a draft shows its own body. */
  body?: ReactNode;
  /** Actions once the answer is whole (Copy is added for plain answers). */
  actions?: ReactNode;
  /** A line under the answer (what was sent). */
  footnote?: ReactNode;
  /** The answer is code (a draft): it is not read out while written, only "Draft ready". */
  code?: boolean;
  /** Where a source closed to AI is opened: shown with that refusal for people who may. */
  sourceLink?: { datasourceId: string; name: string } | undefined;
  onClose?: () => void;
}

/**
 * The answer of an AI call as the board draws it: who answers and how long it took, the text as
 * it streams, Stop while it runs (also Escape), and the states loading, slow, failed, limit
 * reached and source not open to AI.
 */
export function AiAnswer({
  title,
  call,
  body,
  actions,
  footnote,
  code = false,
  sourceLink,
  onClose,
}: AiAnswerProps) {
  const { t, language } = useI18n();
  const permissions = useOrgPermissions();
  const { state } = call;
  const titleId = useId();
  const [slow, setSlow] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const running = state.phase === "waiting" || state.phase === "streaming";

  useEffect(() => {
    setSlow(false);
    if (state.phase !== "waiting") {
      return;
    }
    const timer = window.setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [state.phase]);

  if (state.phase === "idle") {
    return null;
  }

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && running && !isComposingKey(event)) {
      event.preventDefault();
      event.stopPropagation();
      call.stop();
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(state.text);
      setCopied(t("ai.call.copied"));
    } catch {
      setCopied(t("ai.call.copyFailed"));
    }
  }

  const provider = state.meta?.provider;
  // A duration in seconds, as the language writes numbers ("2,1 s").
  const seconds =
    state.endedAt === undefined
      ? undefined
      : `${new Intl.NumberFormat(language, { maximumFractionDigits: 1, minimumFractionDigits: 1 }).format((state.endedAt - state.startedAt) / 1000)} s`;
  const who = provider === undefined ? null : `${provider.name} · ${provider.model}`;

  if (state.phase === "error") {
    const reason = errorReason(state.error);
    const text =
      (reason === undefined ? undefined : aiReasonText(t, reason)) ?? t("ai.call.error.generic");
    const limit = reason?.reason.startsWith("ai.limit_") === true;
    const closed = reason?.reason === "ai.datasource_not_readable";
    const label = limit
      ? t("ai.call.state.limit")
      : closed
        ? t("ai.call.state.closed")
        : t("ai.call.state.error");
    return (
      <section className="ai-answer" aria-labelledby={titleId} onKeyDown={onKeyDown}>
        <header className="ai-answer__head">
          <h3 id={titleId} className="ai-answer__title">
            {title}
          </h3>
          <span className="ai-answer__state">{label}</span>
        </header>
        <div className="ai-answer__body" role="alert">
          <p>
            {closed && sourceLink !== undefined
              ? t("ai.call.closedSource", { name: sourceLink.name })
              : text}
          </p>
          {limit ? <p className="ai-answer__hint">{t("ai.call.limitHint")}</p> : null}
          {!limit && !closed ? <p className="ai-answer__hint">{t("ai.call.unchanged")}</p> : null}
          {closed ? <p className="ai-answer__hint">{t("ai.call.closedHint")}</p> : null}
        </div>
        <footer className="ai-answer__actions">
          {!limit && !closed && state.request !== undefined ? (
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={() => state.request !== undefined && call.start(state.request)}
            >
              {t("ai.call.retry")}
            </button>
          ) : null}
          {closed && sourceLink !== undefined ? (
            <Link
              to="/data-sources/$datasourceId"
              params={{ datasourceId: sourceLink.datasourceId }}
              hash="ai"
              className="button button--secondary button--small"
            >
              {t("ai.call.toSource")}
            </Link>
          ) : null}
          {!limit && !closed && permissions.isServerAdmin ? (
            <Link
              to="/settings/$section"
              params={{ section: "ai" }}
              className="button button--ghost button--small"
            >
              {t("ai.call.toAdmin")}
            </Link>
          ) : null}
          {onClose === undefined ? null : (
            <button type="button" className="button button--ghost button--small" onClick={onClose}>
              {t("ai.call.close")}
            </button>
          )}
        </footer>
      </section>
    );
  }

  return (
    <section
      className="ai-answer"
      aria-labelledby={titleId}
      aria-busy={running}
      onKeyDown={onKeyDown}
    >
      <header className="ai-answer__head">
        <Icon name="sparkle" className="ai-answer__mark" />
        <h3 id={titleId} className="ai-answer__title">
          {title}
        </h3>
        {who === null ? null : <span className="ai-answer__who">{who}</span>}
        <span className="ai-answer__state">
          {running
            ? t("ai.call.writing")
            : state.phase === "stopped"
              ? t("ai.call.stopped")
              : seconds === undefined
                ? null
                : seconds}
        </span>
      </header>
      <div className="ai-answer__body">
        {state.phase === "waiting" ? (
          <p className="ai-answer__waiting">
            {t("ai.call.waiting")}
            {slow ? <span className="ai-answer__hint"> {t("ai.call.slow")}</span> : null}
          </p>
        ) : (
          (body ?? <AnswerText text={state.text} />)
        )}
        {footnote === undefined ? null : <p className="ai-answer__footnote">{footnote}</p>}
      </div>
      {/* Read out per finished sentence, not per token; code only once it is whole. */}
      <p className="visually-hidden" aria-live="polite">
        {code
          ? state.phase === "done"
            ? t("ai.call.draftReady")
            : ""
          : running || state.phase === "done"
            ? lastSentence(state.text)
            : ""}
      </p>
      <footer className="ai-answer__actions">
        {running ? (
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={call.stop}
            aria-keyshortcuts="Escape"
          >
            {t("ai.call.stop")}
          </button>
        ) : (
          <>
            {actions}
            {code || state.text === "" ? null : (
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => void copy()}
              >
                <Icon name="copy" />
                {t("ai.call.copy")}
              </button>
            )}
            {onClose === undefined ? null : (
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={onClose}
              >
                {t("ai.call.close")}
              </button>
            )}
          </>
        )}
        <span className="visually-hidden" role="status">
          {copied}
        </span>
      </footer>
    </section>
  );
}
