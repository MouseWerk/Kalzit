import { useId } from "react";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import "./plugins.css";

/**
 * Katalog (board frame 5A): off, with what it would do and that it connects nowhere while off.
 * This Kalzit has no catalog yet, so the switch is shown turned off and locked, with a note;
 * installing from a file works with the same checks.
 */
export function CatalogTab({ onInstallFile }: { onInstallFile: () => void }) {
  const { t } = useI18n();
  const titleId = useId();
  const noteId = useId();
  return (
    <section className="plugins-card" aria-labelledby={titleId}>
      <div className="plugins-card__body">
        <div className="plugin-switch">
          <div className="plugin-switch__text">
            <h3 className="plugin-switch__title" id={titleId}>
              {t("plugins.catalog.title")}
            </h3>
            <p className="plugins-hint">{t("plugins.catalog.lead")}</p>
          </div>
          <input
            type="checkbox"
            role="switch"
            aria-label={t("plugins.catalog.use")}
            aria-describedby={noteId}
            checked={false}
            aria-checked={false}
            disabled
            readOnly
          />
        </div>
        <p className="plugins-note" id={noteId}>
          <Icon name="clock" />
          <span>
            <strong>{t("plugins.catalog.later")}</strong> {t("plugins.catalog.laterText")}
          </span>
        </p>
        <div>
          <button type="button" className="button button--secondary" onClick={onInstallFile}>
            <Icon name="upload" />
            {t("plugins.install.open")}
          </button>
        </div>
      </div>
    </section>
  );
}
