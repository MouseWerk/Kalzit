import { type ReactNode, useId } from "react";
import { EmptyState } from "../../../components/EmptyState";
import { type MessageKey, useI18n } from "../../../i18n/i18n";
import { useDocumentTitle } from "../../../lib/useDocumentTitle";
import { errorText } from "../errors";
import "../admin.css";

/**
 * One administration section: its heading, a lead line, actions on the right, then the content.
 * `allowed` false shows "No access" instead (someone who followed a link without the permission);
 * `undefined` while permissions load shows nothing, so the content never flashes.
 */
export function Section({
  title,
  heading,
  back,
  lead,
  actions,
  allowed,
  children,
}: {
  title: MessageKey;
  /** Shown instead of the title, such as the name of the team on its page. */
  heading?: string | undefined;
  /** A link back to the list above this page. */
  back?: ReactNode;
  lead?: MessageKey;
  actions?: ReactNode;
  allowed: boolean | undefined;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const titleId = useId();
  useDocumentTitle(title);
  if (allowed === undefined) {
    return null;
  }
  if (!allowed) {
    return (
      <EmptyState icon="lock" title={t("admin.forbidden.title")}>
        {t("admin.forbidden.section")}
      </EmptyState>
    );
  }
  return (
    <section className="admin-section" aria-labelledby={titleId}>
      <div className="admin-section__header">
        <div className="admin-section__heading">
          {back}
          <h2 id={titleId}>{heading ?? t(title)}</h2>
          {lead === undefined ? null : <p className="admin-section__lead">{t(lead)}</p>}
        </div>
        {actions === undefined ? null : <div className="admin-section__actions">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** Loading text, or the error with a retry, for a list that is not there yet. */
export function LoadState({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const { t } = useI18n();
  if (error === null || error === undefined) {
    return (
      <p className="loading" role="status">
        {t("common.loading")}
      </p>
    );
  }
  return (
    <div className="notice notice--danger" role="alert">
      <div className="admin-notice__text">{errorText(t, error)}</div>
      <button type="button" className="admin-link-button" onClick={onRetry}>
        {t("common.retry")}
      </button>
    </div>
  );
}
