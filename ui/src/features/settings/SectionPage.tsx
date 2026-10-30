import { type QueryClient, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, Navigate, useLocation, useParams } from "@tanstack/react-router";
import { type ReactNode, useEffect, useLayoutEffect, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { useCurrentOrg } from "../../org/useOrg";
import { PREFERENCES_KEY } from "../../preferences/preferences";
import { ShortcutsList } from "../../shell/ShortcutsHelp";
import { AccountSections } from "../admin/account/AccountPage";
import {
  adminKeys,
  listOrgSettings,
  listServerSettings,
  type Setting,
  updateOrgSetting,
  updateServerSetting,
} from "../admin/api";
import { LoadState } from "../admin/components/Section";
import { ConflictDialog, useSettingChanges } from "../admin/components/Settings";
import { AiOrgSection } from "../ai/admin/AiOrgSection";
import { AiServerSection } from "../ai/admin/AiServerSection";
import { OrgPluginsSection } from "../plugins/OrgPluginsSection";
import { PluginsSection } from "../plugins/PluginsSection";
import { useConfirmedCalls } from "../security/ConfirmFactorDialog";
import { PolicyOverview } from "../security/PolicyOverview";
import { SecuritySection } from "../security/SecuritySection";
import { AboutSection } from "./AboutSection";
import { AcmeSection } from "./AcmeSection";
import { AppearanceSection } from "./AppearanceSection";
import { resetSetting } from "./api";
import { MailSection } from "./MailSection";
import { QueryCacheCard } from "./QueryCacheCard";
import { type Changes, SettingRow } from "./rows";
import { sectionLabel, useSettingsAccess } from "./SettingsLayout";
import { findSection, rowId, SECTIONS, type SectionDef } from "./sections";
import { TransferSection } from "./TransferSection";
import "./settings.css";

/** The row the address names (`#appearance.accent`), marked for a moment after a jump. */
export function useFoundRow(): string | null {
  const { hash } = useLocation();
  const [found, setFound] = useState<string | null>(null);
  useLayoutEffect(() => {
    if (hash === "") {
      return;
    }
    const id = decodeURIComponent(hash.replace(/^#/, ""));
    setFound(id);
  }, [hash]);
  useEffect(() => {
    if (found === null) {
      return;
    }
    const element = document.getElementById(found);
    if (element !== null) {
      element.scrollIntoView?.({ block: "center" });
      const control = element.querySelector<HTMLElement>(
        ".settings-row__control input, .settings-row__control select, .settings-row__control textarea, .settings-row__control button, .settings-row__control output",
      );
      (control ?? element).focus({ preventScroll: true });
    }
    const timer = window.setTimeout(() => setFound(null), 2400);
    return () => window.clearTimeout(timer);
  }, [found]);
  return found;
}

export function SettingsIndex() {
  const access = useSettingsAccess();
  const first = SECTIONS.find((section) => section.visible(access) && section.group !== "footer");
  if (!access.permissions.loaded || first === undefined) {
    return null;
  }
  return <Navigate to="/settings/$section" params={{ section: first.id }} replace />;
}

export function SectionPage() {
  const { t } = useI18n();
  const { section: id } = useParams({ from: "/_app/settings/$section" });
  const access = useSettingsAccess();
  const org = useCurrentOrg();
  const section = findSection(id);
  useDocumentTitle(section?.label ?? "settings.title");
  if (section === undefined || (access.permissions.loaded && !section.visible(access))) {
    return (
      <EmptyState icon="lock" title={t("admin.forbidden.title")}>
        {t("settings.noAccess")}
      </EmptyState>
    );
  }
  if (!access.permissions.loaded) {
    return null;
  }
  return (
    <section className="settings-section" aria-labelledby="settings-section-title">
      <header className="settings-section__header">
        <h2 id="settings-section-title">{sectionLabel(t, section, org?.name)}</h2>
        <p className="settings-section__lead">{t(section.lead)}</p>
      </header>
      <SectionBody section={section} />
    </section>
  );
}

const appRoute = getRouteApi("/_app");

function SectionBody({ section }: { section: SectionDef }) {
  const { me } = appRoute.useRouteContext();
  switch (section.kind) {
    case "appearance":
      return <ServerSettings section={section} />;
    case "settings":
      return section.group === "org" ? (
        <OrgSettings section={section} />
      ) : section.id === "datasources" ? (
        <>
          <ServerSettings section={section} />
          <QueryCacheCard />
        </>
      ) : (
        <ServerSettings section={section} />
      );
    case "network":
      return (
        <>
          <ServerSettings section={section} />
          <AcmeSection />
        </>
      );
    case "signin":
      return (
        <>
          <ServerSettings section={section} />
          <PolicyOverview />
          <PlannedCard section={section} />
        </>
      );
    case "mail":
      return <MailSection />;
    case "accountSecurity":
      return <SecuritySection email={me.email} />;
    case "planned":
      return <PlannedCard section={section} />;
    case "ai":
      return <AiServerSection section={section} />;
    case "aiOrg":
      return <AiOrgSection section={section} />;
    case "plugins":
      return <PluginsSection />;
    case "pluginsOrg":
      return <OrgPluginsSection />;
    case "updates":
      return (
        <>
          <UpdatesPlaceholder />
          <ServerSettings section={section} />
        </>
      );
    case "profile":
      return (
        <div className="settings-profile">
          <AccountSections />
        </div>
      );
    case "shortcuts":
      return (
        <div className="settings-card settings-card--padded">
          <ShortcutsList />
        </div>
      );
    case "transfer":
      return <TransferSection />;
    case "about":
      return <AboutSection />;
  }
}

/** What a section will hold once it is built, with the way to what exists already. */
function PlannedCard({ section }: { section: SectionDef }) {
  const { t } = useI18n();
  return (
    <div className="settings-card settings-card--padded">
      <div className="settings-planned">
        <Icon name="activity" />
        <div>
          <h3 className="settings-row__title">{t("settings.planned.title")}</h3>
          <p className="settings-row__description">
            {section.planned === undefined ? null : t(section.planned)}
          </p>
          {section.id === "signin" ? (
            <Link
              to="/settings/$section"
              params={{ section: "appearance" }}
              hash="signin.page"
              className="settings-planned__link"
            >
              {t("settings.planned.signinPage")}
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** The way to the Updates page (`/admin/server/updates`), which has the update settings too. */
function UpdatesPlaceholder() {
  const { t } = useI18n();
  return (
    <div className="settings-card settings-card--padded">
      <div className="settings-planned">
        <Icon name="activity" />
        <div>
          <h3 className="settings-row__title">{t("settings.updates.text")}</h3>
          <Link to="/admin/server/updates" className="settings-planned__link">
            {t("settings.updates.open")}
          </Link>
        </div>
      </div>
    </div>
  );
}

function SettingsCard({
  settings,
  section,
  changes,
  canWrite,
  inheritable,
  before,
}: {
  settings: readonly Setting[];
  section: SectionDef;
  changes: Changes;
  canWrite: boolean;
  inheritable: boolean;
  before?: ReactNode;
}) {
  const found = useFoundRow();
  const byKey = new Map(settings.map((setting) => [setting.key, setting]));
  return (
    <div className="settings-card">
      {before}
      {(section.keys ?? []).map((key) => {
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
            inheritable={
              inheritable &&
              (key.startsWith("appearance.") || key === "security.two_factor_required")
            }
            found={found === id}
          />
        );
      })}
      <ConflictDialog
        conflict={changes.conflict}
        onKeepStored={changes.keepStored}
        onOverwrite={changes.overwrite}
      />
    </div>
  );
}

/** After a change, the brand and look the app applies are read again, so the change shows at once. */
export function refreshLook<T>(queryClient: QueryClient, saved: T): T {
  void queryClient.invalidateQueries({ queryKey: ["branding"] });
  void queryClient.invalidateQueries({ queryKey: ["appearance"] });
  // Users without a theme of their own get the default through their preferences.
  void queryClient.invalidateQueries({ queryKey: [PREFERENCES_KEY] });
  return saved;
}

function ServerSettings({ section }: { section: SectionDef }) {
  const queryKey = adminKeys.serverSettings;
  const settings = useQuery({ queryKey, queryFn: listServerSettings });
  const queryClient = useQueryClient();
  // Changing the second factor's rule asks for a fresh confirmation first.
  const confirmed = useConfirmedCalls();
  const changes = useSettingChanges({
    queryKey,
    patch: async (key, value, version) =>
      refreshLook(queryClient, await confirmed.run(() => updateServerSetting(key, value, version))),
    reset: async (key, version) =>
      refreshLook(
        queryClient,
        await confirmed.run(() => resetSetting({ kind: "server" }, key, version)),
      ),
  });
  if (settings.data === undefined) {
    return <LoadState error={settings.error} onRetry={() => void settings.refetch()} />;
  }
  if (section.kind === "appearance") {
    return <AppearanceSection settings={settings.data} changes={changes} />;
  }
  return (
    <SettingsCard
      settings={settings.data}
      section={section}
      changes={changes}
      canWrite
      inheritable={false}
      before={confirmed.dialog}
    />
  );
}

function OrgSettings({ section }: { section: SectionDef }) {
  const access = useSettingsAccess();
  const orgId = access.orgId ?? "";
  const queryKey = adminKeys.orgSettings(orgId);
  const queryClient = useQueryClient();
  const settings = useQuery({
    queryKey,
    queryFn: () => listOrgSettings(orgId),
    enabled: orgId !== "",
  });
  const confirmed = useConfirmedCalls();
  const changes = useSettingChanges({
    queryKey,
    patch: async (key, value, version) =>
      refreshLook(
        queryClient,
        await confirmed.run(() => updateOrgSetting(orgId, key, value, version)),
      ),
    reset: async (key, version) =>
      refreshLook(
        queryClient,
        await confirmed.run(() => resetSetting({ kind: "org", orgId }, key, version)),
      ),
  });
  if (settings.data === undefined) {
    return <LoadState error={settings.error} onRetry={() => void settings.refetch()} />;
  }
  return (
    <SettingsCard
      settings={settings.data}
      section={section}
      changes={changes}
      canWrite={access.permissions.has("settings:write")}
      inheritable
      before={confirmed.dialog}
    />
  );
}
