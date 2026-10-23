import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useI18n } from "../../i18n/i18n";
import { DASHBOARDS_KEY, fetchDashboards } from "./api";
import { linkHref } from "./links";
import type { DashboardLinkModel, VariableValues } from "./model";
import "./dashboardTools.css";
import "./ui/shared.css";

/**
 * The dashboard's links, below its title: addresses (variables filled in, then checked again)
 * and, per tag, the other dashboards with that tag.
 */
export function DashboardLinks({
  orgId,
  dashboardId,
  links,
  values,
}: {
  orgId: string;
  dashboardId: string;
  links: readonly DashboardLinkModel[];
  values: VariableValues;
}) {
  const { t } = useI18n();
  if (links.length === 0) {
    return null;
  }
  return (
    <nav className="dash-links" aria-label={t("dashboardTools.links.title")}>
      <ul className="dash-links__list">
        {links.map((link, index) => {
          if (link.type === "url") {
            const href = linkHref(link.url, values);
            // A link whose filled-in address is not allowed is left out rather than shown dead.
            return href === null ? null : (
              // biome-ignore lint/suspicious/noArrayIndexKey: links keep their order; titles can repeat
              <li key={index}>
                <a
                  className="button button--ghost button--small"
                  href={href}
                  {...(link.newTab === true
                    ? { target: "_blank", rel: "noopener noreferrer" }
                    : {})}
                >
                  {link.title}
                </a>
              </li>
            );
          }
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: links keep their order; tags can repeat
            <li key={index}>
              <TagLinks orgId={orgId} dashboardId={dashboardId} link={link} />
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function TagLinks({
  orgId,
  dashboardId,
  link,
}: {
  orgId: string;
  dashboardId: string;
  link: Extract<DashboardLinkModel, { type: "dashboards" }>;
}) {
  const { t } = useI18n();
  const list = useQuery({
    queryKey: [DASHBOARDS_KEY, orgId, "tag", link.tag],
    queryFn: ({ signal }) => fetchDashboards(orgId, { tag: link.tag }, signal),
  });
  const others = (list.data?.items ?? []).filter((d) => d.id !== dashboardId);
  const title =
    link.title === "" ? t("dashboardTools.links.tagTitle", { tag: link.tag }) : link.title;
  return (
    <details className="dash-links__menu">
      <summary className="button button--ghost button--small">{title}</summary>
      <ul className="dash-links__dashboards">
        {others.length === 0 ? (
          <li className="field__hint">
            {list.isPending ? t("common.loading") : t("dashboardTools.links.noTagged")}
          </li>
        ) : (
          others.map((d) => (
            <li key={d.id}>
              <Link
                to="/dashboards/$dashboardId"
                params={{ dashboardId: d.id }}
                {...(link.newTab === true ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              >
                {d.title}
              </Link>
            </li>
          ))
        )}
      </ul>
    </details>
  );
}
