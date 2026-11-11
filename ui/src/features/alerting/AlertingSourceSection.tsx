import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { showToast } from "../../lib/toasts";
import { ALERTING_KEY, type SourceAlerting, saveSourceAlerting, sourceAlertingQuery } from "./api";
import { alertingErrorText } from "./reasons";
import "../datasources/datasources.css";
import "../settings/settings.css";
import "./alerting.css";

type Input = { enabled: boolean; maxConcurrent: number | null };

/**
 * "Alerting" of one data source (board Alerting.dc.html, frame 13): the opt-in that lets the
 * organization's alerting identity query the source, how many rules may query it at once, and
 * the rules on it. Changes apply at once with undo; who may not edit the source reads them.
 */
export function AlertingSourceSection({
  orgId,
  datasourceId,
  canWrite,
}: {
  orgId: string;
  datasourceId: string;
  canWrite: boolean;
}) {
  const { t } = useI18n();
  const ids = useId();
  const queryClient = useQueryClient();
  const query = sourceAlertingQuery(orgId, datasourceId);
  const access = useQuery({ ...query, retry: false });
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (input: Input & { previous?: SourceAlerting; undoable: boolean }) =>
      saveSourceAlerting(orgId, datasourceId, {
        enabled: input.enabled,
        maxConcurrent: input.maxConcurrent,
      }),
    onSuccess: async (saved, input) => {
      setProblem(null);
      setDraft(null);
      queryClient.setQueryData(query.queryKey, saved);
      await queryClient.invalidateQueries({ queryKey: [ALERTING_KEY, orgId, "sources"] });
      const previous = input.previous;
      showToast({
        message: t(saved.enabled ? "alerting.source.enabled" : "alerting.source.disabled"),
        undo:
          input.undoable && previous !== undefined
            ? () =>
                save.mutate({
                  enabled: previous.enabled,
                  maxConcurrent: previous.maxConcurrent,
                  undoable: false,
                })
            : undefined,
      });
    },
    onError: (error) => setProblem(alertingErrorText(t, error)),
  });

  // Without the route (an older server) or without the right to read it, the section stays away.
  if (access.isError || access.data === undefined) {
    return null;
  }
  const current = access.data;
  const busy = save.isPending;
  const titleId = `${ids}-title`;

  function apply(next: Input) {
    save.mutate({ ...next, previous: current, undoable: true });
  }

  function commitLimit() {
    if (draft === null) return;
    const text = draft.trim();
    const value = text === "" ? null : Number(text);
    if (value !== null && !(Number.isInteger(value) && value >= 1 && value <= 100)) {
      setProblem(t("alerting.reason.alerts.max_concurrent_invalid"));
      return;
    }
    if (value === current.maxConcurrent) {
      setDraft(null);
      return;
    }
    apply({ enabled: current.enabled, maxConcurrent: value });
  }

  return (
    <section id="alerting" className="ds-card" aria-labelledby={titleId} tabIndex={-1}>
      <div className="ds-card__head">
        <div className="ds-card__title">
          <h2 id={titleId}>{t("alerting.source.title")}</h2>
          <p className="ds-card__sub">{t("alerting.source.lead")}</p>
        </div>
      </div>
      <div className="ds-card__body">
        {canWrite ? null : (
          <p className="ds-locked">
            <Icon name="lock" />
            <span>{t("alerting.source.readOnly")}</span>
          </p>
        )}
        <div className="alert-switch-block">
          <div>
            <h3 className="alert-switch-block__title" id={`${ids}-enabled`}>
              {t("alerting.source.optIn")}
            </h3>
            <p className="settings-hint" id={`${ids}-enabled-text`}>
              {t("alerting.source.optInText")}
            </p>
          </div>
          <input
            type="checkbox"
            role="switch"
            className="settings-switch"
            checked={current.enabled}
            aria-checked={current.enabled}
            disabled={!canWrite}
            aria-disabled={busy || undefined}
            aria-labelledby={`${ids}-enabled`}
            aria-describedby={`${ids}-enabled-text`}
            onChange={(event) => {
              if (!busy)
                apply({
                  enabled: event.currentTarget.checked,
                  maxConcurrent: current.maxConcurrent,
                });
            }}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`${ids}-limit`}>
            {t("alerting.source.concurrent")}
          </label>
          <input
            id={`${ids}-limit`}
            className="input alert-narrow"
            inputMode="numeric"
            value={draft ?? (current.maxConcurrent === null ? "" : String(current.maxConcurrent))}
            placeholder={t("alerting.source.concurrentDefault")}
            readOnly={!canWrite}
            aria-describedby={`${ids}-limit-hint`}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitLimit}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) commitLimit();
            }}
          />
          <p className="field__hint" id={`${ids}-limit-hint`}>
            {t("alerting.source.concurrentHint")}
          </p>
        </div>
        <p className="alert-muted">
          {current.rules === 0
            ? t("alerting.source.noRules")
            : t("alerting.source.rules", {
                count: current.rules,
                firing: current.firingRules,
              })}{" "}
          {current.rules === 0 ? null : (
            <Link to="/alerting" search={{ source: datasourceId }}>
              {t("alerting.source.toRules")}
            </Link>
          )}
        </p>
        {current.enabled && current.rules > 0 ? (
          <p className="alert-note">{t("alerting.source.revokeHint", { count: current.rules })}</p>
        ) : null}
        {problem === null ? null : (
          <p className="field__error" role="alert">
            <Icon name="alert" />
            <span>{problem}</span>
          </p>
        )}
      </div>
    </section>
  );
}
