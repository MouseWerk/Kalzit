import { type ReactNode, useId } from "react";
import { EmptyState } from "../../../components/EmptyState";
import { type MessageKey, useI18n } from "../../../i18n/i18n";
import { useDocumentTitle } from "../../../lib/useDocumentTitle";
import { usePublishCrumbTitle } from "../../../shell/crumbTitle";
import { errorText } from "../errors";
import "../admin.css";

/**
 * One administration section, a page of its own: its heading (the page's h1), a lead line, actions on the right, then the content.
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
  // The breadcrumbs end with this page's own name, such as the team's.
  usePublishCrumbTitle(heading);
  // The page keeps its heading while permissions load and when the section is not open to the
  // user, so it never lacks an h1.
  if (allowed === undefined || !allowed) {
    return (
      <section className="admin-section" aria-labelledby={titleId}>
        <div className="admin-section__heading">
          <h1 id={titleId}>{heading ?? t(title)}</h1>
        </div>
        {allowed === false ? (
          <EmptyState icon="lock" title={t("admin.forbidden.title")}>
            {t("admin.forbidden.section")}
          </EmptyState>
        ) : null}
      </section>
    );
  }
  return (
    <section className="admin-section" aria-labelledby={titleId}>
      {/* The back link sits above the header row, so the actions line up with the heading. */}
      <div className="admin-section__top">
        {back}
        <div className="admin-section__header">
          <div className="admin-section__heading">
            <h1 id={titleId}>{heading ?? t(title)}</h1>
            {lead === undefined ? null : <p className="admin-section__lead">{t(lead)}</p>}
          </div>
          {actions === undefined ? null : <div className="admin-section__actions">{actions}</div>}
        </div>
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
