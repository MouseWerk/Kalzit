import { type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import type { Span } from "../../api/generated/shapes";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { useI18n } from "../../i18n/i18n";
import { writeClipboard } from "../../lib/clipboard";
import { isComposingKey } from "../../lib/ime";
import { tabForKey } from "../../lib/tabKeys";
import { showToast } from "../../lib/toasts";
import { formatDuration, type TraceView, valueText } from "./model";
import { coversWaterfall } from "./sheet";
import "./trace.css";

const TABS = ["attributes", "events", "links", "resource"] as const;
type DetailTab = (typeof TABS)[number];

/** What the page around the trace offers for a value or a linked trace; all optional. */
export interface SpanActions {
  /** Adds the value to the search as a tag (Explore). */
  filter?: ((key: string, value: string) => void) | undefined;
  /** Sets the dashboard variable to the value. */
  variable?: { name: string; set: (value: string) => void } | undefined;
  /** Opens another trace by its id (a span link). */
  openTrace?: ((traceId: string) => void) | undefined;
}

/**
 * One span in full (board frames 2 to 4): attributes, events with their time from the span's
 * start, links to spans of other traces, and the resource and instrumentation that recorded it.
 */
export function SpanDetail({
  span,
  trace,
  overlay,
  actions,
  onClose,
}: {
  span: Span;
  trace: TraceView;
  /** Lies over the waterfall (a dashboard panel) instead of beside it. */
  overlay: boolean;
  actions: SpanActions;
  onClose: () => void;
}) {
  const { t, language } = useI18n();
  const id = useId();
  const [tab, setTab] = useState<DetailTab>("attributes");
  const parent = trace.spans.find((other) => other.spanId === span.parentSpanId);
  const counts: Record<DetailTab, number | null> = {
    attributes: Object.keys(span.attributes).length,
    events: span.events.length,
    links: span.links.length,
    resource: null,
  };
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next = tabForKey(TABS, tab, event.key);
    if (next === undefined) {
      return;
    }
    event.preventDefault();
    setTab(next);
    document.getElementById(`${id}-${next}-tab`)?.focus();
  }
  // Over the whole waterfall (the sheet of a narrow window, or the overlay of a panel no wider
  // than it, trace.css) the rows behind it cannot be seen: they are inert for as long, the sheet
  // takes the focus, and closing it gives the focus back to the span's row.
  const sheet = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = sheet.current;
    const behind = element?.previousElementSibling;
    if (element === null || !(behind instanceof HTMLElement)) {
      return;
    }
    const check = () => {
      const covered = coversWaterfall(element, behind);
      behind.toggleAttribute("inert", covered);
      if (covered && !element.contains(document.activeElement)) {
        element.focus();
      }
    };
    check();
    // The window or the panel may change its width while the detail is open.
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(check);
    observer?.observe(element);
    observer?.observe(behind);
    return () => {
      observer?.disconnect();
      behind.removeAttribute("inert");
    };
  }, []);
  // The row takes the focus as the detail closes: it has to be reachable again by then.
  const close = () => {
    sheet.current?.previousElementSibling?.removeAttribute("inert");
    onClose();
  };
  return (
    <aside
      ref={sheet}
      tabIndex={-1}
      className={overlay ? "span-detail span-detail--overlay" : "span-detail"}
      aria-label={t("traces.span")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !isComposingKey(event)) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <div className="span-detail__head">
        <div className="span-detail__names">
          <p className="span-detail__kicker">{t("traces.span")}</p>
          <h3 className="span-detail__title">
            {span.service}: {span.operation}
          </h3>
        </div>
        {span.status === "error" ? <span className="trace-error">{t("traces.error")}</span> : null}
        <IconButton icon="close" label={t("admin.common.close")} onClick={close} />
      </div>
      <dl className="trace-facts">
        <div>
          <dt>{t("traces.duration")}</dt>
          <dd>{formatDuration(span.duration, language)}</dd>
        </div>
        <div>
          <dt>{t("traces.from")}</dt>
          <dd>{formatDuration(span.start - trace.start, language)}</dd>
        </div>
        <div>
          <dt>{t("traces.kind")}</dt>
          <dd>{span.kind}</dd>
        </div>
        <div>
          <dt>{t("traces.spanId")}</dt>
          <dd className="trace-mono">{span.spanId}</dd>
        </div>
        {span.parentSpanId === undefined ? null : (
          <div>
            <dt>{t("traces.parent")}</dt>
            <dd>
              {parent === undefined
                ? t("traces.parentMissing")
                : `${parent.service}: ${parent.operation}`}
            </dd>
          </div>
        )}
      </dl>
      {span.status === "error" && span.statusMessage !== undefined ? (
        <p className="notice notice--danger">
          <Icon name="alert" />
          <span>{span.statusMessage}</span>
        </p>
      ) : null}
      <div className="tabs" role="tablist" aria-label={t("traces.span")} onKeyDown={onKeyDown}>
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`${id}-${name}-tab`}
            className="tabs__tab"
            aria-selected={tab === name}
            aria-controls={`${id}-${name}`}
            tabIndex={tab === name ? 0 : -1}
            onClick={() => setTab(name)}
          >
            {t(`traces.tab.${name}`)}
            {counts[name] === null ? null : <span className="tabs__count">{counts[name]}</span>}
          </button>
        ))}
      </div>
      <div
        className="span-detail__panel"
        role="tabpanel"
        id={`${id}-${tab}`}
        aria-labelledby={`${id}-${tab}-tab`}
      >
        {tab === "attributes" ? (
          <KeyValues values={span.attributes} actions={actions} empty={t("traces.none")} />
        ) : null}
        {tab === "events" ? <Events span={span} /> : null}
        {tab === "links" ? <Links span={span} actions={actions} /> : null}
        {tab === "resource" ? (
          <>
            <h4 className="span-detail__section">{t("traces.resource")}</h4>
            <KeyValues
              values={{ "service.name": span.service, ...(span.resource ?? {}) }}
              actions={actions}
              empty={t("traces.none")}
            />
            {span.scope === undefined ? null : (
              <>
                <h4 className="span-detail__section">{t("traces.scope")}</h4>
                <KeyValues
                  values={{
                    "scope.name": span.scope.name,
                    ...(span.scope.version === undefined
                      ? {}
                      : { "scope.version": span.scope.version }),
                  }}
                  actions={{}}
                  empty=""
                />
              </>
            )}
          </>
        ) : null}
      </div>
    </aside>
  );
}

function KeyValues({
  values,
  actions,
  empty,
}: {
  values: Record<string, unknown>;
  actions: SpanActions;
  empty: string;
}) {
  const { t } = useI18n();
  const entries = Object.entries(values);
  if (entries.length === 0) {
    return <p className="span-detail__empty">{empty}</p>;
  }
  return (
    <dl className="span-kv">
      {entries.map(([key, value]) => {
        const text = valueText(value);
        const { filter, variable } = actions;
        return (
          <div key={key} className="span-kv__row">
            <dt>{key}</dt>
            <dd>
              <span className="span-kv__value">{text}</span>
              <span className="span-kv__actions">
                {filter === undefined ? null : (
                  <IconButton
                    className="span-kv__action"
                    icon="filter"
                    label={t("traces.filterBy", { key })}
                    onClick={() => filter(key, text)}
                  />
                )}
                {variable === undefined ? null : (
                  <IconButton
                    className="span-kv__action"
                    icon="pin"
                    label={t("panels.variable.setTo", { name: variable.name, value: text })}
                    onClick={() => variable.set(text)}
                  />
                )}
                <IconButton
                  className="span-kv__action"
                  icon="copy"
                  label={t("traces.copy", { key })}
                  onClick={() =>
                    void writeClipboard(text).then((done) => {
                      if (done) showToast({ message: t("access.copied") });
                    })
                  }
                />
              </span>
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

function Events({ span }: { span: Span }) {
  const { t, language } = useI18n();
  if (span.events.length === 0) {
    return <p className="span-detail__empty">{t("traces.none")}</p>;
  }
  return (
    <>
      {span.events.map((event, index) => {
        const { "exception.stacktrace": stack, ...rest } = event.attributes;
        const lines = typeof stack === "string" ? stack.split("\n").length : 0;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: events have no id; their order is fixed
          <div key={index} className="span-event">
            <div className="span-event__head">
              <span>{event.name}</span>
              <span className="span-event__at">
                +{formatDuration(event.time - span.start, language)}
              </span>
            </div>
            {Object.keys(rest).length === 0 ? null : (
              <KeyValues values={rest} actions={{}} empty="" />
            )}
            {typeof stack === "string" ? (
              <details className="span-stack">
                <summary>{t("traces.stack", { lines })}</summary>
                <pre>{stack}</pre>
              </details>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function Links({ span, actions }: { span: Span; actions: SpanActions }) {
  const { t } = useI18n();
  if (span.links.length === 0) {
    return <p className="span-detail__empty">{t("traces.none")}</p>;
  }
  return (
    <>
      {span.links.map((link) => {
        const { openTrace } = actions;
        const other = link.traceId !== span.traceId;
        return (
          <div key={`${link.traceId}:${link.spanId}`} className="span-link">
            <dl className="trace-facts">
              <div>
                <dt>{t("analysis.shape.trace")}</dt>
                <dd className="trace-mono">{link.traceId}</dd>
              </div>
              <div>
                <dt>{t("traces.span")}</dt>
                <dd className="trace-mono">{link.spanId}</dd>
              </div>
            </dl>
            {Object.keys(link.attributes).length === 0 ? null : (
              <KeyValues values={link.attributes} actions={{}} empty="" />
            )}
            {other && openTrace !== undefined ? (
              <div>
                <button
                  type="button"
                  className="button button--secondary button--small"
                  onClick={() => openTrace(link.traceId)}
                >
                  <Icon name="external" />
                  {t("traces.openLinked")}
                </button>
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
