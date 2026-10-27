import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useId, useRef, useState } from "react";
import { useI18n } from "../../../i18n/i18n";
import {
  adminKeys,
  listMembers,
  listOrgSettings,
  MAX_PAGE_SIZE,
  type Setting,
  updateOrgSetting,
} from "../../admin/api";
import { settingText } from "../../admin/catalog";
import { LoadState } from "../../admin/components/Section";
import { ConflictDialog, useSettingChanges } from "../../admin/components/Settings";
import { datasourcesQuery } from "../../datasources/api";
import { KindMark } from "../../datasources/kindMarks";
import { resetSetting } from "../../settings/api";
import { type Changes, lockedBadge, RowFrame, SettingRow } from "../../settings/rows";
import { useFoundRow } from "../../settings/SectionPage";
import { useSettingsAccess } from "../../settings/SettingsLayout";
import { rowId, type SectionDef } from "../../settings/sections";
import { aiAdminKeys, fetchAiReadableSources } from "../adminApi";
import { aiErrorText } from "../reasons";
import { useAiStatusFor } from "../useAiStatus";
import { ProvidersCard } from "./ProvidersCard";
import { UsageCard } from "./UsageCard";
import "./ai-admin.css";

const INHERIT = "inherit";

/** The organization's limits: `inherit` or a lower number than the server's. */
const LIMIT_KEYS = [
  "ai.user_requests_per_day",
  "ai.user_tokens_per_day",
  "ai.org_tokens_per_month",
  "ai.chat_retention_days",
] as const;

/**
 * Administration > AI of the organization (board frame 5): whether members see AI, the
 * organization's own providers (when the server allows them), its lower limits, usage per member
 * and which data sources AI may read. Everyone with `settings:read` sees it; changes need
 * `settings:write`.
 */
export function AiOrgSection({ section }: { section: SectionDef }) {
  const { t } = useI18n();
  const access = useSettingsAccess();
  const orgId = access.orgId ?? "";
  const canWrite = access.permissions.has("settings:write");
  const queryKey = adminKeys.orgSettings(orgId);
  const settings = useQuery({
    queryKey,
    queryFn: () => listOrgSettings(orgId),
    enabled: orgId !== "",
  });
  // Whether the server allows own providers comes with the AI status, also while AI is off; a
  // refusal of a change (the setting changed meanwhile) says so too.
  const { status } = useAiStatusFor(orgId === "" ? undefined : orgId);
  const [refused, setRefused] = useState(false);
  const changes = useSettingChanges({
    queryKey,
    patch: (key, value, version) => updateOrgSetting(orgId, key, value, version),
    reset: (key, version) => resetSetting({ kind: "org", orgId }, key, version),
    reasonText: (error) => aiErrorText(t, error),
  });
  const members = useQuery({
    queryKey: [...adminKeys.members(orgId), "ai-names"],
    queryFn: () => listMembers(orgId, undefined, MAX_PAGE_SIZE),
    enabled: orgId !== "",
    retry: false,
  });
  const found = useFoundRow();
  if (settings.data === undefined) {
    return <LoadState error={settings.error} onRetry={() => void settings.refetch()} />;
  }
  const byKey = new Map(settings.data.map((setting) => [setting.key, setting]));
  const allowed = !refused && status?.orgProvidersAllowed !== false;
  const memberNames = new Map(
    (members.data?.items ?? []).map((member) => [member.userId, member.name || member.email]),
  );
  const enabledSetting = byKey.get("ai.org_enabled");
  const limitsId = `${section.id}-limits`;

  return (
    <div className="ai-admin">
      {enabledSetting === undefined ? null : (
        <section className="settings-card">
          <SettingRow
            setting={enabledSetting}
            rowId={rowId(section, "ai.org_enabled")}
            changes={changes}
            canWrite={canWrite}
            inheritable={false}
            found={found === rowId(section, "ai.org_enabled")}
          />
        </section>
      )}
      <ProvidersCard
        scope={{ kind: "org", orgId }}
        canWrite={canWrite}
        addAllowed={allowed}
        notAllowedText={t("ai.org.providers.notAllowed")}
        onNotAllowed={() => setRefused(true)}
      />
      <section className="settings-card" aria-labelledby={limitsId}>
        <div className="ai-card__head">
          <div className="ai-card__title">
            <h3 id={limitsId}>{t("ai.org.limits.title")}</h3>
            <p className="settings-hint">{t("ai.org.limits.lead")}</p>
          </div>
        </div>
        {LIMIT_KEYS.map((key) => {
          const setting = byKey.get(key);
          if (setting === undefined) {
            return null;
          }
          const id = rowId(section, key);
          return (
            <InheritNumberRow
              key={key}
              setting={setting}
              rowId={id}
              changes={changes}
              canWrite={canWrite}
              found={found === id}
            />
          );
        })}
      </section>
      <UsageCard
        scope={{ kind: "org", orgId }}
        who={t("ai.org.usage.member")}
        nameOf={(id) => memberNames.get(id) ?? id}
      />
      <ReadableSources orgId={orgId} />
      <ConflictDialog
        conflict={changes.conflict}
        onKeepStored={changes.keepStored}
        onOverwrite={changes.overwrite}
      />
    </div>
  );
}

/**
 * An organization's override of a server limit: "Like the server" or a number of its own, which
 * applies only where it is lower than the server's.
 */
function InheritNumberRow({
  setting,
  rowId: id,
  changes,
  canWrite,
  found,
}: {
  setting: Setting;
  rowId: string;
  changes: Changes;
  canWrite: boolean;
  found: boolean;
}) {
  const { t, language } = useI18n();
  const titleId = useId();
  const errorId = `${titleId}-error`;
  const inputRef = useRef<HTMLInputElement>(null);
  const text = settingText(t, setting);
  const badge = lockedBadge(t, setting, canWrite);
  const inherits = setting.value === INHERIT || typeof setting.value !== "number";
  const [own, setOwn] = useState(!inherits);
  const [draft, setDraft] = useState(inherits ? "" : String(setting.value));
  const [shown, setShown] = useState(setting.value);
  const [local, setLocal] = useState<string | undefined>(undefined);
  if (shown !== setting.value) {
    setShown(setting.value);
    setOwn(!inherits);
    setDraft(inherits ? "" : String(setting.value));
    setLocal(undefined);
  }
  const rejected = changes.rejected?.key === setting.key ? changes.rejected.message : undefined;
  const error = local ?? rejected;
  const labelled = {
    "aria-labelledby": titleId,
    "aria-describedby":
      error === undefined ? `${titleId}-description` : `${errorId} ${titleId}-description`,
  };

  function commit() {
    const value = Number(draft);
    if (draft.trim() === "" || !Number.isInteger(value) || value < 0) {
      setLocal(t("ai.org.limits.invalid"));
      return;
    }
    setLocal(undefined);
    if (value !== setting.value) {
      changes.apply(setting, value);
    }
  }

  let control: ReactNode;
  if (badge !== undefined) {
    control = (
      <output className="settings-value" aria-labelledby={titleId}>
        {inherits
          ? t("settings.inherit")
          : new Intl.NumberFormat(language).format(Number(setting.value))}
      </output>
    );
  } else {
    control = (
      <>
        <select
          className="select settings-select"
          value={own ? "own" : INHERIT}
          {...labelled}
          onChange={(event) => {
            if (event.currentTarget.value === INHERIT) {
              setOwn(false);
              setLocal(undefined);
              if (setting.value !== INHERIT) {
                changes.apply(setting, INHERIT);
              }
            } else {
              setOwn(true);
              queueMicrotask(() => inputRef.current?.focus());
            }
          }}
        >
          <option value={INHERIT}>{t("settings.inherit")}</option>
          <option value="own">{t("ai.org.limits.own")}</option>
        </select>
        {own ? (
          <input
            ref={inputRef}
            className="input settings-input settings-input--number"
            type="number"
            min={0}
            step={1}
            value={draft}
            aria-label={t("ai.org.limits.valueFor", { name: text.label ?? setting.key })}
            aria-invalid={error === undefined ? undefined : true}
            aria-describedby={error === undefined ? undefined : errorId}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                commit();
              }
            }}
          />
        ) : null}
      </>
    );
  }
  return (
    <RowFrame
      id={id}
      title={text.label ?? setting.key}
      titleId={titleId}
      description={text.description}
      badge={badge}
      error={error}
      errorId={errorId}
      found={found}
    >
      {control}
    </RowFrame>
  );
}

/**
 * "What AI may read" (board frame 5): the organization's data sources, each open to AI or not,
 * with the way to the source's AI settings, where whoever may edit it opens or closes it.
 */
function ReadableSources({ orgId }: { orgId: string }) {
  const { t } = useI18n();
  const titleId = useId();
  const sources = useQuery({ ...datasourcesQuery(orgId), enabled: orgId !== "" });
  const readable = useQuery({
    queryKey: aiAdminKeys.readable(orgId),
    queryFn: ({ signal }) => fetchAiReadableSources(orgId, signal),
    enabled: orgId !== "",
  });
  const open = new Set(readable.data ?? []);
  const loaded = sources.data !== undefined && readable.data !== undefined;
  return (
    <section className="settings-card" aria-labelledby={titleId}>
      <div className="ai-card__head">
        <div className="ai-card__title">
          <h3 id={titleId}>{t("ai.org.sources.title")}</h3>
          <p className="settings-hint">{t("ai.org.sources.lead")}</p>
        </div>
      </div>
      {!loaded ? (
        <div className="ai-card__body">
          <LoadState
            error={sources.error ?? readable.error}
            onRetry={() => {
              void sources.refetch();
              void readable.refetch();
            }}
          />
        </div>
      ) : sources.data.length === 0 ? (
        <p className="ai-card__body settings-hint">{t("ai.org.sources.none")}</p>
      ) : (
        <div className="ai-table-wrap">
          <table className="ai-table">
            <thead>
              <tr>
                <th scope="col">{t("ai.org.sources.source")}</th>
                <th scope="col">{t("ai.org.sources.state")}</th>
                <th scope="col">
                  <span className="visually-hidden">{t("ai.admin.providers.actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {sources.data.map((source) => (
                <tr key={source.id}>
                  <td>
                    <span className="ai-table__name">
                      <KindMark kind={source.kind} small />
                      <span>{source.name}</span>
                    </span>
                  </td>
                  <td className={open.has(source.id) ? undefined : "ai-muted"}>
                    {open.has(source.id) ? t("ai.org.sources.open") : t("ai.org.sources.closed")}
                  </td>
                  <td className="ai-table__actions">
                    <Link
                      to="/data-sources/$datasourceId"
                      params={{ datasourceId: source.id }}
                      hash="ai"
                      className="button button--ghost button--small"
                      aria-label={t("ai.org.sources.settingsNamed", { name: source.name })}
                    >
                      {t("ai.org.sources.settings")}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
