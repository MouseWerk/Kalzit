import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { isApiError } from "../../../api/client";
import { Breadcrumbs } from "../../../components/Breadcrumbs";
import { FormAlert } from "../../../components/FormAlert";
import { Icon } from "../../../components/Icon";
import { useI18n } from "../../../i18n/i18n";
import { isComposingKey } from "../../../lib/ime";
import { zoneOption } from "../../../lib/timeSettings";
import { useDocumentTitle } from "../../../lib/useDocumentTitle";
import { useCurrentOrg, useOrgPermissions } from "../../../org/useOrg";
import { DASHBOARDS_KEY, fetchDashboard } from "../../dashboards/api";
import { datasourcesQuery } from "../../datasources/api";
import { KindMark } from "../../datasources/kindMarks";
import { errorReason } from "../../datasources/reasons";
import { providerFor, useAiNotice } from "../AiNotice";
import { AI_STATUS_QUERY_KEY } from "../api";
import { aiLimitReason } from "../calls";
import { aiErrorText, aiReasonText } from "../reasons";
import { useAiReadableSources } from "../source/useAiReadable";
import { useAiStatusFor } from "../useAiStatus";
import {
  CHATS_KEY,
  type ChatMessage,
  type ChatView,
  chatQuery,
  chatsQuery,
  createChat,
  streamAsk,
} from "./api";
import { ChatAnswer, QuestionBubble, type SourceRights } from "./ChatTurn";
import { type ChatContext, ContextPicker } from "./ContextPicker";
import { addCall, addText, type LiveAnswer, setRecord, stepsOf } from "./turn";
import "./chat.css";

/** The longest question, as the server takes it. */
export const MAX_QUESTION = 4000;
/** How often, and how far apart, the page asks again for an answer the server is still storing. */
const SETTLE_ATTEMPTS = 8;
const SETTLE_WAIT_MS = 250;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/** Chats the side pane lists; "All" leads to the whole history. */
const RECENT_CHATS = 4;

/** A source the person may read, for the source picker. */
interface PickerSource {
  id: string;
  name: string;
  kind: string;
  /** AI may read it (the source's opt-in). */
  open: boolean;
  mayQuery: boolean;
}

function usePickerSources(orgId: string): PickerSource[] {
  const sources = useQuery(datasourcesQuery(orgId));
  const open = useAiReadableSources(orgId);
  return (sources.data ?? [])
    .filter((source) => source.access?.read === true || source.access?.query === true)
    .map((source) => ({
      id: source.id,
      name: source.name,
      kind: source.kind,
      open: open.has(source.id),
      mayQuery: source.access?.query === true,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** "Heute, 09:42", "Gestern, 18:10", or the date. */
export function useWhen(): (ms: number) => string {
  const { t, language, timeZone } = useI18n();
  const zone = zoneOption(timeZone);
  const time = new Intl.DateTimeFormat(language, { timeStyle: "short", ...zone });
  const date = new Intl.DateTimeFormat(language, { dateStyle: "medium", ...zone });
  const day = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...zone,
  });
  return (ms: number) => {
    const now = Date.now();
    const at = day.format(ms);
    if (at === day.format(now)) {
      return t("ai.chat.dateToday", { time: time.format(ms) });
    }
    if (at === day.format(now - 24 * 3600 * 1000)) {
      return t("ai.chat.dateYesterday", { time: time.format(ms) });
    }
    return date.format(ms);
  };
}

/**
 * "Fragen" (board DataChat.dc.html with the changes of AI.dc.html frame 11): the conversation
 * with each answer's tool calls, the composer with the chosen sources and today's requests, and
 * the side pane with the provider, the allowed sources, the rights, the history and suggested
 * questions. The route exists only while AI is usable (`routes.tsx`).
 */
export function AskPage() {
  const org = useCurrentOrg();
  const { chat, dashboard, source, q } = useSearch({ from: "/_app/ask" });
  if (org === undefined) {
    return null;
  }
  // A new chat, or another one from the history, starts the page over.
  return (
    <AskChat
      key={chat ?? `new:${dashboard ?? ""}:${source ?? ""}:${q ?? ""}`}
      orgId={org.id}
      chatId={chat}
      start={{ dashboard, source, q }}
    />
  );
}

/** What a link starts a new chat with: a dashboard as context, a source, a question. */
interface ChatStart {
  dashboard: string | undefined;
  source: string | undefined;
  q: string | undefined;
}

function AskChat({
  orgId,
  chatId,
  start,
}: {
  orgId: string;
  chatId: string | undefined;
  start: ChatStart;
}) {
  const { t, language } = useI18n();
  useDocumentTitle("ai.chat.title");
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const when = useWhen();
  const { status } = useAiStatusFor(orgId);
  const notice = useAiNotice(orgId);
  const sources = usePickerSources(orgId);
  const stored = useQuery({ ...chatQuery(orgId, chatId ?? ""), enabled: chatId !== undefined });
  const [selection, setSelection] = useState<string[] | null>(
    start.source === undefined ? null : [start.source],
  );
  const [draft, setDraft] = useState(start.q ?? "");
  // The dashboard asked about: chosen here (null: none), else the linked one or the last one.
  const [chosenContext, setChosenContext] = useState<ChatContext | null | undefined>(undefined);
  const [contextPicking, setContextPicking] = useState(false);
  const linked = useQuery({
    queryKey: [DASHBOARDS_KEY, orgId, "ask-linked", start.dashboard ?? ""],
    queryFn: ({ signal }) => fetchDashboard(orgId, start.dashboard ?? "", signal),
    enabled: start.dashboard !== undefined,
  });
  const [live, setLive] = useState<LiveAnswer | null>(null);
  // Stored messages shown while an answer is live: the ones before its question.
  const [shownBefore, setShownBefore] = useState(0);
  const [sendError, setSendError] = useState<unknown>(null);
  const [contextOpen, setContextOpen] = useState(true);
  const abort = useRef<AbortController | null>(null);
  // A chat created for a question the server then refused, used for the next try.
  const created = useRef<string | undefined>(undefined);
  const endRef = useRef<HTMLDivElement>(null);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const pickerId = useId();
  const [pickerOpen, setPickerOpen] = useState(false);
  const limitId = useId();

  // Leaving the page stops the answer, and what settles it afterwards changes nothing anymore.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      abort.current?.abort();
    };
  }, []);

  // Chosen sources the person can no longer pick (deleted, out of reach) drop out.
  const chosen = (selection ?? stored.data?.datasourceIds ?? []).filter(
    (id) => sources.length === 0 || sources.some((source) => source.id === id),
  );
  const running = live !== null && (live.phase === "waiting" || live.phase === "streaming");
  const messages: ChatMessage[] = stored.data?.messages ?? [];
  const lastAsked = messages.findLast((message) => message.role === "user");
  const context: ChatContext | null =
    chosenContext !== undefined
      ? chosenContext
      : linked.data !== undefined
        ? { id: linked.data.id, title: linked.data.model.title || linked.data.title }
        : lastAsked?.role === "user"
          ? (lastAsked.content.dashboard ?? null)
          : null;
  const sourceNames = (ids: readonly string[] | undefined) =>
    (ids ?? []).flatMap((id) => sources.find((source) => source.id === id)?.name ?? []);
  const visible = live === null ? messages : messages.slice(0, shownBefore);
  const steps = live?.steps.length ?? 0;

  // The newest part of the conversation stays in view while it grows.
  useEffect(() => {
    if (steps >= 0 && visible.length >= 0) {
      endRef.current?.scrollIntoView?.({ block: "end" });
    }
  }, [steps, visible.length]);

  const rights: SourceRights = {
    orgId,
    mayQuery: (id) => sources.some((source) => source.id === id && source.mayQuery),
  };
  const limit = aiLimitReason(status);
  const limitText = limit === undefined ? undefined : aiReasonText(t, limit);

  async function settle(id: string | undefined, isNew: boolean, stopped: boolean, before: number) {
    void queryClient.invalidateQueries({ queryKey: [AI_STATUS_QUERY_KEY, orgId] });
    void queryClient.invalidateQueries({ queryKey: [CHATS_KEY, orgId, "list"] });
    if (id === undefined) {
      return;
    }
    // A stopped answer is stored by the server a moment after the request closed: wait for it,
    // so the page shows it and the next question does not find the chat still answering.
    for (let attempt = 0; attempt < (stopped ? SETTLE_ATTEMPTS : 1); attempt++) {
      try {
        const chat = await queryClient.fetchQuery({ ...chatQuery(orgId, id), staleTime: 0 });
        if (
          !stopped ||
          (chat.messages.length > before + 1 && chat.messages.at(-1)?.role === "assistant")
        ) {
          break;
        }
      } catch {
        // The page shows what it has; the next visit loads the chat again.
        break;
      }
      await wait(SETTLE_WAIT_MS);
      if (!mounted.current) {
        break;
      }
    }
    if (!mounted.current) {
      // The person went elsewhere meanwhile; the page does not take them back.
      return;
    }
    if (isNew) {
      // The new chat gets its address; the page starts over from what was stored.
      void navigate({ to: "/ask", search: { chat: id }, replace: true });
      return;
    }
    setLive(null);
  }

  function ask(text: string) {
    const question = text.trim();
    if (question === "" || running || limit !== undefined) {
      return;
    }
    notice.guard("chat", () => void run(question));
  }

  async function run(question: string) {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const isNew = chatId === undefined;
    let id = chatId ?? created.current;
    setSendError(null);
    const shownBeforeNow = messages.length;
    setShownBefore(shownBeforeNow);
    const askedAbout = context;
    setLive({
      question,
      steps: [],
      phase: "waiting",
      at: Date.now(),
      sources: sourceNames(chosen),
      context: askedAbout?.title,
    });
    setDraft("");
    const update = (change: (current: LiveAnswer) => LiveAnswer) => {
      if (abort.current === controller) {
        setLive((current) => (current === null ? current : change(current)));
      }
    };
    let started = false;
    try {
      if (id === undefined) {
        const chat: ChatView = await createChat(orgId, chosen);
        id = chat.id;
        created.current = chat.id;
      }
      const target = id;
      const send = () =>
        streamAsk(
          orgId,
          target,
          { text: question, datasourceIds: chosen, language, dashboardId: askedAbout?.id },
          {
            onMeta: (meta) => {
              started = true;
              update((s) => ({ ...s, provider: meta.provider }));
            },
            onText: (part) =>
              update((s) => ({ ...s, phase: "streaming", steps: addText(s.steps, part) })),
            onTool: (call) =>
              update((s) => ({ ...s, phase: "streaming", steps: addCall(s.steps, call) })),
            onToolResult: (callId, record) =>
              update((s) => ({ ...s, steps: setRecord(s.steps, callId, record) })),
            onDone: (done) =>
              update((s) => ({
                ...s,
                phase: done.outcome === "failed" ? "error" : "done",
                usage: done.usage,
                outcome: done.outcome,
                error: done.error ?? s.error,
              })),
            onError: (error) => update((s) => ({ ...s, phase: "error", outcome: "failed", error })),
          },
          controller.signal,
        );
      // The answer before may still be finishing on the server (a stop a moment ago).
      for (let attempt = 1; ; attempt++) {
        try {
          await send();
          break;
        } catch (error) {
          const busy = errorReason(error)?.reason === "ai.chat_busy";
          if (!busy || started || attempt >= SETTLE_ATTEMPTS || controller.signal.aborted) {
            throw error;
          }
          await wait(SETTLE_WAIT_MS);
        }
      }
    } catch (error) {
      if (controller.signal.aborted) {
        update((s) => ({ ...s, phase: "stopped", outcome: "stopped" }));
      } else if (!started) {
        // Refused before anything was stored: the question goes back into the composer.
        setLive(null);
        setDraft(question);
        setSendError(error);
        if (isApiError(error, "conflict")) {
          void queryClient.invalidateQueries({ queryKey: [AI_STATUS_QUERY_KEY, orgId] });
        }
        return;
      } else {
        update((s) => ({ ...s, phase: "error", outcome: "failed" }));
      }
    }
    if (abort.current === controller) {
      abort.current = null;
    }
    await settle(id, isNew, controller.signal.aborted, shownBeforeNow);
  }

  function stop() {
    abort.current?.abort();
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    ask(draft);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !isComposingKey(event)) {
      event.preventDefault();
      ask(draft);
    }
  }

  function onConversationKey(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Escape" && running && !isComposingKey(event)) {
      event.preventDefault();
      stop();
    }
  }

  function toggle(id: string) {
    setSelection(chosen.includes(id) ? chosen.filter((s) => s !== id) : [...chosen, id]);
  }

  const title = stored.data?.title || t("ai.chat.newChat");
  const usage = status?.usage;
  const counter =
    usage === undefined
      ? undefined
      : usage.requestsLimit > 0
        ? t("ai.chat.usage", { used: usage.requests, max: usage.requestsLimit })
        : t("ai.chat.usageNoLimit", { used: usage.requests });
  const sendRefusal =
    sendError === null ? undefined : (aiErrorText(t, sendError) ?? t("ai.call.error.generic"));

  return (
    <div className={contextOpen ? "ask" : "ask ask--wide"}>
      <Breadcrumbs
        crumbs={[{ label: t("ai.chat.title"), link: { to: "/ask", search: {} } }, { label: title }]}
      />
      <section
        className="ask__main"
        aria-label={t("ai.chat.conversation")}
        onKeyDown={onConversationKey}
      >
        <div className="ask__bar">
          <span className="ask-spacer" />
          {contextOpen ? null : (
            <button
              type="button"
              className="button button--ghost button--small"
              aria-expanded={false}
              onClick={() => setContextOpen(true)}
            >
              <Icon name="sidebar" />
              {t("ai.chat.openContext")}
            </button>
          )}
          <Link to="/ask" search={{}} className="button button--secondary button--small">
            <Icon name="plus" />
            {t("ai.chat.newChat")}
          </Link>
        </div>
        <div className="ask__messages">
          {chatId !== undefined && stored.isError ? (
            <FormAlert>{t("ai.chat.loadError")}</FormAlert>
          ) : null}
          {visible.length === 0 && live === null && !(chatId !== undefined && stored.isPending) ? (
            <div className="ask__empty">
              <Icon name="sparkle" className="ask__empty-mark" />
              <h1 className="ask__empty-title">{t("ai.chat.empty.title")}</h1>
              <p className="ask-result__note">{t("ai.chat.empty.text")}</p>
            </div>
          ) : (
            <h1 className="visually-hidden">{title}</h1>
          )}
          {visible.map((message) =>
            message.role === "user" ? (
              <QuestionBubble
                key={message.seq}
                text={message.content.text}
                when={when(message.createdAt)}
                sources={sourceNames(message.content.datasourceIds)}
                context={message.content.dashboard?.title}
              />
            ) : (
              <ChatAnswer
                key={message.seq}
                steps={stepsOf(message.content)}
                provider={message.content.provider}
                usage={message.content.usage}
                outcome={message.content.outcome}
                error={message.content.error}
                when={when(message.createdAt)}
                running={false}
                waiting={false}
                rights={rights}
              />
            ),
          )}
          {live === null ? null : (
            <>
              <QuestionBubble
                text={live.question}
                when={when(live.at)}
                sources={live.sources}
                context={live.context}
              />
              <ChatAnswer
                steps={live.steps}
                provider={live.provider}
                usage={live.usage}
                outcome={live.outcome}
                error={live.error}
                when={when(live.at)}
                running={running}
                waiting={live.phase === "waiting"}
                onStop={stop}
                rights={rights}
              />
            </>
          )}
          <div ref={endRef} />
        </div>
        <form className="ask-composer" aria-label={t("ai.chat.composer")} onSubmit={onSubmit}>
          <div className="ask-composer__sources">
            <span className="ask-result__note">{t("ai.chat.sources")}</span>
            {chosen.length === 0 ? (
              <span className="ask-chip">{t("ai.chat.allSources")}</span>
            ) : (
              chosen.map((id) => {
                const source = sources.find((s) => s.id === id);
                if (source === undefined) {
                  return null;
                }
                return (
                  <span key={id} className="ask-chip ask-chip--chosen">
                    <KindMark kind={source.kind} small />
                    {source.name}
                    <button
                      type="button"
                      className="ask-chip__remove"
                      aria-label={t("ai.chat.removeSource", { name: source.name })}
                      title={t("ai.chat.removeSource", { name: source.name })}
                      onClick={() => toggle(id)}
                    >
                      <Icon name="close" />
                    </button>
                  </span>
                );
              })
            )}
            <button
              type="button"
              className="ask-chip ask-chip--add"
              aria-expanded={pickerOpen}
              aria-controls={pickerId}
              onClick={() => setPickerOpen((open) => !open)}
            >
              {t("ai.chat.addSource")}
            </button>
            {context === null ? null : (
              <>
                <span className="ask-composer__divider" aria-hidden="true" />
                <span className="ask-chip">
                  <Icon name="dashboards" />
                  {t("ai.chat.contextChip", { title: context.title })}
                  <button
                    type="button"
                    className="ask-chip__remove"
                    aria-label={t("ai.chat.removeContext")}
                    title={t("ai.chat.removeContext")}
                    onClick={() => setChosenContext(null)}
                  >
                    <Icon name="close" />
                  </button>
                </span>
              </>
            )}
            <span className="ask-spacer" />
            {counter === undefined ? null : <span className="ask-result__note">{counter}</span>}
          </div>
          {contextPicking ? (
            <ContextPicker
              orgId={orgId}
              onPick={(picked) => {
                setChosenContext(picked);
                setContextPicking(false);
                questionRef.current?.focus();
              }}
              onClose={() => setContextPicking(false)}
            />
          ) : null}
          {pickerOpen ? (
            <fieldset id={pickerId} className="ask-composer__picker">
              <legend className="visually-hidden">{t("ai.chat.sources")}</legend>
              {sources.length === 0 ? (
                <p className="ask-result__note">{t("ai.chat.noSources")}</p>
              ) : null}
              <SourceChoices sources={sources} chosen={chosen} onToggle={toggle} />
            </fieldset>
          ) : null}
          <label className="ask-composer__field">
            <span className="visually-hidden">{t("ai.chat.question")}</span>
            <textarea
              ref={questionRef}
              className="ask-composer__input"
              rows={2}
              maxLength={MAX_QUESTION}
              placeholder={t("ai.chat.placeholder")}
              value={draft}
              aria-describedby={limitText === undefined ? hintId : `${hintId} ${limitId}`}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
            />
          </label>
          {sendRefusal === undefined ? null : <FormAlert>{sendRefusal}</FormAlert>}
          {limitText === undefined ? null : (
            <p id={limitId} className="ask-composer__limit">
              {limitText}
            </p>
          )}
          <div className="ask-composer__foot">
            <button
              type="button"
              className="button button--secondary button--small"
              aria-expanded={contextPicking}
              onClick={() => setContextPicking((open) => !open)}
            >
              <Icon name="link" />
              {t("ai.chat.contextButton")}
            </button>
            <span id={hintId} className="ask-result__note">
              {t("ai.chat.enterHint")}
            </span>
            <span className="ask-spacer" />
            <span className="ask-result__note">{t("ai.chat.readOnlyQueries")}</span>
            <button
              type="submit"
              className="button button--primary"
              disabled={running || limit !== undefined || draft.trim() === ""}
            >
              <Icon name="arrowRight" />
              {t("ai.chat.send")}
            </button>
          </div>
        </form>
      </section>
      {contextOpen ? (
        <ContextPane
          orgId={orgId}
          chatId={chatId}
          sources={sources}
          chosen={chosen}
          onToggle={toggle}
          onSuggest={(text) => {
            setDraft(text);
            questionRef.current?.focus();
          }}
          onClose={() => setContextOpen(false)}
        />
      ) : null}
      {notice.dialog}
    </div>
  );
}

function ContextPane({
  orgId,
  chatId,
  sources,
  chosen,
  onToggle,
  onSuggest,
  onClose,
}: {
  orgId: string;
  chatId: string | undefined;
  sources: PickerSource[];
  chosen: string[];
  onToggle: (id: string) => void;
  onSuggest: (text: string) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const permissions = useOrgPermissions();
  const { status } = useAiStatusFor(orgId);
  const recent = useQuery(chatsQuery(orgId));
  const when = useWhen();
  // The provider the chat goes to, which the server may have chosen apart from the others.
  const provider = providerFor(status, "chat");
  const open = sources.filter((source) => source.open);
  const headingId = useId();
  return (
    <aside className="ask-context" aria-labelledby={headingId}>
      <div className="ask-context__head">
        <h2 id={headingId} className="ask-context__title">
          {t("ai.chat.context")}
        </h2>
        <button
          type="button"
          className="button button--ghost button--small ask-context__close"
          aria-label={t("ai.chat.closeContext")}
          title={t("ai.chat.closeContext")}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
      </div>
      {provider === undefined ? null : (
        <section className="ask-context__section" aria-labelledby={`${headingId}-model`}>
          <h3 id={`${headingId}-model`} className="ask-context__label">
            {t("ai.chat.model")}
          </h3>
          <p className="ask-context__value">
            {provider.name} · {provider.model}
          </p>
          <dl className="ask-context__facts">
            <dt>{t("ai.chat.endpoint")}</dt>
            <dd className="ask-context__mono">{provider.endpoint || provider.host}</dd>
            <dt>{t("ai.chat.providerStatus")}</dt>
            <dd>
              <span
                className={
                  provider.reachable === true
                    ? "ask-dot ask-dot--ok"
                    : provider.reachable === false
                      ? "ask-dot ask-dot--failed"
                      : "ask-dot"
                }
                aria-hidden="true"
              />
              {provider.reachable === true
                ? t("ai.chat.reachable")
                : provider.reachable === false
                  ? t("ai.chat.unreachable")
                  : t("ai.chat.untested")}
            </dd>
            <dt>{t("ai.chat.leavesServer")}</dt>
            <dd>
              {/* The administrators' word as a fact; from the address only an estimate. */}
              {provider.leavesNetworkEstimated
                ? provider.leavesNetwork
                  ? t("ai.chat.leavesEstimateYes", { host: provider.host })
                  : t("ai.chat.leavesEstimateNo")
                : provider.leavesNetwork
                  ? t("ai.chat.leavesYes", { host: provider.host })
                  : t("ai.chat.leavesNo")}
            </dd>
          </dl>
          {permissions.isServerAdmin || permissions.has("settings:write") ? (
            <p className="ask-result__note">
              {t("ai.chat.modelSetBy")}{" "}
              <Link
                to="/settings/$section"
                params={{ section: "ai" }}
                className="ask-context__link"
              >
                {t("ai.chat.adminLink")}
              </Link>
            </p>
          ) : null}
        </section>
      )}
      <fieldset className="ask-context__section ask-context__sources">
        <legend className="ask-context__label ask-context__legend">
          <span>{t("ai.chat.allowed")}</span>
          <span className="ask-result__note">
            {chosen.length === 0
              ? t("ai.chat.allowedAll")
              : t("ai.chat.allowedCount", { chosen: chosen.length, total: open.length })}
          </span>
        </legend>
        {sources.length === 0 ? <p className="ask-result__note">{t("ai.chat.noSources")}</p> : null}
        <SourceChoices sources={sources} chosen={chosen} onToggle={onToggle} />
      </fieldset>
      <section className="ask-context__section">
        <div className="ask-rights">
          <Icon name="shieldCheck" />
          <p>
            <strong>{t("ai.chat.rightsTitle")}</strong> {t("ai.chat.rightsText")}
          </p>
        </div>
      </section>
      <section className="ask-context__section" aria-labelledby={`${headingId}-history`}>
        <div className="ask-context__row">
          <h3 id={`${headingId}-history`} className="ask-context__label">
            {t("ai.chat.history")}
          </h3>
          <span className="ask-spacer" />
          <Link to="/ask/history" className="ask-context__link">
            {t("ai.chat.historyAll")}
          </Link>
        </div>
        {(recent.data?.items ?? []).length === 0 ? (
          <p className="ask-result__note">{t("ai.chat.historyEmpty")}</p>
        ) : (
          <ul className="ask-history">
            {(recent.data?.items ?? []).slice(0, RECENT_CHATS).map((chat) => (
              <li key={chat.id}>
                <Link
                  to="/ask"
                  search={{ chat: chat.id }}
                  className="ask-history__link"
                  aria-current={chat.id === chatId ? "page" : undefined}
                >
                  <span className="ask-history__title truncate" title={chat.title}>
                    {chat.title || t("ai.chat.newChat")}
                  </span>
                  <span className="ask-result__note">
                    {[when(chat.updatedAt), ...chat.datasources.map((s) => s.name)].join(" · ")}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="ask-context__section" aria-labelledby={`${headingId}-suggest`}>
        <h3 id={`${headingId}-suggest`} className="ask-context__label">
          {t("ai.chat.suggestions")}
        </h3>
        {(
          [
            "ai.chat.suggestion.sources",
            "ai.chat.suggestion.panels",
            "ai.chat.suggestion.week",
          ] as const
        ).map((key) => (
          <button
            key={key}
            type="button"
            className="ask-suggestion"
            onClick={() => onSuggest(t(key))}
          >
            {t(key)}
          </button>
        ))}
      </section>
    </aside>
  );
}

/** The sources to choose from: open ones as checkboxes, closed ones greyed with the reason. */
function SourceChoices({
  sources,
  chosen,
  onToggle,
}: {
  sources: PickerSource[];
  chosen: string[];
  onToggle: (id: string) => void;
}) {
  const { t } = useI18n();
  const prefix = useId();
  return (
    <>
      {sources
        .filter((source) => source.open)
        .map((source) => (
          <label key={source.id} className="ask-source">
            <input
              type="checkbox"
              checked={chosen.includes(source.id)}
              onChange={() => onToggle(source.id)}
              aria-label={t("ai.chat.allowSource", { name: source.name })}
            />
            <KindMark kind={source.kind} small />
            <span className="ask-source__name truncate" title={source.name}>
              {source.name}
            </span>
          </label>
        ))}
      {sources
        .filter((source) => !source.open)
        .map((source) => (
          <label key={source.id} className="ask-source ask-source--closed">
            <input
              type="checkbox"
              disabled
              checked={false}
              aria-describedby={`${prefix}-${source.id}`}
            />
            <KindMark kind={source.kind} small />
            <span className="ask-source__name truncate" title={source.name}>
              {source.name}
            </span>
            <span id={`${prefix}-${source.id}`} className="ask-result__note">
              {t("ai.chat.notOpen")}
            </span>
          </label>
        ))}
    </>
  );
}
