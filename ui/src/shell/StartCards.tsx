import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useId } from "react";
import { FormAlert } from "../components/FormAlert";
import type { AuditEvent } from "../features/admin/api";
import { auditActionLabel } from "../features/admin/catalog";
import { getUpdates, updateKeys } from "../features/admin/server/updatesApi";
import { type SourceStatusItem, sourceStatusQuery } from "../features/datasources/api";
import { SLOW_MS } from "../features/datasources/sourceStatus";
import { hasMessage, type Translate, useI18n } from "../i18n/i18n";
import { apiErrorText } from "./shellErrors";
import "./shellUx.css";

/*
 * The two cards at the bottom of the start page (Start board): the stored status of the data
 * sources and the hints that ask for a look. Both read what the server keeps; no connection test
 * runs from here.
 */

/** Sources listed in the status card, problems first. */
export const STATUS_ROWS = 6;

/** Hints listed at most. */
export const HINT_ROWS = 5;

/** The status of a source from its last stored test. */
export type StoredStatus = "unreachable" | "slow" | "connected" | "untested";

const STATUS_ORDER: Record<StoredStatus, number> = {
  unreachable: 0,
  slow: 1,
  connected: 2,
  untested: 3,
};

export function storedStatus(item: SourceStatusItem): StoredStatus {
  const test = item.lastTest;
  if (test === undefined) {
    return "untested";
  }
  if (!test.ok) {
    return "unreachable";
  }
  return test.latencyMs !== undefined && test.latencyMs >= SLOW_MS ? "slow" : "connected";
}

/** The rows of the status card: problems first, then by name. */
export function statusRows(items: readonly SourceStatusItem[], locale: string): SourceStatusItem[] {
  const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
  return [...items]
    .sort(
      (a, b) =>
        STATUS_ORDER[storedStatus(a)] - STATUS_ORDER[storedStatus(b)] ||
        collator.compare(a.name, b.name),
    )
    .slice(0, STATUS_ROWS);
}

type SinceUnit = "week" | "day" | "hour" | "minute";

const UNITS: readonly (readonly [SinceUnit, number])[] = [
  ["week", 7 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** "1 Woche", "3 Tagen": how long, in the largest whole unit, at least a minute. */
export function sinceText(t: Translate, language: string, ms: number): string {
  const [unit, size] = UNITS.find(([, size]) => ms >= size) ?? ["minute", 60_000];
  const count = Math.max(1, Math.floor(ms / size));
  const form = new Intl.PluralRules(language).select(count) === "one" ? "one" : "other";
  return t(`shell.start.since.${unit}.${form}`, { count: String(count) });
}

/** The data sources' stored status: a dot, the name, and the latency or what is wrong. */
export function SourceStatusCard({ orgId }: { orgId: string }) {
  const { t, language } = useI18n();
  const titleId = useId();
  const status = useQuery(sourceStatusQuery(orgId));
  let body: ReactNode;
  if (status.isPending) {
    body = <p className="loading">{t("common.loading")}</p>;
  } else if (status.data === undefined) {
    body = <FormAlert>{apiErrorText(t, status.error)}</FormAlert>;
  } else if (status.data.length === 0) {
    body = <p className="start__muted">{t("shell.start.sources.empty")}</p>;
  } else {
    body = (
      <ul className="start__sources">
        {statusRows(status.data, language).map((item) => {
          const state = storedStatus(item);
          const latency = item.lastTest?.latencyMs;
          let detail: string;
          if (state === "unreachable") {
            detail = t("shell.start.sources.unreachable");
          } else if (state === "untested") {
            detail = t("shell.start.sources.untested");
          } else if (latency === undefined) {
            detail = t(`datasources.status.${state}`);
          } else {
            detail = t("datasources.status.ms", { ms: Math.round(latency) });
          }
          return (
            <li key={item.id} className="start__source" data-status={state}>
              <span className="start__source-dot" aria-hidden="true" />
              <span className="truncate" title={item.name}>
                {item.name}
              </span>
              {state === "connected" || state === "slow" ? (
                <span className="visually-hidden">{t(`datasources.status.${state}`)}</span>
              ) : null}
              <span className="start__source-detail">{detail}</span>
            </li>
          );
        })}
      </ul>
    );
  }
  return (
    <section className="start__section" aria-labelledby={titleId}>
      <h2 id={titleId} className="start__title">
        {t("shell.start.sources")}
      </h2>
      {body}
    </section>
  );
}

interface Hint {
  key: string;
  text: string;
  link?: ReactNode;
}

/**
 * What asks for a look: a newer version (server administrators), sources that fail their tests,
 * and sources nothing uses (for who may change them).
 */
export function HintsCard({
  orgId,
  sources,
  updates,
}: {
  orgId: string;
  /** Whether the caller sees data sources at all. */
  sources: boolean;
  /** Whether the caller administers the server (and so its updates). */
  updates: boolean;
}) {
  const { t, language } = useI18n();
  const titleId = useId();
  const status = useQuery({ ...sourceStatusQuery(orgId), enabled: sources });
  const update = useQuery({
    queryKey: updateKeys.status,
    queryFn: getUpdates,
    enabled: updates,
    staleTime: 5 * 60_000,
  });
  const hints: Hint[] = [];
  const available = update.data?.available;
  if (available !== undefined && available !== null && available.version !== update.data?.skipped) {
    hints.push({
      key: "update",
      text: t("shell.start.hints.update", { version: available.version }),
      link: (
        <Link to="/admin/server/updates" className="start__hint-link">
          {t("shell.start.hints.updateLink")}
        </Link>
      ),
    });
  }
  const now = Date.now();
  for (const item of status.data ?? []) {
    if (item.lastTest !== undefined && !item.lastTest.ok) {
      const since = item.lastTest.failingSince;
      hints.push({
        key: `down:${item.id}`,
        text:
          since === undefined
            ? t("shell.start.hints.down", { name: item.name })
            : t("shell.start.hints.downSince", {
                name: item.name,
                since: sinceText(t, language, Math.max(0, now - since)),
              }),
        link: (
          <Link
            to="/data-sources/$datasourceId"
            params={{ datasourceId: item.id }}
            className="start__hint-link"
          >
            {t("shell.start.hints.check")}
          </Link>
        ),
      });
    }
  }
  for (const item of status.data ?? []) {
    if (item.unused === true) {
      hints.push({
        key: `unused:${item.id}`,
        text: t("shell.start.hints.unused", { name: item.name }),
      });
    }
  }
  const loading = (sources && status.isPending) || (updates && update.isPending);
  let body: ReactNode;
  if (hints.length > 0) {
    body = (
      <ul className="start__hints">
        {hints.slice(0, HINT_ROWS).map((hint) => (
          <li key={hint.key} className="start__hint">
            <span>{hint.text}</span>
            {hint.link}
          </li>
        ))}
      </ul>
    );
  } else if (loading) {
    body = <p className="loading">{t("common.loading")}</p>;
  } else {
    body = <p className="start__muted">{t("shell.start.hints.none")}</p>;
  }
  return (
    <section className="start__section" aria-labelledby={titleId}>
      <h2 id={titleId} className="start__title">
        {t("shell.start.hints")}
      </h2>
      {body}
    </section>
  );
}

/**
 * One change as a sentence: who did what to which resource ("Lea hat „Sales“ gespeichert"), where
 * the action has a sentence and the server named the resource; otherwise who and the action.
 */
export function changeText(t: Translate, event: AuditEvent): string {
  const actor = event.actorName ?? t("shell.start.someone");
  const key = `shell.start.changeOf.${event.action}`;
  if (hasMessage(key)) {
    const needsTarget = t(key).includes("{target}");
    if (!needsTarget || event.resourceName !== undefined) {
      return t(key, { actor, target: event.resourceName ?? "" });
    }
  }
  return t("shell.start.change", { actor, action: auditActionLabel(t, event.action) });
}
