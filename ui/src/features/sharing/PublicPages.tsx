import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { isApiError } from "../../api/client";
import type {
  PublicDashboard,
  PublicPanel,
  QueryResponse,
  TimeRange,
} from "../../api/generated/shapes";
import { BrandMark } from "../../appearance/BrandMark";
import { useBrand } from "../../appearance/brand";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { useEscapeLayer } from "../../lib/layers";
import { getTimeSettings } from "../../lib/timeSettings";
import type { PanelModel } from "../dashboards/model";
import { panelRange } from "../dashboards/panelTime";
import { resolveRange, toLocalInput } from "../dashboards/timeRange";
import { errorReason } from "../datasources/reasons";
import {
  fetchPublicLink,
  fetchPublicSnapshot,
  type PublicLinkPage,
  queryPublicPanel,
  SHARING_KEY,
} from "./api";
import {
  clampToWindow,
  dateText,
  dateTimeText,
  durationText,
  fixedRangeText,
  VISITOR_PRESETS,
} from "./model";
import { FixedValues, SharedBoard, SharedPanelBody, variableTextsOf } from "./SharedBoard";
import "./sharing.css";

/*
 * The pages for people without an account (board Sharing.dc.html, frames 6 to 9): a public link
 * with the time range inside its window, a public snapshot, and the one neutral message for
 * every address that does not work. No navigation, no queries, no source names.
 */

/** Visitors' answers are fresh for as long as the server reuses them. */
const PUBLIC_STALE_MS = 30_000;
/** The shortest refresh a public page runs by itself. */
const MIN_REFRESH_MS = 30_000;

function useTitle(title: string | undefined) {
  const { productName } = useBrand();
  useEffect(() => {
    document.title = title === undefined ? productName : `${title} · ${productName}`;
  }, [title, productName]);
}

function Shell({
  title,
  tools,
  strip,
  footer,
  children,
}: {
  title: string;
  tools?: ReactNode;
  strip?: ReactNode;
  footer: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const { productName } = useBrand();
  return (
    <div className="share-page">
      <header className="share-page__top">
        <div className="share-page__brand">
          <span className="share-page__mark">
            <BrandMark />
          </span>
          <h1 className="share-page__title truncate" title={title}>
            {title}
          </h1>
        </div>
        {tools === undefined ? null : <div className="share-page__tools">{tools}</div>}
      </header>
      {strip === undefined ? null : <div className="share-page__strip">{strip}</div>}
      <main className="share-page__main">{children}</main>
      <footer className="share-page__footer">
        <span>{t("sharing.viewer.provided", { product: productName })}</span>
        <span>{footer}</span>
      </footer>
    </div>
  );
}

/**
 * The one message for every address that does not work: expired, revoked, suspended, unknown.
 * Visitors never learn which; the creator and the admins see the reason in their lists.
 */
export function Unavailable() {
  const { t } = useI18n();
  const { productName } = useBrand();
  useTitle(undefined);
  return (
    <main className="status-page share-unavailable">
      <div className="status-page__body">
        <span className="status-page__mark">
          <BrandMark />
        </span>
        <span className="share-unavailable__product">{productName}</span>
        <h1>{t("sharing.viewer.unavailable")}</h1>
        <p className="status-page__text">{t("sharing.viewer.unavailableText")}</p>
      </div>
    </main>
  );
}

function Loading() {
  const { t } = useI18n();
  return (
    <div className="status-page">
      <p className="loading" role="status">
        {t("common.loading")}
      </p>
    </div>
  );
}

/** Too many requests: the only refusal that is worth a second try, so it says so. */
function Busy({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <main className="status-page">
      <div className="status-page__body" role="alert">
        <span className="status-page__mark">
          <BrandMark />
        </span>
        <h1>{t("sharing.viewer.busy")}</h1>
        <p className="status-page__text">{t("sharing.reason.rate_limited")}</p>
        <button type="button" className="button button--secondary" onClick={onRetry}>
          {t("common.retry")}
        </button>
      </div>
    </main>
  );
}

/** A visitor's choice: one of the presets by its length, or a range with fixed ends. */
type Choice = { kind: "last"; ms: number } | { kind: "fixed"; range: TimeRange };

function choiceRange(choice: Choice, now: number): TimeRange {
  return choice.kind === "last" ? { from: now - choice.ms, to: now } : choice.range;
}

/** The range the link opens with, as a choice inside its window. */
function initialChoice(view: PublicLinkPage, now: number): Choice {
  const resolved = resolveRange(view.timeRange, now, getTimeSettings());
  if (!resolved.ok) {
    return { kind: "last", ms: Math.min(86_400_000, view.maxWindowMs) };
  }
  const ms = resolved.range.to - resolved.range.from;
  const endsNow = Math.abs(resolved.range.to - now) < 60_000;
  if (endsNow) {
    // A start range longer than the window is the whole window; its margin comes off when the
    // range is worked out (`clampToWindow`).
    return { kind: "last", ms: Math.min(ms, view.maxWindowMs) };
  }
  return { kind: "fixed", range: clampToWindow(resolved.range, view.maxWindowMs, now).range };
}

export function PublicDashboardPage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const view = useQuery({
    queryKey: [SHARING_KEY, "public", token],
    queryFn: ({ signal }) => fetchPublicLink(token, signal),
    retry: false,
    // One page load is one view; coming back to the tab does not count again.
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  if (view.data !== undefined) {
    return <PublicDashboardView key={token} token={token} view={view.data} />;
  }
  if (view.isError) {
    return isApiError(view.error, "rate_limited") ? (
      <Busy onRetry={() => void view.refetch()} />
    ) : (
      <Unavailable />
    );
  }
  return <Loading />;
}

function PublicDashboardView({ token, view }: { token: string; view: PublicLinkPage }) {
  const { t, language, timeZone } = useI18n();
  const dashboard = view.dashboard;
  useTitle(dashboard.title);
  // The server counts the window from its own clock, so the page does too.
  const serverNow = () => Date.now() + view.clockSkewMs;
  const [now, setNow] = useState(serverNow);
  // Counts the refreshes; each one works its range out anew, when its request is sent.
  const [tick, setTick] = useState(0);
  const [choice, setChoice] = useState<Choice>(() => initialChoice(view, now));
  const range = clampToWindow(choiceRange(choice, now), view.maxWindowMs, now).range;
  const [gone, setGone] = useState(false);
  const texts = useMemo(() => variableTextsOf(dashboard), [dashboard]);
  const queryClient = useQueryClient();
  // Panels whose range had to be shortened to fit the window, by id; the range's label says so.
  const [shortened, setShortened] = useState<readonly string[]>([]);
  const markShortened = (panelId: string, is: boolean) =>
    setShortened((current) =>
      current.includes(panelId) === is
        ? current
        : is
          ? [...current, panelId]
          : current.filter((id) => id !== panelId),
    );

  /**
   * Asks the server for its clock again (the view names it), when a range it refused shows that
   * the page's idea of it is off. Panels that ask within a few seconds share one answer.
   */
  const refreshClock = async () =>
    (
      await queryClient.fetchQuery({
        queryKey: [SHARING_KEY, "public", token],
        queryFn: ({ signal }) => fetchPublicLink(token, signal),
        staleTime: 10_000,
      })
    ).clockSkewMs;

  function refresh() {
    setNow(Date.now() + view.clockSkewMs);
    setTick((current) => current + 1);
  }

  // The dashboard's own refresh, never faster than the server reuses answers.
  const every =
    dashboard.refreshSeconds === undefined || dashboard.refreshSeconds <= 0
      ? null
      : Math.max(dashboard.refreshSeconds * 1000, MIN_REFRESH_MS);
  const skew = view.clockSkewMs;
  useEffect(() => {
    if (every === null || choice.kind !== "last") {
      return;
    }
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        setNow(Date.now() + skew);
        setTick((current) => current + 1);
      }
    }, every);
    return () => window.clearInterval(timer);
  }, [every, choice.kind, skew]);

  if (gone) {
    return <Unavailable />;
  }
  return (
    <Shell
      title={dashboard.title}
      footer={t("sharing.viewer.live")}
      tools={
        <>
          <RangeMenu
            choice={choice}
            range={range}
            maxWindowMs={view.maxWindowMs}
            now={now}
            serverNow={serverNow}
            shortened={shortened.length > 0}
            onChoice={(next) => {
              setNow(serverNow());
              setChoice(next);
            }}
          />
          <button
            type="button"
            className="button button--secondary share-page__refresh"
            aria-label={t("sharing.viewer.refresh")}
            title={t("sharing.viewer.refresh")}
            onClick={refresh}
          >
            <Icon name="refresh" />
          </button>
        </>
      }
      strip={
        <>
          <FixedValues dashboard={dashboard} />
          {shortened.length === 0 ? null : (
            <output className="share-page__note">{t("sharing.viewer.shortenedNote")}</output>
          )}
          <span className="share-page__note">
            {t("sharing.viewer.publicUntil", {
              date: dateText(view.expiresAt, language, timeZone),
            })}
          </span>
        </>
      }
    >
      <SharedBoard
        dashboard={dashboard}
        body={(panel, model) => (
          <LivePanel
            token={token}
            panel={panel}
            model={model}
            choice={choice}
            tick={tick}
            shown={range}
            maxWindowMs={view.maxWindowMs}
            clockSkewMs={view.clockSkewMs}
            refreshClock={refreshClock}
            onShortened={markShortened}
            variables={texts}
            onGone={() => setGone(true)}
          />
        )}
      />
    </Shell>
  );
}

function choiceKey(choice: Choice): string {
  return choice.kind === "last" ? `last:${choice.ms}` : `${choice.range.from}:${choice.range.to}`;
}

/** Whether the server refused a range because it reached outside the link's window. */
function isWindowExceeded(error: unknown): boolean {
  return errorReason(error)?.reason === "sharing.window_exceeded";
}

/** Whether the server's slots for visitors were all busy (`sharing.busy`). */
function isBusy(error: unknown): boolean {
  return errorReason(error)?.reason === "sharing.busy";
}

/** How often a panel asks again while the server is busy, and the longest wait between. */
const BUSY_RETRIES = 3;
const BUSY_MAX_WAIT_MS = 5_000;

/** Waits `ms`, or rejects with the signal's reason when the request goes away. */
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

/**
 * `run`, asked again after the server's wait (`Retry-After`, at most `BUSY_MAX_WAIT_MS`, with a
 * little spread so the panels of a page do not all come back at once) while the server is busy,
 * at most `BUSY_RETRIES` times.
 */
async function whenFree<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= BUSY_RETRIES || !isBusy(error) || !isApiError(error)) throw error;
      const wait = Math.min(error.retryAfterMs ?? 1_000, BUSY_MAX_WAIT_MS);
      await pause(wait + Math.floor(Math.random() * 250), signal);
    }
  }
}

/** One panel of a public link: its stored queries for the visitor's range, run by the server. */
function LivePanel({
  token,
  panel,
  model,
  choice,
  tick,
  shown,
  maxWindowMs,
  clockSkewMs,
  refreshClock,
  onShortened,
  variables,
  onGone,
}: {
  token: string;
  panel: PublicPanel;
  model: PanelModel;
  choice: Choice;
  tick: number;
  /** The range the page shows, for a panel that is drawn before its answer. */
  shown: TimeRange;
  maxWindowMs: number;
  clockSkewMs: number;
  /** Asks the server for its clock again; answers the new skew. */
  refreshClock: () => Promise<number>;
  /** Told whether this panel's range had to be shortened to fit the window. */
  onShortened: (panelId: string, shortened: boolean) => void;
  variables: Readonly<Record<string, string>>;
  onGone: () => void;
}) {
  const standalone = model.targets.length === 0;
  const timed: PanelModel = {
    ...model,
    ...(panel.timeFrom === undefined ? {} : { timeFrom: panel.timeFrom }),
    ...(panel.timeShift === undefined ? {} : { timeShift: panel.timeShift }),
  };
  /**
   * The panel's range as of this moment: worked out when the request is sent, never earlier, so
   * a refetch (a reconnect, a refresh) does not send a range from when the page was drawn. A
   * panel's own range or shift counts from the visitor's range, inside the window.
   */
  function rangeNow(skew: number, margin?: number): TimeRange {
    const at = Date.now() + skew;
    const visitor = clampToWindow(choiceRange(choice, at), maxWindowMs, at, margin).range;
    return clampToWindow(panelRange(timed, visitor, at), maxWindowMs, at, margin).range;
  }
  const result = useQuery({
    queryKey: [SHARING_KEY, "public", token, "panel", panel.id, choiceKey(choice), tick],
    queryFn: async ({ signal }) => {
      const ask = async (range: TimeRange, cut: boolean) => ({
        range,
        shortened: cut,
        response: await whenFree(() => queryPublicPanel(token, panel.id, range, signal), signal),
      });
      try {
        return await ask(rangeNow(clockSkewMs), false);
      } catch (error) {
        if (!isWindowExceeded(error)) throw error;
      }
      // The server counts the window from its clock, and the page's idea of that clock is off
      // (the computer slept, its clock was set): ask for it again and send the same range anew.
      const skew = await refreshClock();
      try {
        return await ask(rangeNow(skew), false);
      } catch (error) {
        if (!isWindowExceeded(error)) throw error;
      }
      // Still outside: the range is shortened well into the window, and the page says so.
      return ask(rangeNow(skew, Math.floor(maxWindowMs / 2)), true);
    },
    enabled: !standalone,
    retry: false,
    staleTime: PUBLIC_STALE_MS,
    refetchOnWindowFocus: false,
    placeholderData: (previous) => previous,
  });
  // The link stopped working while the page was open: the whole page says so.
  const lost = isApiError(result.error, "not_found");
  useEffect(() => {
    if (lost) onGone();
  }, [lost, onGone]);
  const cut = result.data?.shortened === true;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the callback is the page's own, new each render
  useEffect(() => {
    onShortened(panel.id, cut);
  }, [cut, panel.id]);
  return (
    <SharedPanelBody
      model={model}
      range={result.data?.range ?? shown}
      response={result.isError ? undefined : result.data?.response}
      pending={!standalone && result.data === undefined && !result.isError}
      failed={result.isError}
      busy={result.isError && isBusy(result.error)}
      variables={variables}
    />
  );
}

/** The time range of a public link: presets and an own range, both only inside the window. */
function RangeMenu({
  choice,
  range,
  maxWindowMs,
  now,
  serverNow,
  shortened,
  onChoice,
}: {
  /** A panel's range had to be shortened to fit the window: the label says so. */
  shortened: boolean;
  choice: Choice;
  range: TimeRange;
  maxWindowMs: number;
  now: number;
  /** The server's clock as the page knows it. */
  serverNow: () => number;
  onChoice: (choice: Choice) => void;
}) {
  const { t, language, timeZone } = useI18n();
  const menuId = useId();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const earliest = now - maxWindowMs;
  const windowText = durationText(t, maxWindowMs, true);

  function close() {
    setOpen(false);
    buttonRef.current?.focus();
  }
  useEscapeLayer(open, close);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (rootRef.current !== null && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const preset =
    choice.kind === "last" ? VISITOR_PRESETS.find((item) => item.ms === choice.ms) : undefined;
  const chosen =
    preset !== undefined
      ? t(preset.label)
      : choice.kind === "last"
        ? t("sharing.viewer.last", { duration: durationText(t, choice.ms, true) })
        : fixedRangeText(range, language, timeZone);
  // Not what was asked for: never under the name of the full range.
  const label = shortened ? t("sharing.viewer.shortened", { range: chosen }) : chosen;

  function applyOwn() {
    const start = new Date(from).getTime();
    const end = new Date(to).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      setProblem(t("sharing.viewer.ownInvalid"));
      return;
    }
    const clamped = clampToWindow({ from: start, to: end }, maxWindowMs, serverNow());
    onChoice({ kind: "fixed", range: clamped.range });
    setProblem(clamped.clamped ? t("sharing.viewer.clamped", { window: windowText }) : null);
    if (!clamped.clamped) close();
  }

  return (
    <div className="share-range" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="button button--secondary share-range__button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          if (!open) {
            setFrom(toLocalInput(range.from));
            setTo(toLocalInput(range.to));
            setProblem(null);
          }
          setOpen(!open);
        }}
      >
        <Icon name="clock" />
        <span className="truncate" title={label}>
          {label}
        </span>
        <Icon name="chevronDown" />
      </button>
      {open ? (
        <div
          id={menuId}
          className="share-range__menu"
          role="dialog"
          aria-label={t("sharing.viewer.range")}
        >
          <ul className="share-range__presets">
            {VISITOR_PRESETS.map((item) => {
              const outside = item.ms > maxWindowMs;
              const current = choice.kind === "last" && choice.ms === item.ms;
              return (
                <li key={item.ms}>
                  <button
                    type="button"
                    className="share-range__preset"
                    aria-disabled={outside || undefined}
                    aria-current={current ? "true" : undefined}
                    onClick={() => {
                      if (outside) return;
                      onChoice({ kind: "last", ms: item.ms });
                      close();
                    }}
                  >
                    <span>{t(item.label)}</span>
                    {outside ? (
                      <span className="share-range__why">{t("sharing.viewer.outside")}</span>
                    ) : current ? (
                      <span className="share-range__why">{t("sharing.viewer.current")}</span>
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
          <form
            className="share-range__own"
            onSubmit={(event) => {
              event.preventDefault();
              applyOwn();
            }}
          >
            <span className="share-range__heading">{t("sharing.viewer.own")}</span>
            <div className="share-range__inputs">
              <input
                type="datetime-local"
                className="input"
                aria-label={t("sharing.viewer.from")}
                value={from}
                min={toLocalInput(earliest)}
                max={toLocalInput(now)}
                onChange={(event) => setFrom(event.currentTarget.value)}
              />
              <input
                type="datetime-local"
                className="input"
                aria-label={t("sharing.viewer.to")}
                value={to}
                min={toLocalInput(earliest)}
                max={toLocalInput(now)}
                onChange={(event) => setTo(event.currentTarget.value)}
              />
              <button type="submit" className="button button--secondary">
                {t("sharing.viewer.apply")}
              </button>
            </div>
            {problem === null ? null : (
              <p className="field__error" role="alert">
                {problem}
              </p>
            )}
            <p className="share-range__hint">
              {t("sharing.viewer.earliest", {
                date: dateTimeText(earliest, language, timeZone),
                window: windowText,
              })}
            </p>
          </form>
        </div>
      ) : null}
    </div>
  );
}

export function PublicSnapshotPage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const { t, language, timeZone } = useI18n();
  const view = useQuery({
    queryKey: [SHARING_KEY, "public-snapshot", token],
    queryFn: ({ signal }) => fetchPublicSnapshot(token, signal),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  useTitle(view.data?.title);
  if (view.data === undefined) {
    if (!view.isError) return <Loading />;
    return isApiError(view.error, "rate_limited") ? (
      <Busy onRetry={() => void view.refetch()} />
    ) : (
      <Unavailable />
    );
  }
  const snapshot = view.data;
  return (
    <Shell
      title={snapshot.title}
      footer={t("sharing.viewer.frozen")}
      tools={
        <span className="share-page__kind">
          <Icon name="lock" />
          {t("sharing.tab.snapshot")}
        </span>
      }
      strip={
        <>
          <span className="share-page__range">
            {fixedRangeText(snapshot.timeRange, language, timeZone)}
          </span>
          <FixedValues dashboard={snapshot.dashboard} />
          <span className="share-page__note">
            {t("sharing.viewer.snapshotOf", {
              date: dateTimeText(snapshot.createdAt, language, timeZone),
              expires: dateText(snapshot.expiresAt, language, timeZone),
            })}
          </span>
        </>
      }
    >
      <FrozenBoard
        dashboard={snapshot.dashboard}
        results={snapshot.results}
        range={snapshot.timeRange}
      />
    </Shell>
  );
}

/** A snapshot's panels with their frozen answers; viewing never asks a data source. */
export function FrozenBoard({
  dashboard,
  results,
  range,
}: {
  dashboard: PublicDashboard;
  results: Record<string, QueryResponse>;
  range: TimeRange;
}) {
  const { t } = useI18n();
  const texts = useMemo(() => variableTextsOf(dashboard), [dashboard]);
  return (
    <SharedBoard
      dashboard={dashboard}
      body={(panel, model) => (
        <SharedPanelBody
          model={model}
          range={range}
          response={results[panel.id]}
          pending={false}
          failed={false}
          variables={texts}
          missing={t("sharing.viewer.notInSnapshot")}
          unavailable={t("sharing.viewer.noResultInSnapshot")}
        />
      )}
    />
  );
}
