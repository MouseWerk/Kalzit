import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { useCurrentOrg } from "../../org/useOrg";
import {
  type AlertState,
  type ContactPoint,
  type Preview,
  previewMissing,
  previewRule,
} from "./api";
import { alertingErrorText, evalErrorText } from "./reasons";
import {
  conditionOf,
  conditionText,
  formatNumber,
  inputOf,
  labelPairs,
  type RuleDraft,
  reduceOf,
  reduceText,
  STATE_ORDER,
} from "./ruleModel";
import { Segmented, StateLabel, stateKey } from "./shared";

/** The summary keys of a preview, in the order they are named. */
const SUMMARY_KEYS = ["series", "points", "documents", "nodes", "edges", "paths"] as const;

/**
 * The right column of the rule editor: "Jetzt auswerten" runs the rule as edited with the
 * person's own rights (nothing is stored), shows each step's result and the state each instance
 * would have now, and the message that would be sent.
 */
export function RulePreview({
  orgId,
  draft,
  canRun,
  contactPoints,
}: {
  orgId: string;
  draft: RuleDraft;
  canRun: boolean;
  contactPoints: readonly ContactPoint[];
}) {
  const { t, language } = useI18n();
  const run = useMutation({ mutationFn: () => previewRule(orgId, inputOf(draft)) });
  const preview = run.data;
  const chosen = contactPoints.filter((point) => draft.contactPointIds.includes(point.id));
  const condition = conditionOf(draft);
  const timeFormat = new Intl.DateTimeFormat(language, { timeStyle: "medium" });

  return (
    <aside className="alert-editor__side" aria-label={t("alerting.preview.title")}>
      <section className="alert-card alert-pad alert-preview">
        <header className="alert-preview__head">
          <h2 className="alert-step__title">{t("alerting.preview.title")}</h2>
          <button
            type="button"
            className="button button--secondary button--small"
            aria-disabled={!canRun || run.isPending || undefined}
            onClick={() => canRun && !run.isPending && run.mutate()}
          >
            <Icon name="refresh" />
            {t("alerting.preview.run")}
          </button>
        </header>
        <div aria-live="polite">
          {run.isPending ? <p className="loading">{t("alerting.preview.running")}</p> : null}
          {run.isError ? (
            <p className={previewMissing(run.error) ? "alert-note" : "field__error"}>
              {previewMissing(run.error)
                ? t("alerting.preview.missing")
                : alertingErrorText(t, run.error)}
            </p>
          ) : null}
          {preview === undefined ? (
            run.isIdle ? (
              <p className="alert-hint">{t("alerting.preview.idle")}</p>
            ) : null
          ) : (
            <PreviewResult
              preview={preview}
              draft={draft}
              timeText={timeFormat.format(preview.evaluatedAt)}
            />
          )}
        </div>
        {preview !== undefined && preview.error === null ? (
          <p className="alert-muted">
            {resultText(t, preview)}{" "}
            {chosen.length === 0
              ? t("alerting.preview.noContacts")
              : t("alerting.preview.wouldNotify", {
                  names: chosen
                    .map((p) => t("alerting.preview.quoted", { name: p.name }))
                    .join(", "),
                })}
          </p>
        ) : null}
      </section>
      <MessagePreview
        draft={draft}
        preview={preview}
        conditionLabel={conditionText(t, condition, language)}
      />
    </aside>
  );
}

function PreviewResult({
  preview,
  draft,
  timeText,
}: {
  preview: Preview;
  draft: RuleDraft;
  timeText: string;
}) {
  const { t, language } = useI18n();
  const summary = SUMMARY_KEYS.flatMap((key) => {
    const count = preview.summary[key];
    return count === undefined ? [] : [t(`alerting.preview.count.${key}`, { count })];
  }).join(", ");
  const instances = [...preview.instances].sort(
    (a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state),
  );
  return (
    <>
      <p className="alert-hint">
        {preview.durationMs === null
          ? t("alerting.preview.evaluatedAt", { time: timeText })
          : t("alerting.preview.evaluatedIn", { time: timeText, ms: preview.durationMs })}
      </p>
      <ol className="alert-preview__steps">
        <li>
          <span className="alert-step__num">1</span>
          <span>{t("alerting.editor.step.query")}</span>
          <span className="alert-chip alert-chip--mono">{preview.shape ?? draft.shape}</span>
          <span className="alert-muted">{summary}</span>
        </li>
        <li>
          <span className="alert-step__num">2</span>
          <span>{t("alerting.editor.step.reduce")}</span>
          <span className="alert-muted">{reduceText(t, reduceOf(draft))}</span>
        </li>
        <li>
          <span className="alert-step__num">3</span>
          <span>{t("alerting.editor.step.condition")}</span>
          <span className="alert-muted">{conditionText(t, conditionOf(draft), language)}</span>
        </li>
      </ol>
      {preview.error === null ? null : (
        <p className="field__error" role="alert">
          <Icon name="alert" />
          <span>{evalErrorText(t, preview.error)}</span>
        </p>
      )}
      {preview.notes.map((note) => (
        <p key={`${note.code}:${JSON.stringify(note.params)}`} className="alert-note">
          {evalErrorText(t, note)}
        </p>
      ))}
      {instances.length === 0 ? null : (
        <table className="alert-table alert-table--compact">
          <thead>
            <tr>
              <th scope="col">{t("alerting.preview.instance")}</th>
              <th scope="col" className="alert-num">
                {t("alerting.preview.value")}
              </th>
              <th scope="col">{t("alerting.rules.column.state")}</th>
            </tr>
          </thead>
          <tbody>
            {instances.map((instance) => {
              const key = labelPairs(instance.labels).join(",") || "-";
              return (
                <tr key={key}>
                  <td className="alert-mono-cell">
                    {labelPairs(instance.labels).join(", ") || t("alerting.preview.wholeRule")}
                  </td>
                  <td className="alert-num">
                    {instance.value === null ? "–" : formatNumber(instance.value, language)}
                  </td>
                  <td>
                    <StateLabel state={instance.state} />
                    {instance.error === null || instance.error === undefined ? null : (
                      <span className="alert-sub alert-sub--warn">
                        {evalErrorText(t, instance.error)}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

function resultText(t: ReturnType<typeof useI18n>["t"], preview: Preview): string {
  const counts = new Map<AlertState, number>();
  for (const instance of preview.instances) {
    counts.set(instance.state, (counts.get(instance.state) ?? 0) + 1);
  }
  const parts = STATE_ORDER.flatMap((state) => {
    const count = counts.get(state);
    return count === undefined ? [] : [`${count} ${t(stateKey(state))}`];
  });
  return parts.length === 0
    ? t("alerting.preview.nothing")
    : t("alerting.preview.result", { states: parts.join(", ") });
}

/**
 * What a notification would say: the subject and the reduced values per instance (mail), or the
 * JSON body (webhook). Never rows, documents or nodes, only the reduced values.
 */
function MessagePreview({
  draft,
  preview,
  conditionLabel,
}: {
  draft: RuleDraft;
  preview: Preview | undefined;
  conditionLabel: string;
}) {
  const { t, language } = useI18n();
  const org = useCurrentOrg();
  const [kind, setKind] = useState("mail");
  const name = draft.name.trim() === "" ? t("alerting.editor.newTitle") : draft.name.trim();
  const firing = (preview?.instances ?? []).filter((instance) => instance.state === "firing");
  const sample = firing.length > 0 ? firing : (preview?.instances ?? []).slice(0, 1);
  const labelMap: Record<string, string> = Object.fromEntries(
    draft.labels.filter((row) => row.key.trim() !== "").map((row) => [row.key.trim(), row.value]),
  );
  const labels = labelPairs(labelMap);
  const fn = draft.shape === "frame" ? `${draft.frameFunction} ` : "";
  return (
    <section className="alert-card alert-pad alert-preview">
      <header className="alert-preview__head">
        <h2 className="alert-step__title">{t("alerting.preview.message")}</h2>
        <Segmented
          label={t("alerting.preview.messageKind")}
          value={kind}
          options={[
            { value: "mail", label: t("alerting.contact.kind.mail") },
            { value: "webhook", label: t("alerting.preview.webhookJson") },
          ]}
          onChange={setKind}
        />
      </header>
      {kind === "mail" ? (
        <div className="alert-message">
          <p className="alert-message__subject">
            [{t("alerting.state.firing")}] {name} · {org?.name ?? ""}
          </p>
          {sample.length === 0 ? (
            <p className="alert-muted">{t("alerting.preview.messageSample")}</p>
          ) : (
            <ul className="alert-message__lines">
              {sample.map((instance) => (
                <li key={labelPairs(instance.labels).join(",")} className="alert-mono-cell">
                  {labelPairs(instance.labels).join(", ") || name}: {fn}
                  {instance.value === null ? "–" : formatNumber(instance.value, language)},{" "}
                  {t("alerting.rules.conditionShort", { condition: conditionLabel })}
                </li>
              ))}
            </ul>
          )}
          {labels.length === 0 ? null : (
            <p className="alert-muted">
              {t("alerting.preview.labels", { labels: labels.join(", ") })}
            </p>
          )}
          <p className="alert-muted">{t("alerting.preview.links")}</p>
        </div>
      ) : (
        <pre className="alert-code">
          {JSON.stringify(
            {
              version: 1,
              organization: org?.name ?? "",
              rule: { name, labels: labelMap },
              state: "firing",
              instances: sample.map((instance) => ({
                labels: instance.labels,
                value: instance.value,
              })),
            },
            null,
            2,
          )}
        </pre>
      )}
      <p className="alert-hint">{t("alerting.preview.onlyValues")}</p>
    </section>
  );
}
