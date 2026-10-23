import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { type Language, useI18n } from "../../../i18n/i18n";
import { type AuditEvent, type AuditFilter, adminKeys, listAudit } from "../api";
import { AUDIT_AREAS, auditActionLabel, knownAuditActions } from "../catalog";
import { formatDateTime, formatSummary, startOfDay, startOfNextDay } from "./format";
import { PagedSelect, type PickerOption } from "./PagedSelect";
import { useRowKeys } from "./rows";
import { LoadState } from "./Section";
import "../admin.css";

/** A list to filter by (people, organizations), loaded page by page. */
export interface PickerSource {
  options: readonly PickerOption[] | undefined;
  error: unknown;
  onRetry: () => void;
  hasMore: boolean;
  onMore: () => void;
  loadingMore: boolean;
}

interface FilterInput {
  actor: string;
  action: string;
  from: string;
  to: string;
  orgId: string;
}

const NO_FILTER: FilterInput = { actor: "", action: "", from: "", to: "", orgId: "" };

/** The day filter covers whole days in the user's time zone. */
function toFilter(input: FilterInput, zone: string | null): AuditFilter {
  return {
    actor: input.actor === "" ? undefined : input.actor,
    action: input.action === "" ? undefined : input.action,
    from: startOfDay(input.from, zone),
    to: startOfNextDay(input.to, zone),
    orgId: input.orgId === "" ? undefined : input.orgId,
  };
}

/**
 * The audit log of an organization, or of the server when `orgId` is null: newest first, filtered
 * by who, what (one action or a whole area, the server filters by prefix) and when, one page at a
 * time. Filters apply as they change.
 */
export function AuditLog({
  orgId,
  actors,
  orgs,
}: {
  orgId: string | null;
  /** People to filter by; without them the person filter is not offered. */
  actors: PickerSource | undefined;
  /** Server audit log: organizations to narrow it to. */
  orgs?: PickerSource | undefined;
}) {
  const { t, language, timeZone } = useI18n();
  const ids = { actor: useId(), action: useId(), from: useId(), to: useId(), org: useId() };
  const [input, setInput] = useState<FilterInput>(NO_FILTER);
  // Cursors of the pages before the current one; the last entry is the current page's cursor.
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const filter = toFilter(input, timeZone);
  const backwards =
    filter.from !== undefined && filter.to !== undefined && filter.from >= filter.to;
  const cursor = cursors.at(-1);
  const page = useQuery({
    queryKey: [...adminKeys.audit(orgId, filter), cursor ?? ""],
    queryFn: () => listAudit(orgId, filter, cursor),
    placeholderData: keepPreviousData,
    enabled: !backwards,
  });
  const events = page.data?.items ?? [];
  const keys = useRowKeys(events.length);
  const actions = knownAuditActions();

  function change(field: keyof FilterInput, value: string) {
    setInput({ ...input, [field]: value });
    setCursors([undefined]);
  }

  const toErrorId = `${ids.to}-error`;
  return (
    <div className="admin-audit">
      {/* biome-ignore lint/a11y/useSemanticElements: jsdom, which the tests run in, does not know the search element yet; the role gives the same landmark. */}
      <div role="search" className="admin-filters" aria-label={t("admin.audit.filters")}>
        {actors === undefined ? null : (
          <div className="field">
            <label className="field__label" htmlFor={ids.actor}>
              {t("admin.audit.actor")}
            </label>
            <PagedSelect
              id={ids.actor}
              value={input.actor}
              onChange={(value) => change("actor", value)}
              anyLabel={t("admin.audit.anyone")}
              {...actors}
            />
          </div>
        )}
        {orgs === undefined ? null : (
          <div className="field">
            <label className="field__label" htmlFor={ids.org}>
              {t("admin.serverAudit.orgFilter")}
            </label>
            <PagedSelect
              id={ids.org}
              value={input.orgId}
              onChange={(value) => change("orgId", value)}
              anyLabel={t("admin.serverAudit.anyOrg")}
              {...orgs}
            />
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
            <optgroup label={t("admin.audit.areas")}>
              {Object.entries(AUDIT_AREAS).map(([prefix, label]) => (
                <option key={prefix} value={prefix}>
                  {t(label)}
                </option>
              ))}
            </optgroup>
            <optgroup label={t("admin.audit.actions")}>
              {actions.map((action) => (
                <option key={action} value={action}>
                  {auditActionLabel(t, action)}
                </option>
              ))}
            </optgroup>
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
            aria-invalid={backwards ? true : undefined}
            aria-describedby={backwards ? toErrorId : undefined}
            onChange={(event) => change("to", event.currentTarget.value)}
          />
          {backwards ? (
            <p className="field__error" id={toErrorId}>
              {t("admin.audit.toBeforeFrom")}
            </p>
          ) : null}
        </div>
      </div>

      {backwards ? null : page.data === undefined ? (
        <LoadState error={page.error} onRetry={() => void page.refetch()} />
      ) : events.length === 0 ? (
        <p className="admin-empty">{t("admin.audit.empty")}</p>
      ) : (
        <ul className="admin-list" aria-label={t("admin.audit.events")} {...keys.listProps}>
          {events.map((event, index) => (
            <li key={event.id} className="admin-row admin-row--audit" {...keys.rowProps(index)}>
              <AuditRow
                event={event}
                orgName={
                  orgId === null
                    ? (id) => orgs?.options?.find((option) => option.id === id)?.label ?? id
                    : undefined
                }
                language={language}
              />
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
          disabled={backwards || page.data?.nextCursor === null || page.data === undefined}
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
  orgName,
  language,
}: {
  event: AuditEvent;
  /** Server audit log: the name of an event's organization. */
  orgName: ((id: string) => string) | undefined;
  language: Language;
}) {
  const { t, timeZone } = useI18n();
  const actor = event.actorName ?? event.actorUserId ?? t("admin.audit.system");
  const resource =
    event.resourceType === null
      ? null
      : t("admin.audit.resource", { type: event.resourceType, id: event.resourceId ?? "" }).trim();
  const summary = formatSummary(event.summary);
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
        {resource === null ? null : <span className="admin-row__meta">{resource}</span>}
        {summary === "" ? null : <span className="admin-row__meta">{summary}</span>}
        {orgName !== undefined && event.orgId !== null ? (
          <span className="admin-row__meta">
            {t("admin.serverAudit.org", { name: orgName(event.orgId) })}
          </span>
        ) : null}
      </div>
      <time className="admin-row__meta" dateTime={new Date(event.createdAt).toISOString()}>
        {formatDateTime(event.createdAt, language, timeZone)}
      </time>
    </>
  );
}
