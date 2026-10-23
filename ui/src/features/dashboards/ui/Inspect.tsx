import type { Notice } from "../../../api/generated/shapes";
import { Icon } from "../../../components/Icon";
import { useI18n } from "../../../i18n/i18n";
import { rowCount } from "../../../panels/frame";
import type { TargetOutcome } from "../results";
import "../dashboards.css";
import { noticeText } from "../../datasources/reasons";
import { errorBodyMessage } from "./errors";

/**
 * What each query did: the statement as executed (macros expanded), notices from the source,
 * truncation and size, or the error. For editors checking why a panel looks the way it does.
 */
export function Inspect({ outcomes }: { outcomes: readonly TargetOutcome[] }) {
  const { t, language } = useI18n();
  const number = new Intl.NumberFormat(language);
  if (outcomes.length === 0) {
    return <p className="field__hint">{t("dashboards.inspect.empty")}</p>;
  }
  return (
    <div className="inspect">
      {outcomes.map((outcome) => (
        <section
          key={outcome.refId}
          className="inspect__item"
          aria-label={t("dashboards.inspect.query", { refId: outcome.refId })}
        >
          <h3 className="inspect__title">
            {t("dashboards.inspect.query", { refId: outcome.refId })}
          </h3>
          {"error" in outcome ? (
            <div className="notice notice--danger">
              <Icon name="alert" />
              <div>
                <p>{errorBodyMessage(t, outcome.error)}</p>
                {outcome.error.message === "" ? null : (
                  <p className="inspect__detail">
                    {t("dashboards.inspect.detail")} <code>{outcome.error.message}</code>
                  </p>
                )}
              </div>
            </div>
          ) : outcome.result.shape === "frame" ? (
            <>
              <p className="inspect__meta">
                {t("dashboards.inspect.size", {
                  rows: number.format(rowCount(outcome.result.frame)),
                  fields: number.format(outcome.result.frame.fields.length),
                })}
              </p>
              {outcome.result.frame.meta?.rowsTruncated === true ? (
                <p className="notice">
                  <Icon name="alert" />
                  <span>{t("dashboards.inspect.truncated")}</span>
                </p>
              ) : null}
              <Notices notices={outcome.result.frame.meta?.notices ?? []} />
              <Executed query={outcome.result.frame.meta?.executedQuery} />
            </>
          ) : outcome.result.shape === "documents" ? (
            <>
              <p className="inspect__meta">
                {t("dashboards.inspect.documents", {
                  count: number.format(outcome.result.documents.documents.length),
                  paths: number.format(outcome.result.documents.schema.length),
                })}
              </p>
              {outcome.result.documents.truncated === undefined ? null : (
                <p className="notice">
                  <Icon name="alert" />
                  <span>
                    {t("documents.summary.truncated", {
                      limit: number.format(outcome.result.documents.truncated.limit),
                    })}
                  </span>
                </p>
              )}
              <Notices notices={outcome.result.documents.notices} />
              <Executed query={outcome.result.documents.executedQuery} />
            </>
          ) : (
            <p className="inspect__meta">
              {t("dashboards.inspect.shape", { shape: outcome.result.shape })}
            </p>
          )}
        </section>
      ))}
    </div>
  );
}

function Notices({ notices }: { notices: readonly Notice[] }) {
  const { t } = useI18n();
  return notices.map((notice, index) => (
    <p
      // biome-ignore lint/suspicious/noArrayIndexKey: notices have no id and keep their order
      key={index}
      className="notice"
    >
      <Icon name="alert" />
      <span>
        {notice.severity === "warning"
          ? t("dashboards.inspect.warning")
          : t("dashboards.inspect.info")}{" "}
        {noticeText(t, notice)}
      </span>
    </p>
  ));
}

function Executed({ query }: { query: string | undefined }) {
  const { t } = useI18n();
  if (query === undefined) return null;
  return (
    <>
      <h4 className="inspect__label">{t("dashboards.inspect.executed")}</h4>
      <pre className="inspect__code">{query}</pre>
    </>
  );
}
