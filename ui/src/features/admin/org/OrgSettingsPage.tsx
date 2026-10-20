import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useI18n } from "../../../i18n/i18n";
import { adminKeys, listOrgSettings, type OrgSetting, updateOrgSetting } from "../api";
import { LoadState, Section } from "../components/Section";
import { SettingsList, useSettingChanges } from "../components/Settings";
import { allowedWhen, useAdminAccess } from "../sections";

export function OrgSettingsPage() {
  const { t } = useI18n();
  const access = useAdminAccess();
  const orgId = access.orgId ?? "";
  const queryClient = useQueryClient();
  const canRead = access.has("settings:read");
  const canWrite = access.has("settings:write");
  const queryKey = adminKeys.orgSettings(orgId);
  const settings = useQuery({
    queryKey,
    queryFn: () => listOrgSettings(orgId),
    enabled: canRead && orgId !== "",
  });
  const changes = useSettingChanges<OrgSetting>({
    queryKey,
    read: () => queryClient.getQueryData<OrgSetting[]>(queryKey),
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
