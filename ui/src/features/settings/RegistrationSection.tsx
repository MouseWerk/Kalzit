import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId } from "react";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { listOrgs } from "../admin/api";
import { settingText } from "../admin/catalog";
import { LoadState } from "../admin/components/Section";
import { getMail, mailKey } from "./mailApi";
import { RowFrame, SettingRow } from "./rows";
import { useFoundRow } from "./SectionPage";
import { EntriesRow, PlainRow, RowsConflict, useServerRows } from "./serverRows";

/** A domain as the server stores it: lower-case labels with a dot between them. */
export function validDomain(domain: string): boolean {
  return (
    domain.length <= 253 &&
    /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(domain)
  );
}

/**
 * Verwaltung > Registrierung (board Settings075.dc.html, frame 3): people create their own
 * account instead of being invited. Off by default; it needs password sign-in, a mail server for
 * the confirmation link, at least one allowed domain and the organization new accounts join.
 * Every change applies at once, with undo; what is still missing stands beside the switch.
 */
export function RegistrationSection() {
  const { t } = useI18n();
  const { settings, changes, byKey } = useServerRows();
  const found = useFoundRow();
  const switchId = useId();
  const orgs = useQuery({
    queryKey: ["admin", "orgs", "all"],
    queryFn: () => listOrgs(undefined, 200),
  });
  const mail = useQuery({ queryKey: mailKey, queryFn: getMail });
  if (settings.data === undefined) {
    return <LoadState error={settings.error} onRetry={() => void settings.refetch()} />;
  }
  const domains = byKey.get("registration.allowed_domains")?.value;
  const orgId = String(byKey.get("registration.default_org")?.value ?? "");
  const orgSetting = byKey.get("registration.default_org");
  const roleSetting = byKey.get("registration.default_role");
  const checks: { ok: boolean; text: string }[] = [
    {
      ok: byKey.get("signin.local_password")?.value !== "off",
      text: t("serverAdmin.signup.needPassword"),
    },
    {
      ok: mail.data?.settings != null && mail.data.publicUrl !== null,
      text: t("serverAdmin.signup.needMail"),
    },
    { ok: Array.isArray(domains) && domains.length > 0, text: t("serverAdmin.signup.needDomain") },
    {
      ok: (orgs.data?.items ?? []).some((org) => org.id === orgId),
      text: t("serverAdmin.signup.needOrg"),
    },
  ];
  const enabledSetting = byKey.get("registration.enabled");
  const missing = checks.filter((check) => !check.ok).map((check) => check.text);
  const why = `${t("serverAdmin.signup.needs")}: ${missing.join("; ")}`;
  return (
    <div className="s75-wrap">
      <div className="s75-split">
        <div className="settings-card">
          {enabledSetting !== undefined && enabledSetting.value !== true && missing.length > 0 ? (
            // Something it needs is missing: the switch stays off and says why (it can still be
            // turned off while on, so nobody is stuck with an open door).
            <RowFrame
              id={enabledSetting.key}
              title={settingText(t, enabledSetting).label ?? enabledSetting.key}
              titleId={switchId}
              description={settingText(t, enabledSetting).description}
              note={<span id={`${switchId}-why`}>{why}</span>}
              found={found === enabledSetting.key}
            >
              <input
                type="checkbox"
                role="switch"
                className="settings-switch"
                checked={false}
                aria-checked={false}
                aria-disabled="true"
                aria-labelledby={switchId}
                aria-describedby={`${switchId}-why`}
                onChange={() => undefined}
              />
            </RowFrame>
          ) : (
            <PlainRow setting={enabledSetting} changes={changes} />
          )}
          <EntriesRow
            setting={byKey.get("registration.allowed_domains")}
            changes={changes}
            placeholder="example.com"
            normalize={(entry) => entry.replace(/^@/, "").toLowerCase()}
            check={(entry) => (validDomain(entry) ? null : t("serverAdmin.signup.domainBad"))}
          />
          {orgSetting === undefined ? null : (
            <SettingRow
              setting={orgSetting}
              rowId={orgSetting.key}
              changes={changes}
              canWrite
              inheritable={false}
              found={found === orgSetting.key}
              choices={[
                ...(orgId === "" ? [{ value: "", label: "–" }] : []),
                ...(orgs.data?.items ?? []).map((org) => ({ value: org.id, label: org.name })),
              ]}
            />
          )}
          {roleSetting === undefined ? null : (
            <SettingRow
              setting={roleSetting}
              rowId={roleSetting.key}
              changes={changes}
              canWrite
              inheritable={false}
              found={found === roleSetting.key}
              choices={(["viewer", "editor"] as const).map((role) => ({
                value: role,
                label: t(`admin.role.${role}`),
              }))}
            />
          )}
          <PlainRow setting={byKey.get("registration.require_approval")} changes={changes} />
          <PlainRow setting={byKey.get("registration.max_per_ip_hour")} changes={changes} />
          <PlainRow setting={byKey.get("registration.max_per_email_day")} changes={changes} />
          <PlainRow setting={byKey.get("registration.max_per_server_day")} changes={changes} />
          <RowsConflict changes={changes} />
        </div>
        <aside className="s75-side" aria-label={t("serverAdmin.signup.needs")}>
          <h3>{t("serverAdmin.signup.needs")}</h3>
          <ul className="s75-checks">
            {checks.map((check) => (
              <li key={check.text} className={check.ok ? undefined : "s75-checks__missing"}>
                <Icon name={check.ok ? "check" : "close"} />
                <span>{check.text}</span>
                <span className="visually-hidden">
                  {": "}
                  {t(check.ok ? "serverAdmin.signup.ok" : "serverAdmin.signup.missing")}
                </span>
              </li>
            ))}
          </ul>
          {mail.data?.settings == null ? (
            <Link
              to="/settings/$section"
              params={{ section: "email" }}
              className="button button--secondary"
            >
              {t("serverAdmin.signup.setUpMail")}
            </Link>
          ) : null}
          <p className="s75-muted">{t("serverAdmin.signup.fixed")}</p>
        </aside>
      </div>
    </div>
  );
}
