import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useI18n } from "../../i18n/i18n";
import { formatBytes } from "../../lib/bytes";
import { LoadState } from "../admin/components/Section";
import { errorText } from "../admin/errors";
import { clearQueryCache, getQueryCache, QUERY_CACHE_KEY } from "./api";

/**
 * The query cache as it is now, under its settings in Data sources: how many answers it keeps
 * and how much memory they take, how often it answered, and a way to empty it.
 */
export function QueryCacheCard() {
  const { t, language } = useI18n();
  const queryClient = useQueryClient();
  const stats = useQuery({ queryKey: QUERY_CACHE_KEY, queryFn: getQueryCache });
  const clear = useMutation({
    mutationFn: clearQueryCache,
    onSettled: () => queryClient.invalidateQueries({ queryKey: QUERY_CACHE_KEY }),
  });
  const number = new Intl.NumberFormat(language);
  const data = stats.data;
  let text: string | null = null;
  if (data !== undefined) {
    const asked = data.hits + data.misses;
    text = data.enabled
      ? t("settings.queryCache.status", {
          entries: number.format(data.entries),
          size: formatBytes(data.bytes, language),
          limit: formatBytes(data.maxBytes, language),
        })
      : t("settings.queryCache.off");
    if (asked > 0) {
      const rate = new Intl.NumberFormat(language, { style: "percent" }).format(data.hits / asked);
      text = `${text} ${t("settings.queryCache.hits", { rate, hits: number.format(data.hits), asked: number.format(asked) })}`;
    }
  }
  return (
    <div className="settings-card">
      <div className="settings-row">
        <div className="settings-row__text">
          <h3 className="settings-row__title">{t("settings.queryCache.title")}</h3>
          {data === undefined ? (
            <LoadState error={stats.error} onRetry={() => void stats.refetch()} />
          ) : (
            <p className="settings-row__description" role="status">
              {text}
            </p>
          )}
          {clear.error === null ? null : (
            <p className="field__error" role="alert">
              {errorText(t, clear.error)}
            </p>
          )}
        </div>
        <div className="settings-row__control">
          <button
            type="button"
            className="button button--secondary"
            disabled={data === undefined || data.entries === 0 || clear.isPending}
            onClick={() => clear.mutate()}
          >
            {t("settings.queryCache.clear")}
          </button>
        </div>
      </div>
    </div>
  );
}
