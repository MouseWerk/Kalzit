import { reasonText } from "../features/datasources/reasons";
import type { Translate } from "../i18n/i18n";
import type { LiveView } from "./useLive";

/** The short form of an interval: "30s", "5m", "1h". */
function shortInterval(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/**
 * What a live subscription shows: a short label ("Live", "Live, every 30s", "Live stopped") and
 * the sentence behind it, with the server's reason when it gave one. Null while live is off.
 */
export function liveNote(t: Translate, view: LiveView): { label: string; detail: string } | null {
  if (!view.on) {
    return null;
  }
  const reason = (code: string | undefined, params?: Record<string, string>) =>
    code === undefined ? undefined : reasonText(t, { reason: code, params });
  if (view.error !== undefined) {
    return {
      label: t("live.stopped"),
      detail:
        reason(view.error.reason ?? undefined, view.error.params ?? undefined) ??
        view.error.message,
    };
  }
  const connection = view.connection;
  if (connection.state === "paused") {
    return { label: t("live.paused"), detail: t("live.detail.hidden") };
  }
  if (connection.state === "retrying") {
    const why = reason(connection.reason);
    return {
      label: t("live.on"),
      detail: why === undefined ? t("live.detail.reconnecting") : why,
    };
  }
  const status = view.status;
  if (status === undefined) {
    return { label: t("live.on"), detail: t("live.detail.connecting") };
  }
  if (status.mode === "changes") {
    return { label: t("live.on"), detail: t("live.detail.changes") };
  }
  const interval = shortInterval(status.refreshMs);
  const why = reason(status.reason);
  const poll = t("live.detail.poll", { interval });
  return {
    label: t("live.every", { interval }),
    detail: why === undefined ? poll : `${poll} ${why}`,
  };
}
