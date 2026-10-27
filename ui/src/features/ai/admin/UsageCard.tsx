import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useI18n } from "../../../i18n/i18n";
import { LoadState } from "../../admin/components/Section";
import { Segmented } from "../../settings/rows";
import { type AiScope, type AiUsageRow, aiAdminKeys, fetchAiUsage } from "../adminApi";
import "./ai-admin.css";

export const USAGE_PERIODS = [7, 30] as const;

/** Today's calls and tokens of the scope: the rows of the newest day, if that is today (UTC). */
export function todayOf(
  rows: readonly AiUsageRow[],
  now = Date.now(),
): {
  requests: number;
  tokens: number;
} {
  const today = new Date(now).toISOString().slice(0, 10);
  return rows
    .filter((row) => row.day === today)
    .reduce(
      (sum, row) => ({
        requests: sum.requests + row.requests,
        tokens: sum.tokens + row.inputTokens + row.outputTokens,
      }),
      { requests: 0, tokens: 0 },
    );
}

export function useAiUsage(scope: AiScope, days: number) {
  return useQuery({
    queryKey: aiAdminKeys.usage(scope, days),
    queryFn: ({ signal }) => fetchAiUsage(scope, days, signal),
  });
}

/**
 * Usage of AI over the last 7 or 30 days (board frame 4): calls and tokens per day and
 * organization, or per day and member. Counts only, never money. The table is the chart's text
 * alternative too; its caption sums the period up.
 */
export function UsageCard({
  scope,
  who,
  nameOf,
}: {
  scope: AiScope;
  /** The heading of the second column: organization or member. */
  who: string;
  /** The readable name of an organization or member id. */
  nameOf: (id: string) => string;
}) {
  const { t, language } = useI18n();
  const titleId = useId();
  const periodId = useId();
  const [days, setDays] = useState<number>(7);
  const usage = useAiUsage(scope, days);
  const number = new Intl.NumberFormat(language);
  const dayFormat = new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeZone: "UTC",
  });
  const rows = usage.data ?? [];
  const total = rows.reduce(
    (sum, row) => ({
      requests: sum.requests + row.requests,
      tokens: sum.tokens + row.inputTokens + row.outputTokens,
    }),
    { requests: 0, tokens: 0 },
  );
  return (
    <section className="settings-card" aria-labelledby={titleId}>
      <div className="ai-card__head">
        <div className="ai-card__title">
          <h3 id={titleId}>{t("ai.admin.usage.title")}</h3>
          <p className="settings-hint">{t("ai.admin.usage.lead")}</p>
        </div>
        <span className="visually-hidden" id={periodId}>
          {t("ai.admin.usage.period")}
        </span>
        <Segmented
          labelled={{ "aria-labelledby": periodId }}
          value={String(days)}
          options={USAGE_PERIODS.map((value) => ({
            value: String(value),
            label: t("ai.admin.usage.days", { days: value }),
          }))}
          onChange={(value) => setDays(Number(value))}
        />
      </div>
      {usage.data === undefined ? (
        <div className="ai-card__body">
          <LoadState error={usage.error} onRetry={() => void usage.refetch()} />
        </div>
      ) : rows.length === 0 ? (
        <p className="ai-card__body settings-hint">{t("ai.admin.usage.none", { days })}</p>
      ) : (
        <div className="ai-table-wrap">
          <table className="ai-table">
            <caption className="ai-table__caption">
              {t("ai.admin.usage.summary", {
                days,
                requests: number.format(total.requests),
                tokens: number.format(total.tokens),
              })}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t("ai.admin.usage.day")}</th>
                <th scope="col">{who}</th>
                <th scope="col" className="ai-table__number">
                  {t("ai.admin.usage.requests")}
                </th>
                <th scope="col" className="ai-table__number">
                  {t("ai.admin.usage.inputTokens")}
                </th>
                <th scope="col" className="ai-table__number">
                  {t("ai.admin.usage.outputTokens")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const id = row.orgId ?? row.userId ?? "";
                return (
                  <tr key={`${row.day}-${id}`}>
                    <td>{dayFormat.format(new Date(`${row.day}T00:00:00Z`))}</td>
                    <td>{nameOf(id)}</td>
                    <td className="ai-table__number">{number.format(row.requests)}</td>
                    <td className="ai-table__number">{number.format(row.inputTokens)}</td>
                    <td className="ai-table__number">{number.format(row.outputTokens)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
