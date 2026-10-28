import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { Icon } from "../../../components/Icon";
import { useI18n } from "../../../i18n/i18n";
import {
  adminKeys,
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
import { providerHost } from "../adminApi";
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
    </section>
  );
}

/**
 * Administration > AI for server administrators (board frames 1 to 4 and 7): the switch with
 * the status, the providers, whether organizations may connect their own, the limits, usage,
 * chat retention and the notice of what leaves the server. Settings apply at once with undo; a
 * refused switch says why at the row.
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
  const found = useFoundRow();
  if (settings.data === undefined) {
    return <LoadState error={settings.error} onRetry={() => void settings.refetch()} />;
  }
  const byKey = new Map(settings.data.map((setting) => [setting.key, setting]));
  const enabled = byKey.get("ai.enabled")?.value === true;
  const list = providers.data ?? [];
  const ready = list.filter(isReady);
  const fallback = list.find((provider) => provider.isDefault);
  const number = new Intl.NumberFormat(language);
  const usageToday = todayOf(today.data ?? []);
  const maxRows = byKey.get("ai.max_rows_to_model")?.value;
  const orgNames = new Map((orgs.data?.items ?? []).map((org) => [org.id, org.name]));
  const enabledSetting = byKey.get("ai.enabled");
  const rowProps = { byKey, section, changes, canWrite: true, found };

  return (
    <div className="ai-admin">
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
              <Icon name="help" />
              <span>
                <strong>{t("ai.admin.switch.connectFirst")}</strong>{" "}
                {t("ai.admin.switch.connectFirstText")}
              </span>
            </p>
          </div>
        ) : null}
      </section>
      {enabled ? (
        <section className="ai-status" aria-label={t("ai.admin.status.label")}>
          <div className="ai-status__cell">
            <span className="ai-status__label">{t("ai.admin.status.ai")}</span>
            <span className="ai-status__value">{t("ai.admin.status.on")}</span>
          </div>
          <div className="ai-status__cell">
            <span className="ai-status__label">{t("ai.admin.status.providers")}</span>
            <span className="ai-status__value">
              {t("ai.admin.status.providersReady", { ready: ready.length, total: list.length })}
            </span>
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
            <span className="ai-status__label">{t("ai.admin.status.destination")}</span>
            <span className="ai-status__value">
              {fallback === undefined ? t("ai.admin.status.noDefault") : fallback.name}
            </span>
            {fallback === undefined ? null : (
              <span className="ai-status__sub ai-mono" translate="no">
                {providerHost(fallback.baseUrl)}
              </span>
            )}
          </div>
        </section>
      ) : null}
      <ProvidersCard scope={{ kind: "server" }} canWrite />
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
      <RowsCard title={t("ai.admin.orgs.title")} keys={["ai.allow_org_providers"]} {...rowProps} />
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
