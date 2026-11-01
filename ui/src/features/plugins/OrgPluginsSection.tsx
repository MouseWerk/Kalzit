import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import { useI18n } from "../../i18n/i18n";
import { showToast } from "../../lib/toasts";
import { useCurrentOrg } from "../../org/useOrg";
import { LoadState } from "../admin/components/Section";
import { errorMessage } from "../dashboards/ui/errors";
import { KINDS_KEY } from "../datasources/api";
import { listOrgPlugins, type OrgPlugin, pluginKeys, setOrgBlock } from "./api";
import { kindLabel } from "./PluginsSection";
import { PluginMark, TableScroll } from "./parts";
import "./plugins.css";

/**
 * Plugins of the organization: which of the server's plugins this organization offers. A
 * blocked plugin's kind is not offered here, and its sources here answer "kind not available".
 * Each switch applies at once, with Undo.
 */
export function OrgPluginsSection() {
  const { t } = useI18n();
  const org = useCurrentOrg();
  const orgId = org?.id ?? "";
  const queryClient = useQueryClient();
  const titleId = useId();
  const plugins = useQuery({
    queryKey: pluginKeys.org(orgId),
    queryFn: ({ signal }) => listOrgPlugins(orgId, signal),
    enabled: orgId !== "",
  });
  const block = useMutation({
    mutationFn: ({ plugin, blocked }: { plugin: OrgPlugin; blocked: boolean }) =>
      setOrgBlock(orgId, plugin.id, blocked),
    onSuccess: (_answer, { plugin, blocked }) => {
      void queryClient.invalidateQueries({ queryKey: pluginKeys.org(orgId) });
      void queryClient.invalidateQueries({ queryKey: [KINDS_KEY] });
      showToast({
        message: blocked
          ? t("plugins.org.blocked", { name: plugin.name })
          : t("plugins.org.unblocked", { name: plugin.name }),
        undo: () => block.mutate({ plugin, blocked: !blocked }),
      });
    },
    onError: (error) => showToast({ message: errorMessage(t, error), error: true }),
  });

  if (plugins.data === undefined) {
    return <LoadState error={plugins.error} onRetry={() => void plugins.refetch()} />;
  }
  return (
    <section className="plugins-card" aria-labelledby={titleId}>
      <div className="plugins-card__head">
        <div className="plugins-card__title">
          <h3 id={titleId}>{t("plugins.org.title")}</h3>
          <p className="plugins-hint">{t("plugins.org.lead")}</p>
        </div>
      </div>
      {plugins.data.length === 0 ? (
        <div className="plugins-card__body">
          <p className="plugins-hint">{t("plugins.org.none")}</p>
        </div>
      ) : (
        <TableScroll title={t("plugins.org.title")}>
          <table className="plugins-table">
            <thead>
              <tr>
                <th scope="col">{t("plugins.column.plugin")}</th>
                <th scope="col">{t("plugins.column.kind")}</th>
                <th scope="col">{t("plugins.column.version")}</th>
                <th scope="col" className="plugins-table__actions">
                  {t("plugins.org.offered")}
                </th>
              </tr>
            </thead>
            <tbody>
              {plugins.data.map((plugin) => (
                <tr key={plugin.id}>
                  <th scope="row">
                    <span className="plugins-name">
                      <PluginMark name={plugin.name} />
                      <span className="plugins-name__text">
                        <span>{plugin.name}</span>
                        <span className="plugins-mono plugins-muted" translate="no">
                          {plugin.id}
                        </span>
                      </span>
                    </span>
                  </th>
                  <td>
                    <span className="plugins-chip">{t(kindLabel(plugin.kind))}</span>
                  </td>
                  <td className="plugins-mono">{plugin.version}</td>
                  <td className="plugins-table__actions">
                    <input
                      type="checkbox"
                      role="switch"
                      className="plugins-toggle"
                      aria-label={t("plugins.org.offeredNamed", { name: plugin.name })}
                      checked={!plugin.blocked}
                      aria-checked={!plugin.blocked}
                      aria-disabled={block.isPending}
                      onChange={(event) => {
                        if (!block.isPending) {
                          block.mutate({ plugin, blocked: !event.currentTarget.checked });
                        }
                      }}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </section>
  );
}
