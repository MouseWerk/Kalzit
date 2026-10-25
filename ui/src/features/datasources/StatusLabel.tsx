import { useI18n } from "../../i18n/i18n";
import type { SourceStatus } from "./sourceStatus";
import "./datasources.css";

/**
 * A source's status as a small dot and a word, with the latency of the last test. The word
 * carries the meaning; the dot's color only repeats it.
 */
export function StatusLabel({
  status,
  latencyMs,
}: {
  status: SourceStatus;
  latencyMs?: number | undefined;
}) {
  const { t } = useI18n();
  const showLatency = (status === "connected" || status === "slow") && latencyMs !== undefined;
  return (
    <span className="ds-status" data-status={status}>
      <span className="ds-status__dot" aria-hidden="true" />
      <span>{t(`datasources.status.${status}`)}</span>
      {showLatency ? (
        <span className="ds-status__ms">
          {t("datasources.status.ms", { ms: Math.round(latencyMs) })}
        </span>
      ) : null}
    </span>
  );
}
