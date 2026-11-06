import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useId } from "react";
import { Icon } from "../../../components/Icon";
import { type Translate, useI18n } from "../../../i18n/i18n";
import {
  adminKeys,
  isLockedSetting,
  listOrgs,
  listServerSettings,
  MAX_PAGE_SIZE,
  type Setting,
  updateServerSetting,
} from "../../admin/api";
import { LoadState } from "../../admin/components/Section";
import { ConflictDialog, useSettingChanges } from "../../admin/components/Settings";
import { resetSetting } from "../../settings/api";
import { type Changes, type Choice, SettingRow } from "../../settings/rows";
import { useFoundRow } from "../../settings/SectionPage";
import { rowId, type SectionDef } from "../../settings/sections";
import {
  type AiOverview,
  type AiProvider,
  aiAdminKeys,
  fetchAiOverview,
  providerHost,
} from "../adminApi";
import { aiErrorText } from "../reasons";
import { PrivacyNotice } from "./PrivacyNotice";
import { isReady, ProvidersCard, useAiProviders } from "./ProvidersCard";
import { todayOf, UsageCard, useAiUsage } from "./UsageCard";
import "./ai-admin.css";

const LIMIT_KEYS = [
  "ai.user_requests_per_day",
  "ai.user_tokens_per_day",
  "ai.org_tokens_per_month",
  "ai.max_rows_to_model",
  "ai.max_tool_calls",
  "ai.max_concurrent",
  "ai.max_concurrent_per_org",
  "ai.max_concurrent_per_user",
  "ai.request_timeout_secs",
] as const;

/** The provider chosen per function (board frame 2, "Welcher Anbieter wofür"). */
const FUNCTION_KEYS = ["ai.provider_explain", "ai.provider_summarize", "ai.provider_chat"] as const;

const FUNCTION_LABELS = {
  "ai.provider_explain": "ai.admin.status.fnExplain",
  "ai.provider_summarize": "ai.admin.status.fnSummarize",
  "ai.provider_chat": "ai.admin.status.fnChat",
} as const;

/** A card of setting rows with an optional heading. */
export function RowsCard({
  title,
  lead,
  keys,
  byKey,
  section,
  changes,
  canWrite,
  found,
  choicesFor,
  children,
}: {
  /** Choices from data for some keys (the providers for a function). */
  choicesFor?: (key: string) => Choice[] | undefined;
  title?: string;
  lead?: string;
  keys: readonly string[];
  byKey: Map<string, Setting>;
  section: SectionDef;
  changes: Changes;
  canWrite: boolean;
  found: string | null;
  /** Shown below the rows (the organizations' list). */
  children?: ReactNode;
}) {
  const titleId = useId();
  return (
    <section
      className="settings-card"
      {...(title === undefined ? {} : { "aria-labelledby": titleId })}
    >
      {title === undefined ? null : (
        <div className="ai-card__head">
          <div className="ai-card__title">
            <h3 id={titleId}>{title}</h3>
            {lead === undefined ? null : <p className="settings-hint">{lead}</p>}
          </div>
        </div>
      )}
      {keys.map((key) => {
        const setting = byKey.get(key);
        if (setting === undefined) {
          return null;
        }
        const id = rowId(section, key);
        return (
          <SettingRow
            key={key}
            setting={setting}
            rowId={id}
            changes={changes}
            canWrite={canWrite}
            inheritable={false}
            found={found === id}
            choices={choicesFor?.(key)}
          />
        );
      })}
      {children}
    </section>
  );
}

/** The provider each function goes to: the one chosen for it, else the default. */
function functionProviders(
  byKey: Map<string, Setting>,
  list: readonly AiProvider[],
): { key: (typeof FUNCTION_KEYS)[number]; provider: AiProvider | undefined }[] {
  const fallback = list.find((provider) => provider.isDefault);
  return FUNCTION_KEYS.map((key) => {
    const chosen = byKey.get(key)?.value;
    const provider =
      typeof chosen === "string" && chosen !== ""
        ? (list.find((p) => p.id === chosen) ?? fallback)
        : fallback;
    return { key, provider };
  });
}

/**
 * "Daten verlassen den Server" in the status strip: no, yes for all functions, or only for some,
 * with the hosts the data goes to.
 */
function leavesCell(
  t: Translate,
  byKey: Map<string, Setting>,
  list: readonly AiProvider[],
): { value: string; sub: string | undefined } {
  const used = functionProviders(byKey, list).filter((entry) => entry.provider !== undefined);
  const leaving = used.filter((entry) => entry.provider?.leavesOwnNetwork === true);
  if (used.length === 0 || leaving.length === 0) {
    return { value: t("ai.admin.status.leavesNo"), sub: t("ai.admin.status.leavesNoSub") };
  }
  const hosts = [
    ...new Set(leaving.map((entry) => providerHost(entry.provider?.baseUrl ?? ""))),
  ].join(", ");
  const sub = t("ai.admin.status.leavesTo", { hosts });
  if (leaving.length === used.length) {
    return { value: t("ai.admin.status.leavesAll"), sub };
  }
  const names = leaving.map((entry) => t(FUNCTION_LABELS[entry.key])).join(", ");
  return { value: t("ai.admin.status.leavesOnly", { functions: names }), sub };
}

/** The switch inside the status strip while AI is on, with since when and by whom. */
function StripSwitch({
  setting,
  changes,
  overview,
}: {
  setting: Setting;
  changes: Changes;
  overview: AiOverview | undefined;
}) {
  const { t, language } = useI18n();
  const labelId = useId();
  const locked = isLockedSetting(setting);
  const enabled = setting.value === true;
  const error = changes.rejected?.key === setting.key ? changes.rejected.message : undefined;
  const date = new Intl.DateTimeFormat(language, { day: "2-digit", month: "2-digit" });
  const since =
    overview?.switchedAt === undefined
      ? undefined
      : overview.switchedBy === undefined
        ? t("ai.admin.status.since", { date: date.format(overview.switchedAt) })
        : t("ai.admin.status.sinceBy", {
            date: date.format(overview.switchedAt),
            name: overview.switchedBy,
          });
  return (
    <div className="ai-status__cell">
      <span className="ai-status__label" id={labelId}>
        {t("ai.admin.status.ai")}
      </span>
      <span className="ai-status__switch">
        <input
          type="checkbox"
          role="switch"
          className="settings-switch"
          checked={enabled}
          aria-checked={enabled}
          aria-labelledby={labelId}
          disabled={locked || changes.pending}
          onChange={() => changes.apply(setting, !enabled)}
        />
        <span className="ai-status__value">
          {enabled ? t("ai.admin.status.on") : t("ai.admin.status.off")}
        </span>
      </span>
      {since === undefined ? null : <span className="ai-status__sub">{since}</span>}
      {error === undefined ? null : (
        <span className="field__error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** Each organization: AI off there, its own provider, or the server's. */
function OrgList({
  overview,
  ownAllowed,
}: {
  overview: AiOverview | undefined;
  ownAllowed: boolean;
}) {
  const { t } = useI18n();
  if (overview === undefined || overview.orgs.length === 0) {
    return null;
  }
  return (
    <>
      <ul className="ai-orgs" aria-label={t("ai.admin.orgs.list")}>
        {overview.orgs.map((org) => (
          <li key={org.id} className="ai-orgs__row">
            <span className="ai-orgs__name truncate" title={org.name}>
              {org.name}
            </span>
            <span className="ai-muted ai-small">
              {!org.enabled
                ? t("ai.admin.orgs.off")
                : org.provider !== undefined && ownAllowed
                  ? t("ai.admin.orgs.own", { name: org.provider.name })
                  : t("ai.admin.orgs.server")}
            </span>
          </li>
        ))}
      </ul>
      {overview.moreOrgs ? (
        <p className="ai-card__body ai-muted ai-small">{t("ai.admin.orgs.more")}</p>
      ) : null}
    </>
  );
}

/**
 * Administration > AI for server administrators (board frames 1 to 4 and 7): the switch, and
 * while AI is on the status strip with the switch inside; the providers, which provider each
 * function uses next to the organizations, the limits, usage, chat retention and the notice of
 * what leaves the server. Settings apply at once with undo; a refused switch says why.
 */
export function AiServerSection({ section }: { section: SectionDef }) {
  const { t, language } = useI18n();
  const queryKey = adminKeys.serverSettings;
  const settings = useQuery({ queryKey, queryFn: listServerSettings });
  const changes = useSettingChanges({
    queryKey,
    patch: (key, value, version) => updateServerSetting(key, value, version),
    reset: (key, version) => resetSetting({ kind: "server" }, key, version),
    reasonText: (error) => aiErrorText(t, error),
  });
  const providers = useAiProviders({ kind: "server" });
  const today = useAiUsage({ kind: "server" }, 1);
  const orgs = useQuery({
    queryKey: [...adminKeys.orgs, "ai-names"],
    queryFn: () => listOrgs(undefined, MAX_PAGE_SIZE),
  });
  const overview = useQuery({
    queryKey: [
      ...aiAdminKeys.overview,
      settings.data?.find((s) => s.key === "ai.enabled")?.version,
    ],
    queryFn: ({ signal }) => fetchAiOverview(signal),
  });
  const found = useFoundRow();
  if (settings.data === undefined) {
    return <LoadState error={settings.error} onRetry={() => void settings.refetch()} />;
  }
  const byKey = new Map(settings.data.map((setting) => [setting.key, setting]));
  const enabled = byKey.get("ai.enabled")?.value === true;
  const list = providers.data ?? [];
  const ready = list.filter(isReady);
  const failing = list.filter((provider) => provider.lastTest?.ok === false);
  const fallback = list.find((provider) => provider.isDefault);
  const number = new Intl.NumberFormat(language);
  const usageToday = todayOf(today.data ?? []);
  const maxRows = byKey.get("ai.max_rows_to_model")?.value;
  const orgNames = new Map((orgs.data?.items ?? []).map((org) => [org.id, org.name]));
  const enabledSetting = byKey.get("ai.enabled");
  const rowProps = { byKey, section, changes, canWrite: true, found };
  const leaves = leavesCell(t, byKey, list);

  return (
    <div className="ai-admin">
      <div className="ai-admin__links">
        <Link
          to="/admin/server/audit"
          search={{ action: "ai." }}
          className="button button--ghost button--small"
        >
          <Icon name="history" />
          {t("ai.admin.auditLink")}
        </Link>
      </div>
      {enabled && enabledSetting !== undefined ? (
        <section className="ai-status" aria-label={t("ai.admin.status.label")}>
          <StripSwitch setting={enabledSetting} changes={changes} overview={overview.data} />
          <div className="ai-status__cell">
            <span className="ai-status__label">{t("ai.admin.status.providers")}</span>
            <span className="ai-status__value">
              {t("ai.admin.status.providersReady", { ready: ready.length, total: list.length })}
            </span>
            {failing.length === 0 ? null : (
              <span className="ai-status__sub">
                {t("ai.admin.status.failing", {
                  count: failing.length,
                  names: failing.map((provider) => provider.name).join(", "),
                })}
              </span>
            )}
          </div>
          <div className="ai-status__cell">
            <span className="ai-status__label">{t("ai.admin.status.today")}</span>
            <span className="ai-status__value">
              {t("ai.admin.status.requests", { count: number.format(usageToday.requests) })}
            </span>
            <span className="ai-status__sub">
              {t("ai.admin.status.tokens", { count: number.format(usageToday.tokens) })}
            </span>
          </div>
          <div className="ai-status__cell">
            <span className="ai-status__label">{t("ai.admin.status.leaves")}</span>
            <span className="ai-status__value">{leaves.value}</span>
            {leaves.sub === undefined ? null : <span className="ai-status__sub">{leaves.sub}</span>}
          </div>
        </section>
      ) : (
        <section className="settings-card">
          {enabledSetting === undefined ? null : (
            <SettingRow
              setting={enabledSetting}
              rowId={rowId(section, "ai.enabled")}
              changes={changes}
              canWrite
              inheritable={false}
              found={found === rowId(section, "ai.enabled")}
              description={enabled ? t("ai.admin.switch.on") : t("ai.admin.switch.off")}
            />
          )}
          {!enabled && providers.data !== undefined && ready.length === 0 ? (
            <div className="ai-card__body">
              <p className="ai-note">
                <Icon name="info" />
                <span>
                  <strong>{t("ai.admin.switch.connectFirst")}</strong>{" "}
                  {t("ai.admin.switch.connectFirstText")}
                </span>
              </p>
            </div>
          ) : null}
        </section>
      )}
      <ProvidersCard scope={{ kind: "server" }} canWrite />
      <div className="ai-admin__pair">
        {list.length > 1 ? (
          <RowsCard
            title={t("ai.admin.functions.title")}
            lead={t("ai.admin.functions.lead")}
            keys={FUNCTION_KEYS}
            choicesFor={() => [
              {
                value: "",
                label:
                  fallback === undefined
                    ? t("ai.admin.functions.noDefault")
                    : t("ai.admin.functions.default", { name: fallback.name }),
              },
              ...list.map((provider) => ({
                value: provider.id,
                label: `${provider.name} · ${provider.model}`,
              })),
            ]}
            {...rowProps}
          />
        ) : null}
        <RowsCard title={t("ai.admin.orgs.title")} keys={["ai.allow_org_providers"]} {...rowProps}>
          <OrgList
            overview={overview.data}
            ownAllowed={byKey.get("ai.allow_org_providers")?.value === true}
          />
        </RowsCard>
      </div>
      <RowsCard
        title={t("ai.admin.limits.title")}
        lead={t("ai.admin.limits.lead")}
        keys={LIMIT_KEYS}
        {...rowProps}
      />
      <UsageCard
        scope={{ kind: "server" }}
        who={t("ai.admin.usage.org")}
        nameOf={(id) => orgNames.get(id) ?? id}
      />
      <RowsCard title={t("ai.admin.chats.title")} keys={["ai.chat_retention_days"]} {...rowProps} />
      <PrivacyNotice
        maxRows={typeof maxRows === "number" ? maxRows : 200}
        noticeText={byKey.get("ai.notice_text")}
        changes={changes}
        rowId={rowId(section, "ai.notice_text")}
        found={found === rowId(section, "ai.notice_text")}
      />
      <ConflictDialog
        conflict={changes.conflict}
        onKeepStored={changes.keepStored}
        onOverwrite={changes.overwrite}
      />
    </div>
  );
}
