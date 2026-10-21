import { useQuery } from "@tanstack/react-query";
import { useI18n } from "../../../i18n/i18n";
import {
  adminKeys,
  listServerSettings,
  type Setting,
  type SettingSource,
  updateServerSetting,
} from "../api";
import { LoadState, Section } from "../components/Section";
import { SettingDescription, SettingsList, useSettingChanges } from "../components/Settings";
import { allowedWhen, useAdminAccess } from "../sections";

const SOURCE_TEXT = {
  env: "admin.serverSettings.source.env",
  file: "admin.serverSettings.source.file",
  database: "admin.serverSettings.source.database",
  default: "admin.serverSettings.source.default",
} as const satisfies Record<SettingSource, string>;

/**
 * Server settings with where each value comes from. The environment wins over the file, the file
 * over what was changed here, so values from the first two are read-only; settings that live in
 * the configuration (sessions) are never changeable here.
 */
export function ServerSettingsPage() {
  const { t } = useI18n();
  const access = useAdminAccess();
  const queryKey = adminKeys.serverSettings;
  const settings = useQuery({
    queryKey,
    queryFn: listServerSettings,
    enabled: access.isServerAdmin,
  });
  const changes = useSettingChanges({
    queryKey,
    patch: updateServerSetting,
  });

  function readOnlyReason(setting: Setting): string | undefined {
    if (setting.source === "env") {
      return t("admin.serverSettings.fromEnv");
    }
    if (setting.source === "file") {
      return t("admin.serverSettings.fromFile");
    }
    return setting.editable ? undefined : t("admin.serverSettings.fileOnly");
  }

  return (
    <Section
      title="admin.serverSettings.title"
      lead="admin.serverSettings.lead"
      allowed={allowedWhen(access, access.isServerAdmin)}
    >
      {settings.data === undefined ? (
        <LoadState error={settings.error} onRetry={() => void settings.refetch()} />
      ) : (
        <SettingsList
          label={t("admin.serverSettings.title")}
          settings={settings.data}
          changes={changes}
          readOnlyReason={readOnlyReason}
          describe={(setting) => (
            <>
              <span className="admin-badge">{t(SOURCE_TEXT[setting.source])}</span>
              <SettingDescription setting={setting} />
            </>
          )}
        />
      )}
    </Section>
  );
}
