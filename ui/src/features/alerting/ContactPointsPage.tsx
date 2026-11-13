import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { isApiError } from "../../api/client";
import { Icon } from "../../components/Icon";
import { PageActions } from "../../components/Page";
import { Select } from "../../components/Select";
import { ToolbarMenu, type ToolbarMenuEntry } from "../../components/ToolbarMenu";
import { useI18n } from "../../i18n/i18n";
import { writeClipboard } from "../../lib/clipboard";
import { showToast } from "../../lib/toasts";
import { useCurrentOrg } from "../../org/useOrg";
import { ConfirmDialog, Dialog } from "../admin/components/Dialog";
import { errorReason } from "../datasources/reasons";
import {
  ALERTING_KEY,
  CONTACT_KINDS,
  type ContactKind,
  type ContactPoint,
  type ContactPointInput,
  contactPointsQuery,
  createContactPoint,
  deleteContactPoint,
  rotateSecret,
  type TestResult,
  testContactPoint,
  updateContactPoint,
} from "./api";
import { GroupedMessage, sampleGroup } from "./GroupedMessage";
import { chatUrlText, contactSummary } from "./RuleEditorPage";
import { alertingErrorText, deliveryResultText } from "./reasons";
import { AlertingLayout, Segmented, useAlerting, useAlertTime } from "./shared";

const MAX_RECIPIENTS = 20;

/** The editor of one contact point: a new one of either kind, or an existing one. */
type Editing = { point: ContactPoint | null };

/**
 * "Alerting > Kontaktpunkte" (board frames 8A and 8B): where notifications go. Organization
 * admins (`alerts:contacts`) add, change, test and delete them and renew a webhook's secret;
 * everyone else sees the list read-only with recipients as a count and webhooks by host.
 */
export function ContactPointsPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { orgId, canContacts, status } = useAlerting();
  const points = useQuery({ ...contactPointsQuery(orgId), enabled: orgId !== "" });
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<ContactPoint | null>(null);
  const [secret, setSecret] = useState<{ name: string; secret: string } | null>(null);
  const time = useAlertTime();

  const remove = useMutation({
    mutationFn: (point: ContactPoint) => deleteContactPoint(orgId, point.id),
    onSuccess: async (_, point) => {
      setDeleting(null);
      showToast({ message: t("alerting.contact.deleted", { name: point.name }) });
      await queryClient.invalidateQueries({ queryKey: [ALERTING_KEY, orgId] });
    },
  });
  // A secret lives only while its dialog shows: the answers that carried it are not kept.
  const rotate = useMutation({
    gcTime: 0,
    mutationFn: (point: ContactPoint) => rotateSecret(orgId, point.id),
    onSuccess: async (answer, point) => {
      setSecret({ name: point.name, secret: answer.secret });
      await queryClient.invalidateQueries({ queryKey: [ALERTING_KEY, orgId, "contact-points"] });
    },
    onError: (error) => showToast({ message: alertingErrorText(t, error), error: true }),
  });
  const test = useMutation({
    mutationFn: (point: ContactPoint) => testContactPoint(orgId, point.id),
    onSuccess: (result, point) =>
      showToast({
        message: testText(t, result, point.name),
        ...(result.ok ? {} : { error: true }),
      }),
    onError: (error) => showToast({ message: testErrorText(t, error), error: true }),
  });

  const list = points.data ?? [];
  const failed = list.filter((point) => point.lastDelivery !== null && !point.lastDelivery.ok);

  return (
    <AlertingLayout
      tab="contactPoints"
      lead={t(canContacts ? "alerting.contact.leadAdmin" : "alerting.contact.lead")}
      actions={
        canContacts ? (
          <PageActions>
            <button
              type="button"
              className="button button--primary"
              onClick={() => setEditing({ point: null })}
            >
              <Icon name="plus" />
              {t("alerting.contact.add")}
            </button>
          </PageActions>
        ) : null
      }
    >
      {canContacts ? null : (
        <p className="alert-note">
          <Icon name="lock" />
          <span>{t("alerting.contact.readOnly")}</span>
        </p>
      )}
      {points.isError ? <p className="field__error">{alertingErrorText(t, points.error)}</p> : null}
      {failed.map((point) => (
        <p key={point.id} className="alert-alarm" role="status">
          <span>
            <strong>{point.name}</strong>:{" "}
            {t("alerting.contact.failed", {
              error: deliveryResultText(t, point.lastDelivery?.error ?? "failed"),
              rules: point.rules,
            })}{" "}
            <Link to="/alerting/history" search={{ kind: "delivery" }}>
              {t("alerting.contact.toHistory")}
            </Link>
          </span>
        </p>
      ))}
      {points.isSuccess && list.length === 0 ? (
        <p className="alert-card alert-pad alert-muted">{t("alerting.contact.empty")}</p>
      ) : null}
      {list.length === 0 ? null : (
        <div className="alert-card alert-table-wrap">
          <table className="alert-table">
            <thead>
              <tr>
                <th scope="col">{t("alerting.contact.column.name")}</th>
                <th scope="col">{t("alerting.contact.column.kind")}</th>
                <th scope="col">{t("alerting.contact.column.delivery")}</th>
                <th scope="col" className="alert-num">
                  {t("alerting.contact.column.rules")}
                </th>
                {canContacts ? (
                  <th scope="col">
                    <span className="visually-hidden">{t("alerting.rules.column.actions")}</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {list.map((point) => {
                const entries: ToolbarMenuEntry[] = [
                  {
                    key: "edit",
                    label: t("alerting.contact.menu.edit"),
                    icon: "edit",
                    onSelect: () => setEditing({ point }),
                  },
                  {
                    key: "test",
                    label: t("alerting.contact.test"),
                    icon: "upload",
                    onSelect: () => test.mutate(point),
                  },
                  ...(point.kind === "webhook"
                    ? [
                        {
                          key: "rotate",
                          label: t("alerting.contact.rotate"),
                          icon: "refresh" as const,
                          onSelect: () => rotate.mutate(point),
                        },
                      ]
                    : []),
                  { kind: "separator", key: "sep" },
                  {
                    key: "delete",
                    label: t("alerting.contact.menu.delete"),
                    icon: "trash",
                    danger: true,
                    onSelect: () => setDeleting(point),
                  },
                ];
                return (
                  <tr key={point.id}>
                    <td>
                      <span className="alert-rule-name">{point.name}</span>
                      <span className="alert-sub">{contactSummary(t, point)}</span>
                    </td>
                    <td>
                      <span className="alert-chip">{t(`alerting.contact.kind.${point.kind}`)}</span>
                    </td>
                    <td>
                      {point.lastDelivery === null ? (
                        <span className="alert-muted">{t("alerting.contact.never")}</span>
                      ) : point.lastDelivery.ok ? (
                        t("alerting.contact.delivered", { at: time(point.lastDelivery.at) })
                      ) : (
                        <span className="alert-warn-text">
                          {t("alerting.contact.deliveryFailed", {
                            at: time(point.lastDelivery.at),
                            error: deliveryResultText(t, point.lastDelivery.error ?? "failed"),
                          })}
                        </span>
                      )}
                    </td>
                    <td className="alert-num">{point.rules}</td>
                    {canContacts ? (
                      <td>
                        <ToolbarMenu
                          label={t("alerting.contact.menu.label", { name: point.name })}
                          icon="more"
                          entries={entries}
                        />
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="alert-hint">
        {t(canContacts ? "alerting.contact.footerAdmin" : "alerting.contact.footer")}
      </p>
      {editing === null ? null : (
        <ContactPointDialog
          key={editing.point?.id ?? "new"}
          orgId={orgId}
          point={editing.point}
          mailConfigured={status?.mailConfigured ?? true}
          onClose={() => setEditing(null)}
          onCreated={(name, value) => {
            setEditing(null);
            if (value !== null) setSecret({ name, secret: value });
          }}
          onRotate={(point) => rotate.mutate(point)}
        />
      )}
      <SecretDialog
        value={secret}
        onClose={() => {
          setSecret(null);
          rotate.reset();
        }}
      />
      <ConfirmDialog
        open={deleting !== null}
        title={t("alerting.contact.deleteTitle", { name: deleting?.name ?? "" })}
        confirmLabel={t("alerting.contact.menu.delete")}
        busy={remove.isPending}
        error={remove.isError ? deleteErrorText(t, remove.error) : null}
        onConfirm={() => deleting !== null && remove.mutate(deleting)}
        onClose={() => {
          setDeleting(null);
          remove.reset();
        }}
      >
        {t("alerting.contact.deleteText")}
      </ConfirmDialog>
    </AlertingLayout>
  );
}

function testText(t: ReturnType<typeof useI18n>["t"], result: TestResult, name: string): string {
  if (result.result === "429" && result.retryAfterSecs !== null) {
    return t("alerting.contact.testThrottled", { name, secs: result.retryAfterSecs });
  }
  if (result.ok) {
    return result.durationMs === null
      ? t("alerting.contact.testSent", { name })
      : t("alerting.contact.testOk", { name, ms: result.durationMs });
  }
  return t("alerting.contact.testFailed", { name, error: deliveryResultText(t, result.result) });
}

/** A contact point in use: by rules, and since 0.7.2 by policies, which are named. */
function deleteErrorText(t: ReturnType<typeof useI18n>["t"], error: unknown): string {
  const reason = errorReason(error);
  const policies = reason?.params?.policies;
  if (
    reason?.reason === "alerts.contact_point_in_use" &&
    policies !== undefined &&
    policies !== ""
  ) {
    return t("alerting.contact.inUsePolicies", { rules: reason.params?.rules ?? "0", policies });
  }
  return alertingErrorText(t, error);
}

/** Reasons about the URL, shown at its field. */
function urlReason(error: unknown): boolean {
  const reason = errorReason(error)?.reason;
  return (
    reason === "alerts.chat_url_invalid" ||
    reason === "alerts.webhook_url_invalid" ||
    reason === "alerts.webhook_url_kalzit" ||
    (reason?.startsWith("target.") ?? false)
  );
}

function testErrorText(t: ReturnType<typeof useI18n>["t"], error: unknown): string {
  if (isApiError(error, "rate_limited")) return t("alerting.contact.testLimited");
  if (isApiError(error) && (error.status === 404 || error.status === 405)) {
    return t("alerting.contact.testMissing");
  }
  return alertingErrorText(t, error);
}

/**
 * Adds or changes a contact point (board frame 8A): mail with up to 20 recipients, or a webhook
 * with its URL, the signing secret (renewable) and how a receiver checks the signature. One
 * explicit save; the kind is fixed once saved.
 */
function ContactPointDialog({
  orgId,
  point,
  mailConfigured,
  onClose,
  onCreated,
  onRotate,
}: {
  orgId: string;
  point: ContactPoint | null;
  mailConfigured: boolean;
  onClose: () => void;
  onCreated: (name: string, secret: string | null) => void;
  onRotate: (point: ContactPoint) => void;
}) {
  const { t } = useI18n();
  const ids = useId();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<ContactKind>(
    point?.kind ?? (mailConfigured ? "mail" : "webhook"),
  );
  const [name, setName] = useState(point?.name ?? "");
  const [language, setLanguage] = useState<"de" | "en">(point?.language ?? "de");
  const [recipients, setRecipients] = useState((point?.recipients ?? []).join("\n"));
  const [url, setUrl] = useState(point?.url ?? "");
  // Slack and Teams: the stored URL is never shown again; "Ersetzen" asks for a new one.
  const [replacing, setReplacing] = useState(point === null);
  const [problem, setProblem] = useState<string | null>(null);
  // A problem with the URL shows at its field.
  const [urlProblem, setUrlProblem] = useState<string | null>(null);
  const chat = kind === "slack" || kind === "teams";
  const { language: uiLanguage } = useI18n();
  const org = useCurrentOrg();
  const [tested, setTested] = useState<string | null>(null);

  const list = recipients
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  const save = useMutation({
    gcTime: 0,
    mutationFn: async () => {
      const input: ContactPointInput =
        kind === "mail"
          ? { name: name.trim(), kind, language, recipients: list }
          : chat && !replacing
            ? { name: name.trim(), kind, language }
            : { name: name.trim(), kind, language, url: url.trim() };
      if (point === null) return createContactPoint(orgId, input);
      return {
        point: await updateContactPoint(orgId, point.id, { ...input, version: point.version }),
        secret: null,
      };
    },
    onSuccess: async (answer) => {
      showToast({ message: t("alerting.contact.saved", { name: answer.point.name }) });
      await queryClient.invalidateQueries({ queryKey: [ALERTING_KEY, orgId] });
      if (point === null) onCreated(answer.point.name, answer.secret);
      else onClose();
    },
    onError: (error) => {
      if (urlReason(error)) setUrlProblem(alertingErrorText(t, error));
      else setProblem(alertingErrorText(t, error));
    },
  });
  const test = useMutation({
    mutationFn: () => testContactPoint(orgId, point?.id ?? ""),
    onSuccess: (result) => setTested(testText(t, result, point?.name ?? "")),
    onError: (error) => setTested(testErrorText(t, error)),
  });

  function submit() {
    if (name.trim() === "") {
      setProblem(t("alerting.contact.nameRequired"));
      return;
    }
    if (kind === "mail" && (list.length === 0 || list.length > MAX_RECIPIENTS)) {
      setProblem(t("alerting.reason.alerts.recipients_invalid", { max: MAX_RECIPIENTS }));
      return;
    }
    if (kind === "webhook" && !/^https?:\/\//i.test(url.trim())) {
      setProblem(t("alerting.reason.alerts.webhook_url_invalid"));
      return;
    }
    if (chat && replacing && !/^https:\/\/[^/\s]+/i.test(url.trim())) {
      setProblem(null);
      setUrlProblem(t("alerting.reason.alerts.chat_url_invalid"));
      document.getElementById(`${ids}-url`)?.focus();
      return;
    }
    setProblem(null);
    setUrlProblem(null);
    save.mutate();
  }

  return (
    <Dialog
      open
      wide
      title={point === null ? t("alerting.contact.newTitle") : point.name}
      onClose={onClose}
      footer={
        <>
          {point === null ? null : (
            <button
              type="button"
              className="button button--secondary"
              aria-disabled={test.isPending || undefined}
              onClick={() => !test.isPending && test.mutate()}
            >
              {t(kind === "mail" ? "alerting.contact.testMail" : "alerting.contact.test")}
            </button>
          )}
          <span className="alert-spacer" />
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("alerting.editor.cancel")}
          </button>
          <button
            type="button"
            className="button button--primary"
            aria-disabled={save.isPending || undefined}
            onClick={() => !save.isPending && submit()}
          >
            {t("alerting.editor.save")}
          </button>
        </>
      }
    >
      <div className="alert-dialog-body">
        {point === null ? (
          <Segmented
            label={t("alerting.contact.column.kind")}
            value={kind}
            options={CONTACT_KINDS.map((value) => ({
              value,
              label: t(`alerting.contact.kind.${value}`),
            }))}
            onChange={(value) => setKind(value as ContactKind)}
          />
        ) : null}
        {kind === "mail" && !mailConfigured ? (
          <p className="alert-note">
            <span>
              {t("alerting.contact.noMail")}{" "}
              <Link to="/settings/$section" params={{ section: "email" }}>
                {t("alerting.contact.toMail")}
              </Link>
            </span>
          </p>
        ) : null}
        <div className="field">
          <label className="field__label" htmlFor={`${ids}-name`}>
            {t("alerting.editor.name")}
          </label>
          <input
            id={`${ids}-name`}
            className="input"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        {kind === "mail" ? (
          <div className="field">
            <label className="field__label" htmlFor={`${ids}-recipients`}>
              {t("alerting.contact.recipients", { max: MAX_RECIPIENTS })}
            </label>
            <textarea
              id={`${ids}-recipients`}
              className="input input--mono alert-textarea"
              rows={4}
              value={recipients}
              disabled={!mailConfigured}
              spellCheck={false}
              aria-describedby={`${ids}-recipients-hint`}
              onChange={(event) => setRecipients(event.target.value)}
            />
            <p className="field__hint" id={`${ids}-recipients-hint`}>
              {t("alerting.contact.recipientsHint")}
            </p>
          </div>
        ) : chat ? (
          <div className="field">
            <p className="field__hint">{t(`alerting.contact.${kind}Hint`)}</p>
            <label className="field__label" htmlFor={`${ids}-url`}>
              {t("alerting.contact.url")}
            </label>
            {replacing ? (
              <input
                id={`${ids}-url`}
                className="input input--mono"
                type="url"
                value={url}
                placeholder="https://"
                spellCheck={false}
                autoComplete="off"
                aria-invalid={urlProblem === null ? undefined : true}
                aria-describedby={
                  urlProblem === null ? `${ids}-url-hint` : `${ids}-url-error ${ids}-url-hint`
                }
                onChange={(event) => setUrl(event.target.value)}
              />
            ) : (
              <div className="alert-row-actions">
                <span id={`${ids}-url`} className="alert-chip alert-chip--mono" translate="no">
                  {chatUrlText(point)}
                </span>
                <button
                  type="button"
                  className="button button--secondary button--small"
                  onClick={() => {
                    setUrl("");
                    setReplacing(true);
                  }}
                >
                  {t("alerting.contact.replace")}
                </button>
              </div>
            )}
            {urlProblem === null ? null : (
              <p className="field__error" id={`${ids}-url-error`} role="alert">
                <Icon name="alert" />
                <span>{urlProblem}</span>
              </p>
            )}
            <p className="field__hint" id={`${ids}-url-hint`}>
              {t("alerting.contact.chatSecretHint")}
            </p>
          </div>
        ) : (
          <>
            <div className="field">
              <label className="field__label" htmlFor={`${ids}-url`}>
                {t("alerting.contact.url")}
              </label>
              <input
                id={`${ids}-url`}
                className="input input--mono"
                type="url"
                value={url}
                placeholder="https://"
                spellCheck={false}
                aria-describedby={`${ids}-url-hint`}
                onChange={(event) => setUrl(event.target.value)}
              />
              {urlProblem === null ? null : (
                <p className="field__error" role="alert">
                  <Icon name="alert" />
                  <span>{urlProblem}</span>
                </p>
              )}
              <p className="field__hint" id={`${ids}-url-hint`}>
                {t("alerting.contact.urlHint")}
              </p>
              {url.trim().toLowerCase().startsWith("http://") ? (
                <p className="field__hint">{t("alerting.contact.insecure")}</p>
              ) : null}
            </div>
            {point === null ? (
              <p className="field__hint">{t("alerting.contact.secretAfterSave")}</p>
            ) : (
              <div className="field">
                <span className="field__label">{t("alerting.contact.secret")}</span>
                <div className="alert-row-actions">
                  <span className="alert-chip alert-chip--mono">••••••••</span>
                  <button
                    type="button"
                    className="button button--secondary button--small"
                    onClick={() => onRotate(point)}
                  >
                    {t("alerting.contact.rotate")}
                  </button>
                </div>
                <p className="field__hint">{t("alerting.contact.secretHint")}</p>
              </div>
            )}
          </>
        )}
        <div className="field">
          <label className="field__label" htmlFor={`${ids}-language`}>
            {t("alerting.contact.language")}
          </label>
          <Select
            id={`${ids}-language`}
            value={language}
            onChange={(value) => setLanguage(value === "en" ? "en" : "de")}
          >
            <option value="de">{t("alerting.contact.german")}</option>
            <option value="en">{t("alerting.contact.english")}</option>
          </Select>
        </div>
        {kind === "mail" || chat ? (
          <div className="field">
            <span className="field__label">{t("alerting.contact.content")}</span>
            <GroupedMessage
              kind={kind === "mail" ? "mail" : kind}
              group={sampleGroup(t, org?.name ?? "", uiLanguage)}
            />
            <p className="field__hint">
              {t(
                kind === "mail"
                  ? "alerting.contact.sender"
                  : kind === "slack"
                    ? "alerting.contact.slackContent"
                    : "alerting.contact.teamsContent",
              )}
            </p>
          </div>
        ) : (
          <div className="field">
            <span className="field__label">{t("alerting.contact.verify")}</span>
            <pre className="alert-code" translate="no">
              {[
                "POST /… HTTP/1.1",
                "Content-Type: application/json",
                "Kalzit-Event: firing",
                "Kalzit-Delivery: 01JCF3Q8W2…",
                "Kalzit-Signature: t=<unix>,v1=<hex>",
                "",
                `// v1 = HMAC-SHA256(secret, t + "." + body)`,
              ].join("\n")}
            </pre>
            <p className="field__hint">{t("alerting.contact.verifyHint")}</p>
          </div>
        )}
        {tested === null ? null : (
          <p className="alert-note" role="status">
            {tested}
          </p>
        )}
        {chat ? (
          <p className="field__hint">
            {t(
              point === null
                ? "alerting.contact.testAfterSave"
                : `alerting.contact.${kind}TestHint`,
            )}
          </p>
        ) : null}
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

/** The signing secret, shown once after it was made or renewed. */
function SecretDialog({
  value,
  onClose,
}: {
  value: { name: string; secret: string } | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog
      open={value !== null}
      title={t("alerting.contact.secretTitle", { name: value?.name ?? "" })}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="button button--secondary"
            onClick={() =>
              void writeClipboard(value?.secret ?? "").then((ok) =>
                showToast({
                  message: t(ok ? "alerting.contact.copied" : "alerting.contact.copyFailed"),
                }),
              )
            }
          >
            <Icon name="copy" />
            {t("alerting.contact.copy")}
          </button>
          <button type="button" className="button button--primary" onClick={onClose}>
            {t("alerting.contact.secretDone")}
          </button>
        </>
      }
    >
      <p>{t("alerting.contact.secretText")}</p>
      <pre className="alert-code alert-secret" translate="no">
        {value?.secret ?? ""}
      </pre>
    </Dialog>
  );
}
