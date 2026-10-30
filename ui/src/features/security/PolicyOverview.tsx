import { useQuery } from "@tanstack/react-query";
import { useI18n } from "../../i18n/i18n";
import { LoadState } from "../admin/components/Section";
import { fetchOverview, type Requirement, securityKeys } from "./api";
import "../settings/settings.css";
import "./security.css";

/**
 * The second factor per organization (frame 5G, "Je Organisation"): each organization's own rule,
 * what applies there, and how many members must set one up at their next sign-in.
 */
export function PolicyOverview() {
  const { t } = useI18n();
  const overview = useQuery({ queryKey: securityKeys.overview, queryFn: fetchOverview });
  const requirement = (value: Requirement) => t(`security.policy.${value}`);
  return (
    <div className="settings-card settings-card--padded">
      <h3 className="settings-row__title">{t("security.policy.perOrg")}</h3>
      <p className="settings-row__description">{t("security.policy.perOrgLead")}</p>
      {overview.data === undefined ? (
        <LoadState error={overview.error} onRetry={() => void overview.refetch()} />
      ) : (
        <table className="security-policy">
          <thead>
            <tr>
              <th scope="col">{t("security.policy.colOrg")}</th>
              <th scope="col">{t("security.policy.colOwn")}</th>
              <th scope="col">{t("security.policy.colEffective")}</th>
              <th scope="col">{t("security.policy.colState")}</th>
            </tr>
          </thead>
          <tbody>
            {overview.data.orgs.map((org) => (
              <tr key={org.id}>
                <td>{org.name}</td>
                <td>
                  {org.policy === "admins" || org.policy === "everyone"
                    ? requirement(org.policy)
                    : t("security.policy.inherit")}
                </td>
                <td>{requirement(org.effective)}</td>
                <td>
                  {org.missing === 0
                    ? t("security.policy.allSet")
                    : t("security.policy.missing", { count: org.missing })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
