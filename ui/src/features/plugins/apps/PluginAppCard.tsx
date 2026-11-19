import { Icon } from "../../../components/Icon";
import { useI18n } from "../../../i18n/i18n";
import type { PluginDetail } from "../api";
import { PluginStatusLabel, SignatureLabel } from "../parts";
import { pageTitle } from "./api";
import "../plugins.css";

/**
 * An app in place of a process (board Settings075.dc.html, frame 8): its state, version and
 * signature, and the pages it brings into the navigation.
 */
export function PluginAppCard({ plugin, now }: { plugin: PluginDetail; now: number }) {
  const { t, language } = useI18n();
  return (
    <section className="plugins-card" aria-label={t("plugins.details.state")}>
      <div className="plugins-card__head">
        <div className="plugins-card__title">
          <h3>{t("plugins.details.state")}</h3>
        </div>
      </div>
      <div className="plugins-card__body">
        <dl className="plugin-defs">
          <dt>{t("plugins.details.status")}</dt>
          <dd>
            <PluginStatusLabel plugin={plugin} now={now} />
          </dd>
          <dt>{t("plugins.details.version")}</dt>
          <dd className="plugins-mono">{plugin.version}</dd>
          <dt>{t("plugins.details.signature")}</dt>
          <dd>
            <SignatureLabel plugin={plugin} />
          </dd>
          <dt>{t("apps.pages")}</dt>
          <dd>
            <span className="plugins-stack">
              {plugin.appPages.map((page) => (
                <span key={page.id}>{pageTitle(page, language)}</span>
              ))}
            </span>
          </dd>
        </dl>
        <p className="plugins-note">
          <Icon name="help" />
          <span>{t("apps.runs")}</span>
        </p>
      </div>
    </section>
  );
}
