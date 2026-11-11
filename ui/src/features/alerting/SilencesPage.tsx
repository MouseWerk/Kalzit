import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { Icon } from "../../components/Icon";
import { PageActions } from "../../components/Page";
import { Select } from "../../components/Select";
import { useI18n } from "../../i18n/i18n";
import { showToast } from "../../lib/toasts";
import { fromWall, wallInput } from "../../lib/zonedTime";
import { ConfirmDialog, Dialog } from "../admin/components/Dialog";
import {
  ALERTING_KEY,
  createSilence,
  expireSilence,
  type Matcher,
  type MatcherOp,
  previewSilence,
  ruleQuery,
  type Silence,
  silencesQuery,
} from "./api";
import { alertingErrorText } from "./reasons";
import type { SilencesSearch } from "./routes";
import { labelNameValid, labelPairs } from "./ruleModel";
import { AlertingLayout, Segmented, StateLabel, useAlerting, useAlertTime } from "./shared";

const MAX_MATCHERS = 20;
const MAX_DAYS = 90;
const MAX_COMMENT = 500;

const OP_TEXT: Record<MatcherOp, string> = { "=": "=", "!=": "≠", "=~": "=~" };

/** A matcher as written in the list: `team=lager`, `instance=~lager-api-[23]`. */
export function matcherText(matcher: Matcher): string {
  return `${matcher.label}${OP_TEXT[matcher.op]}${matcher.value}`;
}

/** What the dialog starts with. */
interface DialogStart {
  matchers: Matcher[];
  /** The instance the conditions come from, as `key=value` text. */
  from?: string | undefined;
}

/**
 * "Alerting > Stummschaltungen" (board frame 9): active and planned silences, or the expired
 * ones; ending one early; the dialog to add one, empty or from an instance.
 */
export function SilencesPage() {
  const { t } = useI18n();
  const search = useSearch({ from: "/_app/alerting/silences" }) as SilencesSearch;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { orgId, canWrite } = useAlerting();
  const expired = search.expired === true;
  const silences = useQuery({ ...silencesQuery(orgId), enabled: orgId !== "" });
  const fromRule = useQuery({
    ...ruleQuery(orgId, search.rule ?? ""),
    enabled: orgId !== "" && search.rule !== undefined,
  });
  const [again, setAgain] = useState<DialogStart | null>(null);
  const [ending, setEnding] = useState<Silence | null>(null);
  const time = useAlertTime();

  const end = useMutation({
    mutationFn: (silence: Silence) => expireSilence(orgId, silence.id),
    onSuccess: async () => {
      setEnding(null);
      showToast({ message: t("alerting.silences.ended") });
      await queryClient.invalidateQueries({ queryKey: [ALERTING_KEY, orgId] });
    },
  });

  // The dialog opens from the address (a rule's menu, an instance, "Stummschaltung") or again
  // from an expired silence.
  let start: DialogStart | null = again;
  if (start === null && canWrite) {
    if (search.rule !== undefined && fromRule.data !== undefined) {
      const rule = fromRule.data;
      const instance = rule.instances?.find((item) => item.fingerprint === search.fingerprint);
      start = {
        matchers: [
          { label: "alertname", op: "=", value: rule.name },
          ...Object.entries(instance?.labels ?? {}).map(([label, value]) => ({
            label,
            op: "=" as const,
            value,
          })),
        ],
        from: instance === undefined ? undefined : labelPairs(instance.labels).join(", "),
      };
    } else if (search.create === true) {
      start = { matchers: [{ label: "", op: "=", value: "" }] };
    }
  }

  function closeDialog() {
    setAgain(null);
    if (search.rule !== undefined || search.create === true) {
      void navigate({ to: "/alerting/silences", search: expired ? { expired: true } : {} });
    }
  }

  const all = silences.data ?? [];
  const shown = all.filter((silence) => (silence.status === "expired") === expired);
  const affected = useAffectedCounts(orgId, expired ? [] : shown, canWrite);

  return (
    <AlertingLayout
      tab="silences"
      lead={t("alerting.silences.lead")}
      actions={
        canWrite ? (
          <PageActions>
            <button
              type="button"
              className="button button--primary"
              onClick={() => setAgain({ matchers: [{ label: "", op: "=", value: "" }] })}
            >
              <Icon name="bellOff" />
              {t("alerting.silences.add")}
            </button>
          </PageActions>
        ) : null
      }
    >
      <Segmented
        label={t("alerting.silences.filter")}
        value={expired ? "expired" : "current"}
        options={[
          { value: "current", label: t("alerting.silences.current") },
          { value: "expired", label: t("alerting.silences.expired") },
        ]}
        onChange={(value) =>
          void navigate({
            to: "/alerting/silences",
            search: value === "expired" ? { expired: true } : {},
          })
        }
      />
      {silences.isError ? (
        <p className="field__error">{alertingErrorText(t, silences.error)}</p>
      ) : null}
      {silences.isSuccess && shown.length === 0 ? (
        <p className="alert-card alert-pad alert-muted">
          {t(expired ? "alerting.silences.noneExpired" : "alerting.silences.none")}
        </p>
      ) : null}
      {shown.length === 0 ? null : (
        <div className="alert-card alert-table-wrap">
          <table className="alert-table">
            <thead>
              <tr>
                <th scope="col">{t("alerting.silences.column.status")}</th>
                <th scope="col">{t("alerting.silences.column.matchers")}</th>
                <th scope="col">{t("alerting.silences.column.window")}</th>
                <th scope="col" className="alert-num">
                  {t("alerting.silences.column.affected")}
                </th>
                <th scope="col">{t("alerting.silences.column.by")}</th>
                {canWrite ? (
                  <th scope="col">
                    <span className="visually-hidden">{t("alerting.rules.column.actions")}</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {shown.map((silence) => (
                <tr key={silence.id}>
                  <td>
                    <span className="alert-chip">
                      {t(`alerting.silences.status.${silence.status}`)}
                    </span>
                  </td>
                  <td>
                    <span className="alert-labels">
                      {silence.matchers.map((matcher) => (
                        <span
                          key={matcherText(matcher)}
                          className="alert-chip alert-chip--mono"
                          translate="no"
                        >
                          {matcherText(matcher)}
                        </span>
                      ))}
                    </span>
                    <span className="alert-sub">{silence.comment}</span>
                  </td>
                  <td>
                    {silence.status === "expired"
                      ? t("alerting.silences.endedAt", {
                          at: time(silence.endedAt ?? silence.endsAt),
                        })
                      : silence.status === "pending"
                        ? t("alerting.silences.fromTo", {
                            from: time(silence.startsAt),
                            to: time(silence.endsAt),
                          })
                        : t("alerting.silences.until", { at: time(silence.endsAt) })}
                  </td>
                  <td className="alert-num">
                    {silence.status === "expired" ? "–" : (affected.get(silence.id) ?? "–")}
                  </td>
                  <td>{silence.createdByName ?? "–"}</td>
                  {canWrite ? (
                    <td>
                      {silence.status === "expired" ? (
                        <button
                          type="button"
                          className="button button--ghost button--small"
                          onClick={() => setAgain({ matchers: silence.matchers })}
                        >
                          {t("alerting.silences.again")}
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="button button--ghost button--small"
                          aria-label={t("alerting.silences.endNamed", {
                            matchers: silence.matchers.map(matcherText).join(", "),
                          })}
                          onClick={() => setEnding(silence)}
                        >
                          {t("alerting.silences.end")}
                        </button>
                      )}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="alert-hint">{t("alerting.silences.footer")}</p>
      {start === null ? null : (
        <SilenceDialog
          key={JSON.stringify(start)}
          orgId={orgId}
          start={start}
          onClose={closeDialog}
        />
      )}
      <ConfirmDialog
        open={ending !== null}
        title={t("alerting.silences.endTitle")}
        confirmLabel={t("alerting.silences.end")}
        busy={end.isPending}
        error={end.isError ? alertingErrorText(t, end.error) : null}
        onConfirm={() => ending !== null && end.mutate(ending)}
        onClose={() => {
          setEnding(null);
          end.reset();
        }}
      >
        {t("alerting.silences.endText")}
      </ConfirmDialog>
    </AlertingLayout>
  );
}

/**
 * How many instances each shown silence holds back now. The preview route needs `alerts:write`,
 * so only those who may write see the numbers; one query for the list, its previews one after
 * the other, so the page does not send a burst of requests.
 */
function useAffectedCounts(
  orgId: string,
  silences: readonly Silence[],
  enabled: boolean,
): ReadonlyMap<string, number> {
  const current = silences.filter((silence) => silence.status !== "expired");
  const counts = useQuery({
    queryKey: [ALERTING_KEY, orgId, "silence-counts", current.map((silence) => silence.id)],
    queryFn: async ({ signal }) => {
      const out = new Map<string, number>();
      for (const silence of current) {
        out.set(silence.id, (await previewSilence(orgId, silence.matchers, signal)).length);
      }
      return out;
    },
    enabled: enabled && orgId !== "" && current.length > 0,
    staleTime: 30_000,
  });
  return counts.data ?? NO_COUNTS;
}

const NO_COUNTS: ReadonlyMap<string, number> = new Map();

/** The value after it stopped changing for a moment, so typing does not ask on every key. */
function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

/** How long typing pauses before the affected instances are asked for. */
const PREVIEW_DELAY_MS = 300;

const DURATIONS = [
  { value: "3600", key: "alerting.silences.duration.hour" },
  { value: "14400", key: "alerting.silences.duration.hours4" },
  { value: "86400", key: "alerting.silences.duration.day" },
  { value: "until", key: "alerting.silences.duration.until" },
] as const;

/** A datetime-local value in the person's time zone, as Unix milliseconds (NaN when empty). */
function inputTime(text: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(text);
  if (match === null) return Number.NaN;
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
  ];
  return fromWall({ year, month, day, hour, minute, second: 0, millisecond: 0 });
}

/** Whether a matcher can be sent: a label name as for rules (`alertname` too), a value. */
function matcherProblem(matcher: Matcher): boolean {
  const name = matcher.label.trim();
  return (
    !(name === "alertname" || labelNameValid(name)) ||
    (matcher.op === "=~" && !regexValid(matcher.value))
  );
}

function regexValid(value: string): boolean {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * "Stummschalten" (board frame 9, dialog): conditions that all must match, a duration (1 hour,
 * 4 hours, 1 day or until a time, at most 90 days), a required comment, and the instances it
 * affects now, updated while typing. Saving with no instance affected is fine (planned work).
 */
function SilenceDialog({
  orgId,
  start,
  onClose,
}: {
  orgId: string;
  start: DialogStart;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const ids = useId();
  const queryClient = useQueryClient();
  const time = useAlertTime();
  const [matchers, setMatchers] = useState<Matcher[]>(start.matchers);
  const [duration, setDuration] = useState<string>("3600");
  const [until, setUntil] = useState(() => wallInput(Date.now() + 86_400_000));
  const [comment, setComment] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [now] = useState(() => Date.now());
  const endsAt = duration === "until" ? inputTime(until) : now + Number(duration) * 1000;
  const valid = matchers.filter((m) => m.label.trim() !== "" && !matcherProblem(m));
  // A new value only when the conditions really changed, then after a short pause in typing.
  const conditions = JSON.stringify(valid);
  const settled = useDebounced(conditions, PREVIEW_DELAY_MS);
  const deferred = JSON.parse(settled) as Matcher[];
  const affected = useQuery({
    queryKey: [ALERTING_KEY, orgId, "silence-preview", deferred],
    queryFn: ({ signal }) => previewSilence(orgId, deferred, signal),
    enabled: deferred.length > 0,
  });

  const save = useMutation({
    mutationFn: () =>
      createSilence(orgId, {
        matchers: valid.map((m) => ({ ...m, label: m.label.trim() })),
        endsAt,
        comment: comment.trim(),
      }),
    onSuccess: async () => {
      showToast({ message: t("alerting.silences.created") });
      await queryClient.invalidateQueries({ queryKey: [ALERTING_KEY, orgId] });
      onClose();
    },
    onError: (error) => setProblem(alertingErrorText(t, error)),
  });

  function submit() {
    if (
      valid.length === 0 ||
      valid.length !== matchers.filter((m) => m.label.trim() !== "").length
    ) {
      setProblem(t("alerting.reason.alerts.matchers_invalid"));
      return;
    }
    if (!Number.isFinite(endsAt) || endsAt <= Date.now() || endsAt - now > MAX_DAYS * 86_400_000) {
      setProblem(t("alerting.reason.alerts.silence_window_invalid"));
      return;
    }
    if (comment.trim() === "") {
      setProblem(t("alerting.reason.alerts.comment_required"));
      document.getElementById(`${ids}-comment`)?.focus();
      return;
    }
    setProblem(null);
    save.mutate();
  }

  const list = affected.data ?? [];
  return (
    <Dialog
      open
      wide
      title={t("alerting.silences.dialogTitle")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("alerting.editor.cancel")}
          </button>
          <button
            type="button"
            className="button button--primary"
            aria-disabled={save.isPending || undefined}
            onClick={() => !save.isPending && submit()}
          >
            {t("alerting.silences.save")}
          </button>
        </>
      }
    >
      <div className="alert-dialog-body">
        <p className="alert-muted">
          {start.from === undefined
            ? t("alerting.silences.dialogLead")
            : t("alerting.silences.fromInstance", { labels: start.from })}
        </p>
        <fieldset className="alert-fieldset">
          <legend className="field__label">{t("alerting.silences.matchers")}</legend>
          {matchers.map((matcher, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place
            <div key={index} className="alert-matcher-row">
              <input
                className="input input--mono"
                value={matcher.label}
                placeholder={t("alerting.silences.label")}
                aria-label={t("alerting.silences.labelNamed", { index: index + 1 })}
                aria-invalid={
                  matcher.label.trim() !== "" && matcherProblem(matcher) ? true : undefined
                }
                onChange={(event) =>
                  setMatchers(
                    matchers.map((m, i) => (i === index ? { ...m, label: event.target.value } : m)),
                  )
                }
              />
              <Select
                value={matcher.op}
                aria-label={t("alerting.silences.opLabel", { index: index + 1 })}
                onChange={(op) =>
                  setMatchers(
                    matchers.map((m, i) => (i === index ? { ...m, op: op as MatcherOp } : m)),
                  )
                }
              >
                <option value="=">=</option>
                <option value="!=">≠</option>
                <option value="=~">=~</option>
              </Select>
              <input
                className="input input--mono"
                value={matcher.value}
                placeholder={t("alerting.silences.value")}
                aria-label={t("alerting.silences.valueNamed", { index: index + 1 })}
                onChange={(event) =>
                  setMatchers(
                    matchers.map((m, i) => (i === index ? { ...m, value: event.target.value } : m)),
                  )
                }
              />
              <button
                type="button"
                className="button button--ghost button--small"
                aria-label={t("alerting.silences.removeMatcher", { index: index + 1 })}
                title={t("alerting.editor.removeLabelShort")}
                disabled={matchers.length === 1}
                onClick={() => setMatchers(matchers.filter((_, i) => i !== index))}
              >
                <Icon name="close" />
              </button>
            </div>
          ))}
          {matchers.length >= MAX_MATCHERS ? null : (
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => setMatchers([...matchers, { label: "", op: "=", value: "" }])}
            >
              <Icon name="plus" />
              {t("alerting.silences.addMatcher")}
            </button>
          )}
          <p className="field__hint">{t("alerting.silences.matchersHint")}</p>
        </fieldset>
        <div className="field">
          <span className="field__label" id={`${ids}-duration`}>
            {t("alerting.silences.duration")}
          </span>
          <Segmented
            label={t("alerting.silences.duration")}
            value={duration}
            options={DURATIONS.map((item) => ({ value: item.value, label: t(item.key) }))}
            onChange={setDuration}
          />
          {duration === "until" ? (
            <input
              type="datetime-local"
              className="input"
              value={until}
              aria-label={t("alerting.silences.untilLabel")}
              onChange={(event) => setUntil(event.target.value)}
            />
          ) : null}
          <p className="field__hint">
            {Number.isFinite(endsAt)
              ? t("alerting.silences.window", { from: time(now), to: time(endsAt), days: MAX_DAYS })
              : t("alerting.reason.alerts.silence_window_invalid")}
          </p>
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`${ids}-comment`}>
            {t("alerting.silences.comment")}
          </label>
          <input
            id={`${ids}-comment`}
            className="input"
            value={comment}
            maxLength={MAX_COMMENT}
            aria-required="true"
            onChange={(event) => setComment(event.target.value)}
          />
        </div>
        <div className="alert-note" aria-live="polite">
          {valid.length === 0 ? (
            t("alerting.silences.affectedNone")
          ) : list.length === 0 ? (
            t("alerting.silences.affectedZero")
          ) : (
            <span>
              {t("alerting.silences.affected", { count: list.length })}{" "}
              {list.slice(0, 5).map((instance) => (
                <span key={instance.fingerprint} className="alert-affected">
                  {instance.ruleName} · {labelPairs(instance.labels).join(", ")}{" "}
                  <StateLabel state={instance.state} quiet />
                </span>
              ))}
            </span>
          )}
        </div>
        {problem === null ? null : (
          <p className="field__error" role="alert">
            <Icon name="alert" />
            <span>{problem}</span>
          </p>
        )}
      </div>
    </Dialog>
  );
}
