import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, type RefObject, useId, useRef, useState } from "react";
import { isApiError } from "../../../api/client";
import { Icon } from "../../../components/Icon";
import { type Translate, useI18n } from "../../../i18n/i18n";
import { ConfirmDialog, Dialog } from "../../admin/components/Dialog";
import { errorText } from "../../admin/errors";
import { errorReason } from "../../datasources/reasons";
import { Segmented } from "../../settings/rows";
import {
  type AiKind,
  type AiProvider,
  type AiProviderPatch,
  type AiProviderTest,
  type AiScope,
  aiAdminKeys,
  createAiProvider,
  deleteAiProvider,
  isAiProvider,
  type LeavesNetwork,
  providerHost,
  TOKEN_LIMIT_FIELDS,
  type TokenLimitField,
  testAiProvider,
  updateAiProvider,
} from "../adminApi";
import { aiErrorText, aiReasonText } from "../reasons";
import "./ai-admin.css";

/** The fields of the dialog, in their order on the page (the first bad one gets focus). */
const FIELDS = ["name", "baseUrl", "apiKey", "model", "tokenLimitField"] as const;
type Field = (typeof FIELDS)[number];
type FieldErrors = Partial<Record<Field, string>>;

/** The Anthropic Messages API, by its maker's name in every language. */
const ANTHROPIC = "Anthropic";

const BASE_URL_EXAMPLE: Record<AiKind, string> = {
  openai: "http://localhost:11434/v1",
  anthropic: "https://api.anthropic.com",
};

/** The field a failed connection test is about, by its reason; undefined for the dialog. */
function testField(reason: string | undefined): Field | undefined {
  if (reason === undefined) {
    return undefined;
  }
  if (
    reason === "ai.provider_unauthorized" ||
    reason === "ai.key_unreadable" ||
    reason === "ai.key_required"
  ) {
    return "apiKey";
  }
  if (
    reason === "ai.provider_unreachable" ||
    reason === "ai.provider_timeout" ||
    reason.startsWith("ai.base_url_") ||
    reason.startsWith("target.")
  ) {
    return "baseUrl";
  }
  return undefined;
}

function isField(value: string | undefined): value is Field {
  return (FIELDS as readonly (string | undefined)[]).includes(value);
}

/** The text of a failed request: its reason when it has one, else the code's text. */
function failureText(t: Translate, error: unknown): string {
  return aiErrorText(t, error) ?? errorText(t, error);
}

/** A labelled field with its hint and, when the server refused it, the reason as an alert. */
function DialogField({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  error: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {children}
      {hint === undefined || hint === null ? null : (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p className="field__error" id={`${id}-error`} role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

function describedBy(id: string, hint: boolean, error: string | undefined): string | undefined {
  const parts = [error === undefined ? null : `${id}-error`, hint ? `${id}-hint` : null].filter(
    (part) => part !== null,
  );
  return parts.length === 0 ? undefined : parts.join(" ");
}

class LocalInvalid extends Error {}

/**
 * Adding or changing a provider (board frame 3): kind (only when adding), name, base URL, key,
 * model and, for OpenAI-compatible servers, the token field. "Test connection" checks what is
 * entered; the server tests a stored provider only, so the test first stores the entries, and
 * Cancel takes back a provider this dialog added. One explicit Save stores the rest. Refusals
 * land at their field with the server's reason, and the first bad field gets focus.
 */
export function ProviderDialog({
  scope,
  provider,
  onClose,
  onNotAllowed,
}: {
  scope: AiScope;
  /** The provider to change; undefined adds one. */
  provider: AiProvider | undefined;
  onClose: () => void;
  /** The server refused own providers of the organization (`ai.org_providers_not_allowed`). */
  onNotAllowed?: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const ids = useId();
  const [kind, setKind] = useState<AiKind>(provider?.kind === "anthropic" ? "anthropic" : "openai");
  const [name, setName] = useState(provider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? "");
  const [model, setModel] = useState(provider?.model ?? "");
  const [apiKey, setApiKey] = useState("");
  const [removeKey, setRemoveKey] = useState(false);
  const [leavesNetwork, setLeavesNetwork] = useState<LeavesNetwork>(
    provider?.leavesNetwork ?? "auto",
  );
  const [tokenLimitField, setTokenLimitField] = useState<TokenLimitField>(
    (TOKEN_LIMIT_FIELDS as readonly string[]).includes(provider?.tokenLimitField ?? "")
      ? (provider?.tokenLimitField as TokenLimitField)
      : "auto",
  );
  const [isDefault, setIsDefault] = useState(provider?.isDefault ?? false);
  // The provider as stored: the one being changed, or the one a test stored.
  const [saved, setSaved] = useState<AiProvider | null>(provider ?? null);
  const [createdHere, setCreatedHere] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [testResult, setTestResult] = useState<AiProviderTest | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | "delete" | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const refs: Record<Field, RefObject<HTMLInputElement | HTMLSelectElement | null>> = {
    name: useRef<HTMLInputElement>(null),
    baseUrl: useRef<HTMLInputElement>(null),
    apiKey: useRef<HTMLInputElement>(null),
    model: useRef<HTMLInputElement>(null),
    tokenLimitField: useRef<HTMLSelectElement>(null),
  };
  /** Shows the errors at their fields and moves focus to the first bad one. */
  function markFields(errors: FieldErrors) {
    setFieldErrors(errors);
    const first = FIELDS.find((field) => errors[field] !== undefined);
    if (first !== undefined) {
      refs[first].current?.focus();
    }
  }

  const editing = provider !== undefined;
  const openai = kind === "openai";
  const targetMoved = saved?.apiKeySet === true && baseUrl.trim() !== saved.baseUrl;

  function changes(stored: AiProvider): AiProviderPatch | null {
    const patch: AiProviderPatch = { expectedUpdatedAt: stored.updatedAt };
    let any = false;
    if (name.trim() !== stored.name) {
      patch.name = name.trim();
      any = true;
    }
    if (baseUrl.trim() !== stored.baseUrl) {
      patch.baseUrl = baseUrl.trim();
      any = true;
    }
    if (model.trim() !== stored.model) {
      patch.model = model.trim();
      any = true;
    }
    if (removeKey) {
      patch.apiKey = null;
      any = true;
    } else if (apiKey !== "") {
      patch.apiKey = apiKey;
      any = true;
    }
    if (openai && tokenLimitField !== stored.tokenLimitField) {
      patch.tokenLimitField = tokenLimitField;
      any = true;
    }
    if (leavesNetwork !== (stored.leavesNetwork ?? "auto")) {
      patch.leavesNetwork = leavesNetwork;
      any = true;
    }
    if (isDefault && !stored.isDefault) {
      patch.isDefault = true;
      any = true;
    }
    return any ? patch : null;
  }

  function checkLocally(): boolean {
    const errors: FieldErrors = {};
    if (name.trim() === "") errors.name = t("ai.admin.dialog.required");
    if (baseUrl.trim() === "") errors.baseUrl = t("ai.admin.dialog.required");
    if (model.trim() === "") errors.model = t("ai.admin.dialog.required");
    markFields(errors);
    return Object.keys(errors).length === 0;
  }

  /** Stores what is entered (adds the provider, or sends the changed fields). */
  async function persist(): Promise<AiProvider> {
    if (!checkLocally()) {
      throw new LocalInvalid();
    }
    let stored: AiProvider;
    if (saved === null) {
      stored = await createAiProvider(scope, {
        name: name.trim(),
        kind,
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        isDefault,
        ...(apiKey === "" ? {} : { apiKey }),
        ...(openai ? { tokenLimitField } : {}),
        leavesNetwork,
      });
      setCreatedHere(true);
    } else {
      const patch = changes(saved);
      if (patch === null) {
        return saved;
      }
      stored = await updateAiProvider(scope, saved.id, patch);
    }
    setSaved(stored);
    setApiKey("");
    setRemoveKey(false);
    void queryClient.invalidateQueries({ queryKey: aiAdminKeys.providers(scope) });
    return stored;
  }

  function showFailure(error: unknown) {
    if (error instanceof LocalInvalid) {
      return;
    }
    const field = isApiError(error) ? error.field : undefined;
    if (isField(field)) {
      markFields({ [field]: failureText(t, error) });
      return;
    }
    if (isApiError(error, "version_conflict")) {
      // Someone saved the provider in the meantime: the next Save goes over their version.
      if (isAiProvider(error.current)) {
        setSaved(error.current);
      }
      setFormError(t("ai.admin.dialog.conflict"));
      return;
    }
    if (errorReason(error)?.reason === "ai.org_providers_not_allowed") {
      onNotAllowed?.();
    }
    setFormError(failureText(t, error));
  }

  function startAttempt(what: "test" | "save" | "delete") {
    setBusy(what);
    setFieldErrors({});
    setFormError(undefined);
  }

  async function test() {
    if (busy !== null) return;
    startAttempt("test");
    setTestResult(null);
    try {
      const stored = await persist();
      const result = await testAiProvider(scope, stored.id);
      setTestResult(result);
      void queryClient.invalidateQueries({ queryKey: aiAdminKeys.providers(scope) });
      if (!result.ok) {
        const field = testField(result.reason);
        if (field !== undefined) {
          markFields({ [field]: testText(t, result) });
        }
      }
    } catch (error) {
      showFailure(error);
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    if (busy !== null) return;
    startAttempt("save");
    try {
      await persist();
      onClose();
    } catch (error) {
      showFailure(error);
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    if (createdHere && saved !== null) {
      // Added only to be tested: Cancel takes it back.
      await deleteAiProvider(scope, saved.id).catch(() => undefined);
      void queryClient.invalidateQueries({ queryKey: aiAdminKeys.providers(scope) });
    }
    onClose();
  }

  async function remove() {
    if (saved === null || busy !== null) return;
    startAttempt("delete");
    try {
      await deleteAiProvider(scope, saved.id);
      void queryClient.invalidateQueries({ queryKey: aiAdminKeys.providers(scope) });
      setConfirmDelete(false);
      onClose();
    } catch (error) {
      setConfirmDelete(false);
      showFailure(error);
    } finally {
      setBusy(null);
    }
  }

  const failedTest = testResult !== null && !testResult.ok;
  const failedAtField = failedTest && testField(testResult.reason) !== undefined;
  const keyHint: string = removeKey
    ? t("ai.admin.dialog.keyRemoved")
    : targetMoved && apiKey === ""
      ? t("ai.admin.dialog.keyResend")
      : saved?.apiKeySet === true
        ? t("ai.admin.dialog.keyStoredHint")
        : kind === "anthropic"
          ? t("ai.admin.dialog.keyRequired")
          : t("ai.admin.dialog.keyOptional");

  return (
    <>
      <Dialog
        open
        wide
        title={
          editing
            ? t("ai.admin.dialog.editTitle", { name: provider.name })
            : t("ai.admin.dialog.addTitle")
        }
        onClose={() => void cancel()}
        {...(editing ? { initialFocus: refs.name } : {})}
        footer={
          <div className="ai-dialog__footer">
            <button
              type="button"
              className="button button--secondary"
              aria-disabled={busy !== null}
              onClick={() => void test()}
            >
              <Icon name="refresh" />
              {busy === "test" ? t("ai.admin.dialog.testing") : t("ai.admin.dialog.test")}
            </button>
            <span className="ai-dialog__spacer" />
            {saved !== null && !createdHere ? (
              <button
                type="button"
                className="button button--ghost"
                onClick={() => setConfirmDelete(true)}
              >
                {t("ai.admin.dialog.delete")}
              </button>
            ) : null}
            <button
              type="button"
              className="button button--secondary"
              onClick={() => void cancel()}
            >
              {t("ai.admin.dialog.cancel")}
            </button>
            <button
              type="button"
              className="button button--primary"
              aria-disabled={busy !== null}
              onClick={() => void save()}
            >
              {busy === "save" ? t("ai.admin.dialog.saving") : t("ai.admin.dialog.save")}
            </button>
          </div>
        }
      >
        <form
          className="form ai-dialog"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {formError === undefined ? null : (
            <p className="ai-alarm" role="alert">
              {formError}
            </p>
          )}
          {failedTest && failedAtField ? (
            <p className="ai-alarm" role="alert">
              <strong>{t("ai.admin.dialog.testFailed")}</strong> {t("ai.admin.dialog.checkField")}
            </p>
          ) : null}
          <div className="field">
            <span className="field__label" id={`${ids}-kind`}>
              {t("ai.admin.dialog.kind")}
            </span>
            {editing ? (
              <p className="ai-dialog__value">
                {kindLabel(t, provider.kind)}
                <span className="field__hint">{t("ai.admin.dialog.kindFixed")}</span>
              </p>
            ) : (
              <Segmented
                labelled={{ "aria-labelledby": `${ids}-kind` }}
                value={kind}
                options={[
                  { value: "openai", label: t("ai.admin.kind.openai") },
                  { value: "anthropic", label: ANTHROPIC },
                ]}
                onChange={(value) => setKind(value === "anthropic" ? "anthropic" : "openai")}
              />
            )}
            {editing ? null : <p className="field__hint">{t("ai.admin.dialog.kindHint")}</p>}
          </div>
          <DialogField
            id={`${ids}-name`}
            label={t("ai.admin.dialog.name")}
            error={fieldErrors.name}
          >
            <input
              ref={refs.name as RefObject<HTMLInputElement>}
              id={`${ids}-name`}
              className="input"
              value={name}
              autoComplete="off"
              aria-invalid={fieldErrors.name === undefined ? undefined : true}
              aria-describedby={describedBy(`${ids}-name`, false, fieldErrors.name)}
              onChange={(event) => setName(event.currentTarget.value)}
            />
          </DialogField>
          <DialogField
            id={`${ids}-url`}
            label={t("ai.admin.dialog.baseUrl")}
            hint={t(
              openai ? "ai.admin.dialog.baseUrlHintOpenai" : "ai.admin.dialog.baseUrlHintAnthropic",
            )}
            error={fieldErrors.baseUrl}
          >
            <input
              ref={refs.baseUrl as RefObject<HTMLInputElement>}
              id={`${ids}-url`}
              className="input input--mono"
              value={baseUrl}
              placeholder={BASE_URL_EXAMPLE[kind]}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={fieldErrors.baseUrl === undefined ? undefined : true}
              aria-describedby={describedBy(`${ids}-url`, true, fieldErrors.baseUrl)}
              onChange={(event) => setBaseUrl(event.currentTarget.value)}
            />
          </DialogField>
          <DialogField
            id={`${ids}-key`}
            label={t("ai.admin.dialog.apiKey")}
            hint={keyHint}
            error={fieldErrors.apiKey}
          >
            <span className="ai-dialog__key">
              <input
                ref={refs.apiKey as RefObject<HTMLInputElement>}
                id={`${ids}-key`}
                className="input input--mono"
                type="password"
                value={apiKey}
                disabled={removeKey}
                placeholder={saved?.apiKeySet === true ? t("ai.admin.dialog.keyStored") : ""}
                autoComplete="new-password"
                spellCheck={false}
                aria-invalid={fieldErrors.apiKey === undefined ? undefined : true}
                aria-describedby={describedBy(`${ids}-key`, true, fieldErrors.apiKey)}
                onChange={(event) => setApiKey(event.currentTarget.value)}
              />
              {saved?.apiKeySet === true ? (
                <button
                  type="button"
                  className="button button--ghost button--small"
                  aria-pressed={removeKey}
                  onClick={() => {
                    setRemoveKey((value) => !value);
                    setApiKey("");
                  }}
                >
                  {removeKey ? t("ai.admin.dialog.keepKey") : t("ai.admin.dialog.removeKey")}
                </button>
              ) : null}
            </span>
          </DialogField>
          <div className={openai ? "ai-dialog__pair" : undefined}>
            <DialogField
              id={`${ids}-model`}
              label={t("ai.admin.dialog.model")}
              hint={t("ai.admin.dialog.modelHint")}
              error={fieldErrors.model}
            >
              <input
                ref={refs.model as RefObject<HTMLInputElement>}
                id={`${ids}-model`}
                className="input input--mono"
                value={model}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={fieldErrors.model === undefined ? undefined : true}
                aria-describedby={describedBy(`${ids}-model`, true, fieldErrors.model)}
                onChange={(event) => setModel(event.currentTarget.value)}
              />
            </DialogField>
            {openai ? (
              <DialogField
                id={`${ids}-tokens`}
                label={t("ai.admin.dialog.tokenLimitField")}
                hint={t("ai.admin.dialog.tokenLimitFieldHint")}
                error={fieldErrors.tokenLimitField}
              >
                <select
                  ref={refs.tokenLimitField as RefObject<HTMLSelectElement>}
                  id={`${ids}-tokens`}
                  className="select"
                  value={tokenLimitField}
                  aria-invalid={fieldErrors.tokenLimitField === undefined ? undefined : true}
                  aria-describedby={describedBy(`${ids}-tokens`, true, fieldErrors.tokenLimitField)}
                  onChange={(event) =>
                    setTokenLimitField(event.currentTarget.value as TokenLimitField)
                  }
                >
                  <option value="auto">{t("ai.admin.dialog.tokenLimitAuto")}</option>
                  <option value="max_tokens">max_tokens</option>
                  <option value="max_completion_tokens">max_completion_tokens</option>
                </select>
              </DialogField>
            ) : null}
          </div>
          <DialogField
            id={`${ids}-network`}
            label={t("ai.admin.dialog.leavesNetwork")}
            hint={t("ai.admin.dialog.leavesNetworkHint")}
            error={undefined}
          >
            <select
              id={`${ids}-network`}
              className="select"
              value={leavesNetwork}
              aria-describedby={describedBy(`${ids}-network`, true, undefined)}
              onChange={(event) => setLeavesNetwork(event.currentTarget.value as LeavesNetwork)}
            >
              <option value="auto">{t("ai.admin.dialog.leavesNetworkAuto")}</option>
              <option value="yes">{t("ai.admin.dialog.leavesNetworkYes")}</option>
              <option value="no">{t("ai.admin.dialog.leavesNetworkNo")}</option>
            </select>
          </DialogField>
          <label className="ai-dialog__check">
            <input
              type="checkbox"
              checked={isDefault}
              disabled={saved?.isDefault === true}
              onChange={(event) => setIsDefault(event.currentTarget.checked)}
            />
            <span>
              {t("ai.admin.dialog.isDefault")}
              <span className="field__hint">{t("ai.admin.dialog.isDefaultHint")}</span>
            </span>
          </label>
          <p className="field__hint">{t("ai.admin.dialog.testStores")}</p>
          {testResult?.ok === true ? (
            <p className="ai-note" role="status">
              <span>
                <strong>{t("ai.admin.dialog.testOk")}</strong>{" "}
                {t("ai.admin.dialog.testOkDetail", {
                  ms: Math.round(testResult.latencyMs),
                  reply: (testResult.reply ?? "").slice(0, 80),
                  host: providerHost(baseUrl.trim()),
                })}
              </span>
            </p>
          ) : null}
          {failedTest && !failedAtField ? (
            <p className="ai-alarm" role="alert">
              <strong>{t("ai.admin.dialog.testFailed")}</strong> {testText(t, testResult)}
            </p>
          ) : null}
        </form>
      </Dialog>
      <ConfirmDialog
        open={confirmDelete}
        title={t("ai.admin.dialog.deleteTitle")}
        confirmLabel={t("ai.admin.dialog.deleteConfirm")}
        busy={busy === "delete"}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => void remove()}
      >
        {t("ai.admin.dialog.deleteText", { name: saved?.name ?? "" })}
      </ConfirmDialog>
    </>
  );
}

/** The outcome of a failed test in the user's language, with the provider's own detail. */
export function testText(t: Translate, result: AiProviderTest): string {
  if (result.reason === undefined) {
    return result.message ?? "";
  }
  return (
    aiReasonText(t, {
      reason: result.reason,
      params: { status: "", detail: "", ...(result.params ?? {}) },
      fallback: result.message,
    }) ??
    result.message ??
    result.reason
  );
}

export function kindLabel(t: Translate, kind: string): string {
  if (kind === "openai") return t("ai.admin.kind.openai");
  if (kind === "anthropic") return ANTHROPIC;
  return kind;
}
