import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import { EmptyState } from "../../../components/EmptyState";
import { Select } from "../../../components/Select";
import { useI18n } from "../../../i18n/i18n";
import { formatBytes } from "../../../lib/bytes";
import { showErrorToast, showToast } from "../../../lib/toasts";
import { LoadState } from "../../admin/components/Section";
import { errorText } from "../../admin/errors";
import { errorReason, reasonText } from "../../datasources/reasons";
import { RowFrame } from "../../settings/rows";
import { useSettingsAccess } from "../../settings/SettingsLayout";
import {
  APP_ROLES,
  APPS_KEY,
  type AppRole,
  type AppSetting,
  appInitials,
  appSettingsKey,
  listAppSettings,
  updateAppSetting,
} from "./api";
import "../../settings/settings.css";
import "./apps.css";

/**
 * Verwaltung > Apps (board Settings075.dc.html, frame 11): an organization's admins block an app
 * for their organization or give it only to a role and up. Both apply at once, with undo. Pages
 * an app keeps for admins stay theirs whatever is chosen here.
 */
export function OrgAppsSection() {
  const { t } = useI18n();
  const orgId = useSettingsAccess().orgId ?? "";
  const list = useQuery({
    queryKey: appSettingsKey(orgId),
    queryFn: () => listAppSettings(orgId),
    enabled: orgId !== "",
  });
  if (list.data === undefined) {
    return <LoadState error={list.error} onRetry={() => void list.refetch()} />;
  }
  if (list.data.length === 0) {
    return (
      <div className="settings-card settings-card--padded">
        <EmptyState icon="plugin" title={t("apps.none")}>
          {t("apps.noneText")}
        </EmptyState>
      </div>
    );
  }
  return (
    <>
      {list.data.map((app) => (
        <AppCard key={app.id} orgId={orgId} app={app} />
      ))}
    </>
  );
}

function AppCard({ orgId, app }: { orgId: string; app: AppSetting }) {
  const { t, language } = useI18n();
  const queryClient = useQueryClient();
  const blockId = useId();
  const roleId = useId();
  const change = useMutation({
    mutationFn: (input: { patch: { minRole?: AppRole; blocked?: boolean }; undo: boolean }) =>
      updateAppSetting(orgId, app.id, input.patch),
    onSuccess: async (_, { patch, undo }) => {
      // The sidebar's "Apps" follows: a blocked app leaves it at once.
      await queryClient.invalidateQueries({ queryKey: [APPS_KEY, orgId] });
      const before = {
        ...(patch.blocked === undefined ? {} : { blocked: app.blocked }),
        ...(patch.minRole === undefined ? {} : { minRole: app.minRole }),
      };
      const message =
        patch.blocked === undefined
          ? t("apps.roleSet", {
              name: app.name,
              role: t(`admin.role.${patch.minRole ?? "viewer"}`),
            })
          : t(patch.blocked ? "apps.blockedNow" : "apps.unblocked", { name: app.name });
      showToast(
        undo ? { message } : { message, undo: () => change.mutate({ patch: before, undo: true }) },
      );
    },
    onError: (error) => {
      const reason = errorReason(error);
      showErrorToast(
        (reason === undefined ? undefined : reasonText(t, reason)) ?? errorText(t, error),
      );
    },
  });
  return (
    <section className="settings-card" aria-label={app.name}>
      <div className="app-setting__head">
        <span className="app-mark" aria-hidden="true">
          {appInitials(app.name)}
        </span>
        <div>
          <h3 className="app-setting__name">{app.name}</h3>
          <p className="app-setting__sub">
            {t("apps.storageUsed", { size: formatBytes(app.usedBytes, language) })}
          </p>
        </div>
      </div>
      <RowFrame
        id={`${app.id}.blocked`}
        title={t("apps.block")}
        titleId={blockId}
        description={t("apps.blockHint")}
        found={false}
      >
        <input
          type="checkbox"
          role="switch"
          className="settings-switch"
          checked={app.blocked}
          aria-checked={app.blocked}
          aria-labelledby={blockId}
          aria-describedby={`${blockId}-description`}
          aria-disabled={change.isPending}
          onChange={(event) =>
            change.mutate({ patch: { blocked: event.currentTarget.checked }, undo: false })
          }
        />
      </RowFrame>
      <RowFrame
        id={`${app.id}.minRole`}
        title={t("apps.who")}
        titleId={roleId}
        description={t("apps.whoHint")}
        found={false}
      >
        <Select
          value={app.minRole}
          disabled={app.blocked || change.isPending}
          aria-labelledby={roleId}
          onChange={(role) => change.mutate({ patch: { minRole: role as AppRole }, undo: false })}
        >
          {APP_ROLES.map((role) => (
            <option key={role} value={role}>
              {t("apps.roleUp", { role: t(`admin.role.${role}`) })}
            </option>
          ))}
        </Select>
      </RowFrame>
    </section>
  );
}
