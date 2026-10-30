import { useQuery } from "@tanstack/react-query";
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import { isApiError } from "../../../api/client";
import { Icon } from "../../../components/Icon";
import { type Translate, useI18n } from "../../../i18n/i18n";
import { writeClipboard } from "../../../lib/clipboard";
import { leavePage } from "../../../lib/leavePage";
import { reasonText } from "../../datasources/reasons";
import { Dialog } from "../components/Dialog";
import { LoadState } from "../components/Section";
import {
  checkProvider,
  createProvider,
  fetchProvider,
  fetchTestSignIn,
  type Provider,
  type ProviderCheck,
  type ProviderInput,
  ssoKeys,
  startTestSignIn,
  type TestSignInStart,
  updateProvider,
} from "./api";
import { outcomeText, ssoErrorText, testFailureText } from "./texts";
import "../../settings/settings.css";
import "./sso.css";

/** The fields of the form, in their order on the page (the first bad one gets focus). */
const FIELDS = [
  "name",
  "slug",
  "issuer",
  "clientId",
  "clientSecret",
  "groupsClaim",
  "scopes",
  "emailClaim",
  "nameClaim",
] as const;
type Field = (typeof FIELDS)[number];
type FieldErrors = Partial<Record<Field, string>>;

/** Fields behind "Advanced", which opens when one of them is refused. */
const ADVANCED: readonly Field[] = ["emailClaim", "nameClaim"];

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** How often a running test sign-in is asked for its result. */
const TEST_POLL_MS = 2000;

/** A slug from a provider's name: "Müller SSO" becomes "mueller-sso". */
export function slugFrom(name: string): string {
  return name
    .toLowerCase()
    .replaceAll("ä", "ae")
    .replaceAll("ö", "oe")
    .replaceAll("ü", "ue")
    .replaceAll("ß", "ss")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

function isField(value: string | undefined): value is Field {
  return (FIELDS as readonly (string | undefined)[]).includes(value);
}

/** The field the server named, without the `oidc.` of the nested form. */
function serverField(error: unknown): Field | undefined {
  const field = isApiError(error) ? error.field?.replace(/^oidc\./, "") : undefined;
  return isField(field) ? field : undefined;
}

function describedBy(id: string, hint: boolean, error: string | undefined): string | undefined {
  const parts = [error === undefined ? null : `${id}-error`, hint ? `${id}-hint` : null].filter(
    (part) => part !== null,
  );
  return parts.length === 0 ? undefined : parts.join(" ");
}

/** A labelled field with its hint and, when refused, the reason below it. */
function FormField({
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
      {hint === undefined ? null : (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {error === undefined ? null : (
        <p className="field__error" id={`${id}-error`}>
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

/**
 * Adding or changing an OpenID Connect provider (board frame 5C). "Check connection" reads the
 * discovery and keys and offers the client to the token endpoint; Save stays off until the check
 * passed for the issuer, client id and secret now entered (a stored provider whose connection is
 * unchanged needs none). "Test sign-in" opens the provider in a new window and shows which groups
 * arrive and what the mapping would make of them; it signs nobody in.
 */
export function ProviderDialog({
  redirectBase,
  providerId,
  startTest,
  onClose,
  onSaved,
}: {
  redirectBase: string;
  /** The provider to change; undefined adds one. */
  providerId: string | undefined;
  /** Opened from the menu's "Test sign-in": checks and starts the test right away. */
  startTest: boolean;
  onClose: () => void;
  onSaved: (name: string, created: boolean) => void;
}) {
  const { t } = useI18n();
  const stored = useQuery({
    queryKey: ssoKeys.provider(providerId ?? ""),
    queryFn: () => fetchProvider(providerId ?? ""),
    enabled: providerId !== undefined,
    // The form starts from what is stored now, not from an older copy.
    staleTime: 0,
    gcTime: 0,
  });
  if (providerId !== undefined && stored.data === undefined) {
    return (
      <Dialog open wide title={t("sso.form.editTitle")} onClose={onClose}>
        <LoadState error={stored.error} onRetry={() => void stored.refetch()} />
      </Dialog>
    );
  }
  return (
    <ProviderForm
      redirectBase={redirectBase}
      provider={stored.data}
      startTest={startTest}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

/** The result of the connection check, for the values it was made with. */
interface Checked {
  key: string;
  check: ProviderCheck;
}

function ProviderForm({
  redirectBase,
  provider,
  startTest,
  onClose,
  onSaved,
}: {
  redirectBase: string;
  provider: Provider | undefined;
  startTest: boolean;
  onClose: () => void;
  onSaved: (name: string, created: boolean) => void;
}) {
  const { t } = useI18n();
  const ids = useId();
  const editing = provider !== undefined;
  const [name, setName] = useState(provider?.name ?? "");
  const [slug, setSlug] = useState(provider?.slug ?? "");
  const [slugEdited, setSlugEdited] = useState(editing);
  const [issuer, setIssuer] = useState(provider?.oidc.issuer ?? "");
  const [clientId, setClientId] = useState(provider?.oidc.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [groupsClaim, setGroupsClaim] = useState(provider?.oidc.groupsClaim ?? "groups");
  const [scopes, setScopes] = useState(
    (provider?.oidc.scopes ?? ["openid", "email", "profile", "groups"]).join(" "),
  );
  const [emailClaim, setEmailClaim] = useState(provider?.oidc.emailClaim ?? "email");
  const [nameClaim, setNameClaim] = useState(provider?.oidc.nameClaim ?? "name");
  const [pkce, setPkce] = useState(provider?.oidc.pkce ?? true);
  const [trustEmail, setTrustEmail] = useState(provider?.oidc.trustEmail ?? false);
  const [createAccounts, setCreateAccounts] = useState(provider?.createAccounts ?? true);
  const [trustMfa, setTrustMfa] = useState(provider?.trustProviderMfa ?? false);
  const [version, setVersion] = useState(provider?.version ?? 0);
  const [advanced, setAdvanced] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [busy, setBusy] = useState<"check" | "save" | "test" | null>(null);
  const [test, setTest] = useState<TestSignInStart | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [copied, setCopied] = useState(false);
  const refs: Record<Field, RefObject<HTMLInputElement | null>> = {
    name: useRef<HTMLInputElement>(null),
    slug: useRef<HTMLInputElement>(null),
    issuer: useRef<HTMLInputElement>(null),
    clientId: useRef<HTMLInputElement>(null),
    clientSecret: useRef<HTMLInputElement>(null),
    groupsClaim: useRef<HTMLInputElement>(null),
    scopes: useRef<HTMLInputElement>(null),
    emailClaim: useRef<HTMLInputElement>(null),
    nameClaim: useRef<HTMLInputElement>(null),
  };
  const [focusField, setFocusField] = useState<Field | null>(null);
  useEffect(() => {
    if (focusField !== null) {
      refs[focusField].current?.focus();
      setFocusField(null);
    }
  });

  const testState = useQuery({
    queryKey: ssoKeys.test(test?.id ?? ""),
    queryFn: () => fetchTestSignIn(test?.id ?? ""),
    enabled: test !== null,
    refetchInterval: (query) =>
      query.state.data === undefined || query.state.data.status === "pending"
        ? TEST_POLL_MS
        : false,
    gcTime: 0,
  });

  // The check holds for exactly these three values; any change asks for a new one.
  const connectionKey = JSON.stringify([issuer.trim(), clientId.trim(), clientSecret]);
  const checkCurrent = checked !== null && checked.key === connectionKey;
  const connectionChanged =
    !editing ||
    issuer.trim() !== provider.oidc.issuer ||
    clientId.trim() !== provider.oidc.clientId ||
    clientSecret !== "";
  const canSave = checkCurrent || !connectionChanged;
  const redirectUri = editing
    ? provider.redirectUri
    : `${redirectBase.replace(/\/+$/, "")}/auth/oidc/${slug === "" ? "…" : slug}/callback`;

  function input(): ProviderInput {
    return {
      kind: "oidc",
      slug: slug.trim(),
      name: name.trim(),
      createAccounts,
      trustProviderMfa: trustMfa,
      oidc: {
        issuer: issuer.trim(),
        clientId: clientId.trim(),
        ...(clientSecret === "" ? {} : { clientSecret }),
        scopes: scopes.split(/\s+/).filter((scope) => scope !== ""),
        groupsClaim: groupsClaim.trim(),
        emailClaim: emailClaim.trim(),
        nameClaim: nameClaim.trim(),
        pkce,
        trustEmail,
      },
    };
  }

  function markFields(errors: FieldErrors) {
    setFieldErrors(errors);
    const first = FIELDS.find((field) => errors[field] !== undefined);
    if (first !== undefined) {
      if (ADVANCED.includes(first)) {
        setAdvanced(true);
      }
      setFormError(t("sso.form.checkFields"));
      setFocusField(first);
    }
  }

  function reason(code: string): string {
    return reasonText(t, { reason: code }) ?? code;
  }

  /** The checks the server makes too, so the obvious ones answer before any request. */
  function checkLocally(): boolean {
    const errors: FieldErrors = {};
    const required = t("sso.form.required");
    if (name.trim() === "") errors.name = required;
    if (!SLUG.test(slug.trim())) errors.slug = reason("sso.slug_invalid");
    if (issuer.trim() === "") errors.issuer = required;
    if (clientId.trim() === "") errors.clientId = reason("sso.client_id_required");
    if (!editing && clientSecret === "") errors.clientSecret = reason("sso.client_secret_required");
    if (groupsClaim.trim() === "") errors.groupsClaim = reason("sso.claim_invalid");
    if (emailClaim.trim() === "") errors.emailClaim = reason("sso.claim_invalid");
    if (nameClaim.trim() === "") errors.nameClaim = reason("sso.claim_invalid");
    markFields(errors);
    return Object.keys(errors).length === 0;
  }

  function showFailure(error: unknown) {
    const field = serverField(error);
    if (field !== undefined) {
      markFields({ [field]: ssoErrorText(t, error) });
      return;
    }
    if (isApiError(error, "version_conflict")) {
      const current = error.current;
      if (
        typeof current === "object" &&
        current !== null &&
        typeof (current as { version?: unknown }).version === "number"
      ) {
        setVersion((current as { version: number }).version);
      }
      setFormError(t("sso.form.conflict"));
      return;
    }
    setFormError(ssoErrorText(t, error));
  }

  function begin(what: "check" | "save" | "test"): boolean {
    if (busy !== null) {
      return false;
    }
    setFieldErrors({});
    setFormError(undefined);
    if (!checkLocally()) {
      return false;
    }
    setBusy(what);
    return true;
  }

  /** Checks the connection; the answer holds for the values it was made with. */
  async function runCheck(): Promise<Checked | null> {
    const key = connectionKey;
    const check = await checkProvider(input(), provider?.id);
    const result = { key, check };
    setChecked(result);
    return result;
  }

  async function onCheck() {
    if (!begin("check")) return;
    setChecked(null);
    try {
      await runCheck();
    } catch (error) {
      showFailure(error);
    } finally {
      setBusy(null);
    }
  }

  async function onTest() {
    if (!begin("test")) return;
    setTest(null);
    setBlocked(false);
    try {
      const current = checkCurrent ? checked : await runCheck();
      if (current === null) return;
      const started = await startTestSignIn(input(), provider?.id, current.check.checkToken);
      setTest(started);
      setBlocked(!leavePage.open(started.url));
    } catch (error) {
      showFailure(error);
    } finally {
      setBusy(null);
    }
  }

  async function onSave() {
    if (!canSave) {
      setFormError(t("sso.form.checkFirst"));
      return;
    }
    if (!begin("save")) return;
    try {
      const token = checkCurrent ? checked?.check.checkToken : undefined;
      if (editing) {
        await updateProvider(provider.id, input(), version, connectionChanged ? token : undefined);
      } else {
        await createProvider(input(), token ?? "");
      }
      onSaved(name.trim(), !editing);
    } catch (error) {
      showFailure(error);
    } finally {
      setBusy(null);
    }
  }

  // Opened from the menu's "Test sign-in": the test starts once, with the stored values.
  const autoTested = useRef(false);
  useEffect(() => {
    if (startTest && !autoTested.current) {
      autoTested.current = true;
      void onTest();
    }
  });

  function textInput(
    field: Field,
    value: string,
    onChange: (value: string) => void,
    options: { mono?: boolean; hint?: ReactNode; label: string; readOnly?: boolean; type?: string },
  ) {
    const id = `${ids}-${field}`;
    const error = fieldErrors[field];
    return (
      <FormField id={id} label={options.label} hint={options.hint} error={error}>
        <input
          ref={refs[field] as RefObject<HTMLInputElement>}
          id={id}
          className={options.mono === true ? "input input--mono" : "input"}
          type={options.type ?? "text"}
          value={value}
          readOnly={options.readOnly}
          spellCheck={false}
          autoComplete={options.type === "password" ? "new-password" : "off"}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={describedBy(id, options.hint !== undefined, error)}
          onChange={(event) => {
            onChange(event.currentTarget.value);
            if (error !== undefined) {
              const next = { ...fieldErrors };
              delete next[field];
              setFieldErrors(next);
            }
          }}
        />
      </FormField>
    );
  }

  const testResult = testState.data;
  return (
    <Dialog
      open
      wide
      title={editing ? t("sso.form.editTitleFor", { name: provider.name }) : t("sso.form.addTitle")}
      onClose={onClose}
      initialFocus={refs.name}
      footer={
        <div className="sso-dialog__footer">
          <button
            type="button"
            className="button button--secondary"
            aria-disabled={busy !== null}
            onClick={() => void onCheck()}
          >
            <Icon name="refresh" />
            {busy === "check" ? t("sso.form.checking") : t("sso.form.check")}
          </button>
          <button
            type="button"
            className="button button--secondary"
            aria-disabled={busy !== null}
            onClick={() => void onTest()}
          >
            <Icon name="external" />
            {busy === "test" ? t("sso.form.testing") : t("sso.form.test")}
          </button>
          <span className="sso-dialog__spacer" />
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("admin.common.cancel")}
          </button>
          <button
            type="button"
            className="button button--primary"
            aria-disabled={!canSave || busy !== null}
            aria-describedby={canSave ? undefined : `${ids}-save-hint`}
            onClick={() => void onSave()}
          >
            {busy === "save" ? t("sso.form.saving") : t("sso.form.save")}
          </button>
        </div>
      }
    >
      <form
        className="form sso-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void onSave();
        }}
      >
        <div role="alert" aria-atomic="true">
          {formError === undefined ? null : (
            <p className="sso-alarm">
              <Icon name="alert" />
              <span>{formError}</span>
            </p>
          )}
        </div>
        {textInput(
          "name",
          name,
          (value) => {
            setName(value);
            if (!slugEdited) {
              setSlug(slugFrom(value));
            }
          },
          {
            label: t("sso.form.name"),
            hint: t("sso.form.nameHint", { name: name.trim() === "" ? "…" : name.trim() }),
          },
        )}
        {textInput(
          "slug",
          slug,
          (value) => {
            setSlug(value);
            setSlugEdited(true);
          },
          {
            label: t("sso.form.slug"),
            mono: true,
            readOnly: editing,
            hint: t(editing ? "sso.form.slugFixed" : "sso.form.slugHint"),
          },
        )}
        {textInput("issuer", issuer, setIssuer, {
          label: t("sso.form.issuer"),
          mono: true,
          hint: t("sso.form.issuerHint"),
        })}
        <div className="sso-form__pair">
          {textInput("clientId", clientId, setClientId, {
            label: t("sso.form.clientId"),
            mono: true,
          })}
          {textInput("clientSecret", clientSecret, setClientSecret, {
            label: t("sso.form.clientSecret"),
            mono: true,
            type: "password",
            hint:
              editing && provider.oidc.clientSecretSet
                ? t("sso.form.clientSecretKeep")
                : t("sso.form.clientSecretHint"),
          })}
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`${ids}-redirect`}>
            {t("sso.form.redirectUri")}
          </label>
          <div className="sso-copy">
            <input
              id={`${ids}-redirect`}
              className="input input--mono sso-copy__value"
              value={redirectUri}
              readOnly
              aria-describedby={`${ids}-redirect-hint`}
            />
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => {
                void writeClipboard(redirectUri).then((ok) => setCopied(ok));
              }}
            >
              <Icon name="copy" />
              {t("sso.form.copy")}
            </button>
          </div>
          <p className="field__hint" id={`${ids}-redirect-hint`} role="status">
            {copied ? t("sso.form.copied") : t("sso.form.redirectUriHint")}
          </p>
        </div>
        <div className="sso-form__pair">
          {textInput("groupsClaim", groupsClaim, setGroupsClaim, {
            label: t("sso.form.groupsClaim"),
            mono: true,
          })}
          {textInput("scopes", scopes, setScopes, {
            label: t("sso.form.scopes"),
            mono: true,
            hint: t("sso.form.scopesHint"),
          })}
        </div>
        <label className="sso-check">
          <input
            type="checkbox"
            checked={createAccounts}
            onChange={(event) => setCreateAccounts(event.currentTarget.checked)}
          />
          <span>
            {t("sso.form.createAccounts")}
            <span className="field__hint">{t("sso.form.createAccountsHint")}</span>
          </span>
        </label>
        <div className="sso-switch-row">
          <span className="sso-switch-row__text">
            <span className="field__label" id={`${ids}-mfa`}>
              {t("sso.form.trustMfa")}
            </span>
            <span className="field__hint" id={`${ids}-mfa-hint`}>
              {t(trustMfa ? "sso.form.trustMfaOnHint" : "sso.form.trustMfaOffHint")}
            </span>
          </span>
          <span className="sso-switch-row__control">
            <input
              type="checkbox"
              role="switch"
              className="settings-switch"
              checked={trustMfa}
              aria-checked={trustMfa}
              aria-labelledby={`${ids}-mfa`}
              aria-describedby={`${ids}-mfa-hint`}
              onChange={(event) => setTrustMfa(event.currentTarget.checked)}
            />
            <span>{t(trustMfa ? "sso.form.trustMfaOn" : "sso.form.trustMfaOff")}</span>
          </span>
        </div>
        <div className="sso-advanced">
          <button
            type="button"
            className="sso-advanced__toggle"
            aria-expanded={advanced}
            aria-controls={`${ids}-advanced`}
            onClick={() => setAdvanced(!advanced)}
          >
            <Icon name={advanced ? "chevronDown" : "chevron"} />
            {t("sso.form.advanced")}
          </button>
          <div id={`${ids}-advanced`} className="sso-advanced__body" hidden={!advanced}>
            <div className="sso-form__pair">
              {textInput("emailClaim", emailClaim, setEmailClaim, {
                label: t("sso.form.emailClaim"),
                mono: true,
              })}
              {textInput("nameClaim", nameClaim, setNameClaim, {
                label: t("sso.form.nameClaim"),
                mono: true,
              })}
            </div>
            <label className="sso-check">
              <input
                type="checkbox"
                checked={pkce}
                onChange={(event) => setPkce(event.currentTarget.checked)}
              />
              <span>
                {t("sso.form.pkce")}
                <span className="field__hint">{t("sso.form.pkceHint")}</span>
              </span>
            </label>
            <label className="sso-check">
              <input
                type="checkbox"
                checked={trustEmail}
                onChange={(event) => setTrustEmail(event.currentTarget.checked)}
              />
              <span>
                {t("sso.form.trustEmail")}
                <span className="field__hint">{t("sso.form.trustEmailHint")}</span>
              </span>
            </label>
          </div>
        </div>
        <div role="status" aria-atomic="true" className="sso-results">
          {checkCurrent && checked !== null ? (
            <p className="sso-note-ok">
              <Icon name="check" />
              <span>{checkText(t, checked.check)}</span>
            </p>
          ) : null}
          {test === null ? null : (
            <TestLine
              t={t}
              url={test.url}
              blocked={blocked}
              state={testResult}
              error={testState.error}
            />
          )}
        </div>
        {canSave ? null : (
          <p className="field__hint" id={`${ids}-save-hint`}>
            {t("sso.form.saveNeedsCheck")}
          </p>
        )}
      </form>
    </Dialog>
  );
}

/** "Connection ok. Discovery read, 2 keys loaded, client accepted (210 ms)." */
function checkText(t: Translate, check: ProviderCheck): string {
  return t(check.clientAccepted === true ? "sso.form.checkOk" : "sso.form.checkOkUnsure", {
    keys: check.keys,
    ms: Math.round(check.durationMs),
  });
}

/** The state of a running or finished test sign-in. */
function TestLine({
  t,
  url,
  blocked,
  state,
  error,
}: {
  t: Translate;
  url: string;
  blocked: boolean;
  state: Awaited<ReturnType<typeof fetchTestSignIn>> | undefined;
  error: unknown;
}) {
  if (error !== null && error !== undefined) {
    return (
      <p className="sso-alarm">
        <Icon name="alert" />
        <span>{ssoErrorText(t, error)}</span>
      </p>
    );
  }
  if (state?.status === "done" && state.result !== undefined) {
    const result = state.result;
    return (
      <p className="sso-note-ok">
        <Icon name="check" />
        <span>
          {t("sso.form.testOk", {
            username: result.username === "" ? result.email : result.username,
            groups:
              result.groups.length === 0 ? t("sso.form.testNoGroups") : result.groups.join(", "),
            outcome: outcomeText(t, result.outcome),
          })}
        </span>
      </p>
    );
  }
  if (state?.status === "failed" && state.error !== undefined) {
    return (
      <p className="sso-alarm">
        <Icon name="alert" />
        <span>{t("sso.form.testFailed", { reason: testFailureText(t, state.error) })}</span>
      </p>
    );
  }
  return (
    <p className="sso-note">
      <Icon name="clock" />
      <span>
        {t("sso.form.testWaiting")}{" "}
        {blocked ? (
          <a href={url} target="_blank" rel="noopener">
            {t("sso.form.testOpen")}
          </a>
        ) : null}
      </span>
    </p>
  );
}
