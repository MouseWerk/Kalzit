import type { ReactNode } from "react";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import type { TipState } from "../tips";
import "../help.css";

/**
 * A tip from `useTip`: one calm line beside the work, never in the way. It does not take the
 * focus or move what is around it; closing it, or turning all tips off, is one click.
 */
export function Tip({ tip, children }: { tip: TipState; children: ReactNode }) {
  const { t } = useI18n();
  if (!tip.visible) {
    return null;
  }
  return (
    <aside className="help-tip" aria-label={t("help.tip.label")}>
      <Icon name="help" />
      <p className="help-tip__text">
        <span className="help-tip__lead">{t("help.tip.lead")}</span> {children}
      </p>
      <div className="help-tip__actions">
        <button type="button" className="button button--ghost button--small" onClick={tip.turnOff}>
          {t("help.tip.turnOff")}
        </button>
        <button
          type="button"
          className="button button--ghost button--small help-tip__close"
          onClick={tip.dismiss}
          aria-label={t("help.tip.dismiss")}
          title={t("help.tip.dismiss")}
        >
          <Icon name="close" />
        </button>
      </div>
    </aside>
  );
}
