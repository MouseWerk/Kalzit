import { type ErrorComponentProps, Link, useRouter } from "@tanstack/react-router";
import { isApiError } from "../api/client";
import { AccessEnd, AccessLayout } from "../auth/AccessLayout";
import { useI18n } from "../i18n/i18n";
import { useDocumentTitle } from "../lib/useDocumentTitle";

/**
 * An address that does not exist. In the frame of the pages before the app (board Auth.dc.html,
 * frame 14, "Server nicht erreichbar"), with language, theme, help and the product's own name.
 */
export function NotFoundPage() {
  const { t } = useI18n();
  useDocumentTitle("notFound.title");
  return (
    <AccessLayout>
      <AccessEnd
        icon="link"
        title={t("notFound.title")}
        text={t("notFound.text")}
        action={
          <Link to="/" className="button button--secondary button--block">
            {t("notFound.home")}
          </Link>
        }
      />
    </AccessLayout>
  );
}

/**
 * Shown when a route guard or loader fails, most often because the server is not reachable: in
 * the same frame, with the way to try again.
 */
export function ErrorPage({ error, reset }: ErrorComponentProps) {
  const { t } = useI18n();
  useDocumentTitle("errorPage.title");
  const router = useRouter();
  const message = t(isApiError(error) ? `errors.${error.code}` : "errors.internal");

  async function retry() {
    reset();
    await router.invalidate();
  }

  return (
    <AccessLayout>
      <div role="alert">
        <AccessEnd
          tone="danger"
          icon="alert"
          title={t("errorPage.title")}
          text={message}
          action={
            <button type="button" className="button button--primary button--block" onClick={retry}>
              {t("common.retry")}
            </button>
          }
        />
      </div>
    </AccessLayout>
  );
}

/** Shown only when loading takes noticeably long, so fast loads do not flash. */
export function PendingPage() {
  const { t } = useI18n();
  return (
    <div className="status-page">
      <p className="loading" role="status">
        {t("common.loading")}
      </p>
    </div>
  );
}
