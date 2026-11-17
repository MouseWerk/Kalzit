import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";
import { isApiError } from "../../api/client";
import type {
  PublicDashboard,
  PublicLinkView,
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
import { fetchPublicLink, fetchPublicSnapshot, queryPublicPanel, SHARING_KEY } from "./api";
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
function initialChoice(view: PublicLinkView, now: number): Choice {
  const resolved = resolveRange(view.timeRange, now, getTimeSettings());
  if (!resolved.ok) {
    return { kind: "last", ms: Math.min(86_400_000, view.maxWindowMs) };
  }
  const ms = resolved.range.to - resolved.range.from;
  const endsNow = Math.abs(resolved.range.to - now) < 60_000;
  if (endsNow) {
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

function PublicDashboardView({ token, view }: { token: string; view: PublicLinkView }) {
  const { t, language, timeZone } = useI18n();
  const queryClient = useQueryClient();
  const dashboard = view.dashboard;
  useTitle(dashboard.title);
  const [now, setNow] = useState(() => Date.now());
  const [choice, setChoice] = useState<Choice>(() => initialChoice(view, now));
  const range = useMemo(
    () => clampToWindow(choiceRange(choice, now), view.maxWindowMs, now).range,
    [choice, now, view.maxWindowMs],
  );
  const [gone, setGone] = useState(false);
  const texts = useMemo(() => variableTextsOf(dashboard), [dashboard]);

  function refresh() {
    setNow(Date.now());
    void queryClient.invalidateQueries({ queryKey: [SHARING_KEY, "public", token, "panel"] });
  }

  // The dashboard's own refresh, never faster than the server reuses answers.
  const every =
    dashboard.refreshSeconds === undefined || dashboard.refreshSeconds <= 0
      ? null
      : Math.max(dashboard.refreshSeconds * 1000, MIN_REFRESH_MS);
  useEffect(() => {
    if (every === null || choice.kind !== "last") {
      return;
    }
    const timer = window.setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, every);
    return () => window.clearInterval(timer);
  }, [every, choice.kind]);

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
            onChoice={(next) => {
              setNow(Date.now());
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
            range={range}
            now={now}
            maxWindowMs={view.maxWindowMs}
            variables={texts}
            onGone={() => setGone(true)}
          />
        )}
      />
    </Shell>
  );
}

/** One panel of a public link: its stored queries for the visitor's range, run by the server. */
function LivePanel({
  token,
  panel,
  model,
  range,
  now,
  maxWindowMs,
  variables,
  onGone,
}: {
  token: string;
  panel: PublicPanel;
  model: PanelModel;
  range: TimeRange;
  now: number;
  maxWindowMs: number;
  variables: Readonly<Record<string, string>>;
  onGone: () => void;
}) {
  // A panel's own range or shift counts from the visitor's range, inside the window.
  const own = clampToWindow(
    panelRange(
      {
        ...model,
        ...(panel.timeFrom === undefined ? {} : { timeFrom: panel.timeFrom }),
        ...(panel.timeShift === undefined ? {} : { timeShift: panel.timeShift }),
      },
      range,
      now,
    ),
    maxWindowMs,
    now,
  ).range;
  const standalone = model.targets.length === 0;
  const result = useQuery({
    queryKey: [SHARING_KEY, "public", token, "panel", panel.id, own.from, own.to],
    queryFn: ({ signal }) => queryPublicPanel(token, panel.id, own, signal),
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
  return (
    <SharedPanelBody
      model={model}
      range={own}
      response={result.isError ? undefined : result.data}
      pending={!standalone && result.data === undefined && !result.isError}
      failed={result.isError}
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
  onChoice,
}: {
  choice: Choice;
  range: TimeRange;
  maxWindowMs: number;
  now: number;
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
  const label =
    preset !== undefined
      ? t(preset.label)
      : choice.kind === "last"
        ? t("sharing.viewer.last", { duration: durationText(t, choice.ms, true) })
        : fixedRangeText(range, language, timeZone);

  function applyOwn() {
    const start = new Date(from).getTime();
    const end = new Date(to).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) {
      setProblem(t("sharing.viewer.ownInvalid"));
      return;
    }
    const clamped = clampToWindow({ from: start, to: end }, maxWindowMs, Date.now());
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
        />
      )}
    />
  );
}
