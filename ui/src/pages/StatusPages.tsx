import { type ErrorComponentProps, Link, useRouter } from "@tanstack/react-router";
import { isApiError } from "../api/client";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n/i18n";
import { useDocumentTitle } from "../lib/useDocumentTitle";

/** The Kalzit mark on a small tile, so a page without the shell still says where it is. */
function Mark() {
  return (
    <span className="status-page__mark">
      <Icon name="logo" />
    </span>
  );
}

export function NotFoundPage() {
  const { t } = useI18n();
  useDocumentTitle("notFound.title");
  return (
    <main className="status-page">
      <div className="status-page__body">
        <Mark />
        <h1>{t("notFound.title")}</h1>
        <p className="status-page__text">{t("notFound.text")}</p>
        <Link to="/" className="button button--secondary">
          {t("notFound.home")}
        </Link>
      </div>
    </main>
  );
}

/** Shown when a route guard or loader fails, most often because the server is not reachable. */
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
    <main className="status-page">
      <div className="status-page__body" role="alert">
        <Mark />
        <h1>{t("errorPage.title")}</h1>
        <p className="status-page__text">{message}</p>
        <button type="button" className="button button--secondary" onClick={retry}>
          {t("common.retry")}
        </button>
      </div>
    </main>
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
