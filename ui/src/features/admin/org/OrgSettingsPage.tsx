import { useQuery } from "@tanstack/react-query";
import { useI18n } from "../../../i18n/i18n";
import { adminKeys, listOrgSettings, updateOrgSetting } from "../api";
import { LoadState, Section } from "../components/Section";
import { SettingDescription, SettingsList, useSettingChanges } from "../components/Settings";
import { allowedWhen, useAdminAccess } from "../sections";

export function OrgSettingsPage() {
  const { t } = useI18n();
  const access = useAdminAccess();
  const orgId = access.orgId ?? "";
  const canRead = access.has("settings:read");
  const canWrite = access.has("settings:write");
  const queryKey = adminKeys.orgSettings(orgId);
  const settings = useQuery({
    queryKey,
    queryFn: () => listOrgSettings(orgId),
    enabled: canRead && orgId !== "",
  });
  const changes = useSettingChanges({
    queryKey,
    patch: (key, value, version) => updateOrgSetting(orgId, key, value, version),
  });

  return (
    <Section
      title="admin.orgSettings.title"
      lead="admin.orgSettings.lead"
      allowed={allowedWhen(access, canRead)}
    >
      {settings.data === undefined ? (
        <LoadState error={settings.error} onRetry={() => void settings.refetch()} />
      ) : (
        <SettingsList
          label={t("admin.orgSettings.title")}
          settings={settings.data}
          changes={changes}
          describe={(setting) => <SettingDescription setting={setting} />}
          readOnlyReason={(setting) => {
            if (!setting.editable) {
              return t("admin.settings.notEditable");
            }
            return canWrite ? undefined : t("admin.settings.noWritePermission");
          }}
        />
      )}
    </Section>
  );
}
