import type { CacheInfo, Notice } from "../../../api/generated/shapes";
import { Icon } from "../../../components/Icon";
import { type Translate, useI18n } from "../../../i18n/i18n";
import { rowCount } from "../../../panels/frame";
import type { TargetOutcome } from "../results";
import "../dashboards.css";
import { noticeText } from "../../datasources/reasons";
import { errorBodyMessage } from "./errors";

/**
 * What each query did: the statement as executed (macros expanded), notices from the source,
 * truncation and size, whether the answer came from the server's query cache, or the error. For
 * editors checking why a panel looks the way it does.
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
          {"result" in outcome && outcome.cache !== undefined ? (
            <p className="inspect__meta">{cacheText(t, language, outcome.cache)}</p>
          ) : null}
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

/** A span of time in its largest whole unit: seconds, minutes, hours or days. */
export function spanText(ms: number, language: string): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const [value, unit] =
    seconds < 120
      ? [seconds, "second"]
      : seconds < 7_200
        ? [Math.round(seconds / 60), "minute"]
        : seconds < 172_800
          ? [Math.round(seconds / 3_600), "hour"]
          : [Math.round(seconds / 86_400), "day"];
  return new Intl.NumberFormat(language, { style: "unit", unit, unitDisplay: "long" }).format(
    value,
  );
}

/** One line on what the server's query cache did: answered, ran and kept, or refreshed. */
export function cacheText(t: Translate, language: string, cache: CacheInfo): string {
  const ttl = spanText(cache.ttlMs, language);
  switch (cache.status) {
    case "hit":
      return t("dashboards.inspect.cacheHit", { age: spanText(cache.ageMs, language), ttl });
    case "refresh":
      return cache.ttlMs === 0
        ? t("dashboards.inspect.cacheNotKept")
        : t("dashboards.inspect.cacheRefresh", { ttl });
    case "miss":
      return cache.ttlMs === 0
        ? t("dashboards.inspect.cacheNotKept")
        : t("dashboards.inspect.cacheMiss", { ttl });
  }
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
