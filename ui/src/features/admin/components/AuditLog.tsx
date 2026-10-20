import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { type Language, useI18n } from "../../../i18n/i18n";
import { type AuditEvent, type AuditFilter, adminKeys, listAudit } from "../api";
import { auditActionLabel, knownAuditActions } from "../catalog";
import { endOfDay, formatDateTime, formatValue, startOfDay } from "./format";
import { useRowKeys } from "./rows";
import { LoadState } from "./Section";

export interface ActorOption {
  id: string;
  label: string;
}

interface FilterInput {
  actor: string;
  action: string;
  from: string;
  to: string;
}

const NO_FILTER: FilterInput = { actor: "", action: "", from: "", to: "" };

function toFilter(input: FilterInput): AuditFilter {
  return {
    actor: input.actor === "" ? undefined : input.actor,
    action: input.action === "" ? undefined : input.action,
    from: startOfDay(input.from),
    to: endOfDay(input.to),
  };
}

/**
 * The audit log of an organization, or of the server when `orgId` is null: newest first, filtered
 * by who, what and when, one page at a time. Filters apply as they change.
 */
export function AuditLog({
  orgId,
  actors,
}: {
  orgId: string | null;
  /** People to filter by; without them the actor filter is not offered. */
  actors: readonly ActorOption[] | undefined;
}) {
  const { t, language } = useI18n();
  const ids = { actor: useId(), action: useId(), from: useId(), to: useId() };
  const [input, setInput] = useState<FilterInput>(NO_FILTER);
  // Cursors of the pages before the current one; the last entry is the current page's cursor.
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const filter = toFilter(input);
  const cursor = cursors.at(-1);
  const page = useQuery({
    queryKey: [...adminKeys.audit(orgId, filter), cursor ?? ""],
    queryFn: () => listAudit(orgId, filter, cursor),
    placeholderData: keepPreviousData,
  });
  const events = page.data?.items ?? [];
  const keys = useRowKeys(events.length);
  const actions = knownAuditActions();

  function change(field: keyof FilterInput, value: string) {
    setInput({ ...input, [field]: value });
    setCursors([undefined]);
  }

  return (
    <div className="admin-audit">
      {/* biome-ignore lint/a11y/useSemanticElements: jsdom, which the tests run in, does not know the search element yet; the role gives the same landmark. */}
      <div role="search" className="admin-filters" aria-label={t("admin.audit.filters")}>
        {actors === undefined ? null : (
          <div className="field">
            <label className="field__label" htmlFor={ids.actor}>
              {t("admin.audit.actor")}
            </label>
            <select
              id={ids.actor}
              className="select"
              value={input.actor}
              onChange={(event) => change("actor", event.currentTarget.value)}
            >
              <option value="">{t("admin.audit.anyone")}</option>
              {actors.map((actor) => (
                <option key={actor.id} value={actor.id}>
                  {actor.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="field">
          <label className="field__label" htmlFor={ids.action}>
            {t("admin.audit.action")}
          </label>
          <select
            id={ids.action}
            className="select"
            value={input.action}
            onChange={(event) => change("action", event.currentTarget.value)}
          >
            <option value="">{t("admin.audit.anyAction")}</option>
            {actions.map((action) => (
              <option key={action} value={action}>
                {auditActionLabel(t, action)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field__label" htmlFor={ids.from}>
            {t("admin.audit.from")}
          </label>
          <input
            id={ids.from}
            type="date"
            className="input"
            value={input.from}
            onChange={(event) => change("from", event.currentTarget.value)}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor={ids.to}>
            {t("admin.audit.to")}
          </label>
          <input
            id={ids.to}
            type="date"
            className="input"
            value={input.to}
            onChange={(event) => change("to", event.currentTarget.value)}
          />
        </div>
      </div>

      {page.data === undefined ? (
        <LoadState error={page.error} onRetry={() => void page.refetch()} />
      ) : events.length === 0 ? (
        <p className="admin-empty">{t("admin.audit.empty")}</p>
      ) : (
        <ul className="admin-list" aria-label={t("admin.audit.events")} {...keys.listProps}>
          {events.map((event, index) => (
            <li key={event.id} className="admin-row admin-row--audit" {...keys.rowProps(index)}>
              <AuditRow event={event} showOrg={orgId === null} language={language} />
            </li>
          ))}
        </ul>
      )}

      <div className="admin-pager">
        <button
          type="button"
          className="button button--secondary"
          disabled={cursors.length <= 1}
          onClick={() => setCursors(cursors.slice(0, -1))}
        >
          {t("admin.audit.newer")}
        </button>
        <button
          type="button"
          className="button button--secondary"
          disabled={page.data?.nextCursor === null || page.data === undefined}
          onClick={() => {
            const next = page.data?.nextCursor;
            if (next !== null && next !== undefined) {
              setCursors([...cursors, next]);
            }
          }}
        >
          {t("admin.audit.older")}
        </button>
      </div>
    </div>
  );
}

function AuditRow({
  event,
  showOrg,
  language,
}: {
  event: AuditEvent;
  showOrg: boolean;
  language: Language;
}) {
  const { t } = useI18n();
  const actor = event.actorName ?? event.actorUserId ?? t("admin.audit.system");
  const resource =
    event.resourceType === null ? null : `${event.resourceType} ${event.resourceId ?? ""}`.trim();
  return (
    <>
      <div className="admin-row__main">
        <span className="admin-row__title" title={event.action}>
          {auditActionLabel(t, event.action)}
        </span>
        <span className="admin-row__meta">
          {event.actorAddress === null
            ? actor
            : t("admin.audit.actorFrom", { name: actor, address: event.actorAddress })}
        </span>
      </div>
      <div className="admin-row__detail">
        {resource === null ? null : <code className="admin-row__meta">{resource}</code>}
        {event.summary === null || event.summary === undefined || event.summary === "" ? null : (
          <span className="admin-row__meta">{formatValue(event.summary)}</span>
        )}
        {showOrg && event.orgId !== null && event.orgId !== undefined ? (
          <span className="admin-row__meta">{t("admin.serverAudit.org", { id: event.orgId })}</span>
        ) : null}
      </div>
      <time className="admin-row__meta" dateTime={new Date(event.createdAt).toISOString()}>
        {formatDateTime(event.createdAt, language)}
      </time>
    </>
  );
}
