import { useQuery } from "@tanstack/react-query";
import {
  type ChangeEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { isApiError } from "../../../api/client";
import { Icon } from "../../../components/Icon";
import { type Translate, useI18n } from "../../../i18n/i18n";
import { writeClipboard } from "../../../lib/clipboard";
import { leavePage } from "../../../lib/leavePage";
import { reasonText } from "../../datasources/reasons";
import { ConfirmDialog, Dialog } from "../components/Dialog";
import { formatDateTime } from "../components/format";
import { LoadState } from "../components/Section";
import {
  checkSaml,
  createSaml,
  fetchSamlProvider,
  fetchTestSignIn,
  type SamlCertificate,
  type SamlCheck,
  type SamlInput,
  type SamlProvider,
  ssoKeys,
  startSamlTest,
  type TestSignInStart,
  updateSaml,
} from "./api";
import { describedBy, FormField, slugFrom, TEST_POLL_MS, TestLine } from "./ProviderDialog";
import { ssoErrorText, ssoReason } from "./texts";
import "../../settings/settings.css";
import "./sso.css";

/** The fields of the form, in their order on the page (the first bad one gets focus). */
const FIELDS = [
  "name",
  "slug",
  "metadataUrl",
  "metadataXml",
  "idpEntityId",
  "ssoUrl",
  "certificates",
  "emailAttribute",
  "nameAttribute",
  "groupsAttribute",
] as const;
type Field = (typeof FIELDS)[number];
type FieldErrors = Partial<Record<Field, string>>;

/** The provider's values, behind "Without metadata", which opens when one of them is refused. */
const MANUAL: readonly Field[] = ["idpEntityId", "ssoUrl", "certificates"];

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Largest metadata file read (the server refuses more). */
const MAX_METADATA_BYTES = 1024 * 1024;

function isField(value: string | undefined): value is Field {
  return (FIELDS as readonly (string | undefined)[]).includes(value);
}

/** The field the server named, without the `saml.` of the nested form. */
function serverField(error: unknown): Field | undefined {
  const field = isApiError(error) ? error.field?.replace(/^saml\./, "") : undefined;
  return isField(field) ? field : undefined;
}

/** The provider's values a check covers; any change asks for a new check. */
interface Trust {
  metadataUrl: string;
  metadataXml: string;
  idpEntityId: string;
  ssoUrl: string;
  certificates: string[];
}

function trustKey(trust: Trust): string {
  return JSON.stringify([
    trust.metadataUrl.trim(),
    trust.metadataXml,
    trust.idpEntityId.trim(),
    trust.ssoUrl.trim(),
    trust.certificates.map((c) => c.trim()).filter((c) => c !== ""),
  ]);
}

interface Checked {
  key: string;
  check: SamlCheck;
  trust: Trust;
}

/**
 * Adding or changing a SAML 2.0 provider (board frame 5D). "Check connection" reads the
 * provider's metadata (from its URL or an uploaded file) or checks the values typed in, and
 * fills in the entity ID, sign-in URL and signing certificates Kalzit pins; Save stays off until
 * the check passed for exactly these values. Signed answers are always required. "Test sign-in"
 * goes through the provider in a new window and shows what arrives; it signs nobody in.
 */
export function SamlDialog({
  providerId,
  samlBase,
  startTest,
  onClose,
  onSaved,
}: {
  /** The provider to change; undefined adds one. */
  providerId: string | undefined;
  /** `server.public_url`, the start of Kalzit's SAML addresses; null while it is not set. */
  samlBase: string | null;
  startTest: boolean;
  onClose: () => void;
  onSaved: (name: string, created: boolean) => void;
}) {
  const { t } = useI18n();
  const stored = useQuery({
    queryKey: ssoKeys.provider(providerId ?? ""),
    queryFn: () => fetchSamlProvider(providerId ?? ""),
    enabled: providerId !== undefined,
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
    <SamlForm
      provider={stored.data}
      samlBase={samlBase}
      startTest={startTest}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

function SamlForm({
  provider,
  samlBase,
  startTest,
  onClose,
  onSaved,
}: {
  provider: SamlProvider | undefined;
  samlBase: string | null;
  startTest: boolean;
  onClose: () => void;
  onSaved: (name: string, created: boolean) => void;
}) {
  const { t, language, timeZone } = useI18n();
  const ids = useId();
  const editing = provider !== undefined;
  const saml = provider?.saml;
  const [name, setName] = useState(provider?.name ?? "");
  const [slug, setSlug] = useState(provider?.slug ?? "");
  const [slugEdited, setSlugEdited] = useState(editing);
  const [metadataUrl, setMetadataUrl] = useState(saml?.metadataUrl ?? "");
  const [metadataXml, setMetadataXml] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [idpEntityId, setIdpEntityId] = useState(saml?.idpEntityId ?? "");
  const [ssoUrl, setSsoUrl] = useState(saml?.ssoUrl ?? "");
  const [certificate, setCertificate] = useState(saml?.certificates[0] ?? "");
  const [nextCertificate, setNextCertificate] = useState(saml?.certificates[1] ?? "");
  const [emailAttribute, setEmailAttribute] = useState(saml?.emailAttribute ?? "mail");
  const [nameAttribute, setNameAttribute] = useState(saml?.nameAttribute ?? "displayName");
  const [groupsAttribute, setGroupsAttribute] = useState(saml?.groupsAttribute ?? "memberOf");
  const [trustEmail, setTrustEmail] = useState(saml?.trustEmail ?? false);
  const [createAccounts, setCreateAccounts] = useState(provider?.createAccounts ?? true);
  const [trustMfa, setTrustMfa] = useState(provider?.trustProviderMfa ?? false);
  const [version, setVersion] = useState(provider?.version ?? 0);
  const [manual, setManual] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [busy, setBusy] = useState<"check" | "save" | "test" | null>(null);
  const [confirmEntity, setConfirmEntity] = useState<string | null>(null);
  const [test, setTest] = useState<TestSignInStart | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [copied, setCopied] = useState<"entity" | "acs" | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const refs = {
    name: useRef<HTMLInputElement>(null),
    slug: useRef<HTMLInputElement>(null),
    metadataUrl: useRef<HTMLInputElement>(null),
    metadataXml: useRef<HTMLButtonElement>(null),
    idpEntityId: useRef<HTMLInputElement>(null),
    ssoUrl: useRef<HTMLInputElement>(null),
    certificates: useRef<HTMLTextAreaElement>(null),
    emailAttribute: useRef<HTMLInputElement>(null),
    nameAttribute: useRef<HTMLInputElement>(null),
    groupsAttribute: useRef<HTMLInputElement>(null),
  } satisfies Record<Field, RefObject<HTMLElement | null>>;
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

  const trust: Trust = {
    metadataUrl,
    metadataXml,
    idpEntityId,
    ssoUrl,
    certificates: [certificate, nextCertificate],
  };
  const checkCurrent = checked !== null && checked.key === trustKey(trust);
  const storedTrust: Trust | null =
    saml === undefined
      ? null
      : {
          metadataUrl: saml.metadataUrl,
          metadataXml: "",
          idpEntityId: saml.idpEntityId,
          ssoUrl: saml.ssoUrl,
          certificates: saml.certificates,
        };
  const trustChanged = storedTrust === null || trustKey(trust) !== trustKey(storedTrust);
  const canSave = checkCurrent || !trustChanged;
  const base = samlBase?.replace(/\/+$/, "") ?? null;
  const entityAddress =
    provider?.spEntityId ??
    (base === null ? null : `${base}/auth/saml/${slug === "" ? "…" : slug}`);
  const acsAddress = provider?.acsUrl ?? (entityAddress === null ? null : `${entityAddress}/acs`);
  const certificateInfo: SamlCertificate[] = checkCurrent
    ? (checked?.check.certificates ?? [])
    : trustChanged
      ? []
      : (saml?.certificateInfo ?? []);

  function input(values: Trust = trust): SamlInput {
    return {
      slug: slug.trim(),
      name: name.trim(),
      createAccounts,
      trustProviderMfa: trustMfa,
      saml: {
        metadataUrl: values.metadataUrl.trim(),
        ...(values.metadataXml === "" ? {} : { metadataXml: values.metadataXml }),
        idpEntityId: values.idpEntityId.trim(),
        ssoUrl: values.ssoUrl.trim(),
        certificates: values.certificates.map((c) => c.trim()).filter((c) => c !== ""),
        emailAttribute: emailAttribute.trim(),
        nameAttribute: nameAttribute.trim(),
        groupsAttribute: groupsAttribute.trim(),
        trustEmail,
      },
    };
  }

  function reason(code: string): string {
    return reasonText(t, { reason: code }) ?? code;
  }

  function markFields(errors: FieldErrors) {
    setFieldErrors(errors);
    const first = FIELDS.find((field) => errors[field] !== undefined);
    if (first !== undefined) {
      if (MANUAL.includes(first)) {
        setManual(true);
      }
      setFormError(t("sso.saml.checkFailed"));
      setFocusField(first);
    }
  }

  /** The checks the server makes too, so the obvious ones answer before any request. */
  function checkLocally(what: "check" | "save" | "test"): boolean {
    const errors: FieldErrors = {};
    const required = t("sso.form.required");
    if (name.trim() === "") errors.name = required;
    if (!SLUG.test(slug.trim())) errors.slug = reason("sso.slug_invalid");
    const url = metadataUrl.trim();
    if (url !== "" && !/^https?:\/\/\S+$/i.test(url)) {
      errors.metadataUrl = reason("saml.metadata_url_invalid");
    }
    // Without metadata, or when saving, the provider's values must be there.
    const fromMetadata = what === "check" && (metadataXml !== "" || url !== "");
    if (!fromMetadata) {
      if (idpEntityId.trim() === "") errors.idpEntityId = reason("saml.entity_id_invalid");
      if (!/^https?:\/\/\S+$/i.test(ssoUrl.trim())) errors.ssoUrl = reason("saml.sso_url_invalid");
      if (certificate.trim() === "" && nextCertificate.trim() === "") {
        errors.certificates = reason("saml.certificate_required");
      }
    }
    for (const [field, value] of [
      ["emailAttribute", emailAttribute],
      ["nameAttribute", nameAttribute],
      ["groupsAttribute", groupsAttribute],
    ] as const) {
      if (value.trim() === "") errors[field] = reason("saml.attribute_invalid");
    }
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
    if (!checkLocally(what)) {
      return false;
    }
    setBusy(what);
    return true;
  }

  /**
   * Checks the metadata or values; the provider's values it found replace the form's, and the
   * answer holds for exactly them.
   */
  async function runCheck(): Promise<Checked> {
    const check = await checkSaml(input(), provider?.id);
    const found: Trust = {
      metadataUrl: check.saml.metadataUrl,
      metadataXml: "",
      idpEntityId: check.saml.idpEntityId,
      ssoUrl: check.saml.ssoUrl,
      certificates: [check.saml.certificates[0] ?? "", check.saml.certificates[1] ?? ""],
    };
    setMetadataUrl(found.metadataUrl);
    setMetadataXml("");
    setFileName(null);
    setIdpEntityId(found.idpEntityId);
    setSsoUrl(found.ssoUrl);
    setCertificate(found.certificates[0] ?? "");
    setNextCertificate(found.certificates[1] ?? "");
    const result = { key: trustKey(found), check, trust: found };
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
      const current = checkCurrent && checked !== null ? checked : await runCheck();
      const started = await startSamlTest(
        input(current.trust),
        provider?.id,
        current.check.checkToken,
      );
      setTest(started);
      setBlocked(!leavePage.open(started.url));
    } catch (error) {
      showFailure(error);
    } finally {
      setBusy(null);
    }
  }

  async function onSave(confirmEntityChange = false) {
    if (!canSave) {
      setFormError(t("sso.saml.checkFirst"));
      return;
    }
    if (!begin("save")) return;
    try {
      const token = checkCurrent ? checked?.check.checkToken : undefined;
      if (editing) {
        await updateSaml(
          provider.id,
          input(),
          version,
          trustChanged ? token : undefined,
          confirmEntityChange,
        );
      } else {
        await createSaml(input(), token ?? "");
      }
      setConfirmEntity(null);
      onSaved(name.trim(), !editing);
    } catch (error) {
      const found = ssoReason(error);
      if (found?.reason === "sso.issuer_change_confirm") {
        setConfirmEntity(found.params.people ?? "");
      } else {
        setConfirmEntity(null);
        showFailure(error);
      }
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

  function clearError(field: Field) {
    if (fieldErrors[field] !== undefined) {
      const next = { ...fieldErrors };
      delete next[field];
      setFieldErrors(next);
    }
  }

  async function onFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (file === undefined) {
      return;
    }
    clearError("metadataXml");
    if (file.size > MAX_METADATA_BYTES) {
      markFields({ metadataXml: t("sso.saml.fileTooLarge") });
      return;
    }
    setMetadataXml(await file.text());
    setFileName(file.name);
  }

  function textInput(
    field: Exclude<Field, "metadataXml" | "certificates">,
    value: string,
    onChange: (value: string) => void,
    options: {
      label: string;
      mono?: boolean;
      hint?: ReactNode;
      readOnly?: boolean;
      placeholder?: string;
    },
  ) {
    const id = `${ids}-${field}`;
    const error = fieldErrors[field];
    return (
      <FormField id={id} label={options.label} hint={options.hint} error={error}>
        <input
          ref={refs[field]}
          id={id}
          className={options.mono === true ? "input input--mono" : "input"}
          type="text"
          value={value}
          readOnly={options.readOnly}
          placeholder={options.placeholder}
          spellCheck={false}
          autoComplete="off"
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={describedBy(id, options.hint !== undefined, error)}
          onChange={(event) => {
            onChange(event.currentTarget.value);
            clearError(field);
          }}
        />
      </FormField>
    );
  }

  function copyRow(which: "entity" | "acs", label: string, value: string | null) {
    const id = `${ids}-${which}`;
    return (
      <div className="field">
        <label className="field__label" htmlFor={id}>
          {label}
        </label>
        <div className="sso-copy">
          <input
            id={id}
            className="input input--mono sso-copy__value"
            value={value ?? t("sso.saml.publicUrlMissingShort")}
            readOnly
          />
          <button
            type="button"
            className="button button--ghost button--small"
            aria-disabled={value === null}
            onClick={() => {
              if (value !== null) {
                void writeClipboard(value).then((ok) => setCopied(ok ? which : null));
              }
            }}
          >
            <Icon name="copy" />
            {t("sso.form.copy")}
          </button>
        </div>
      </div>
    );
  }

  const xmlError = fieldErrors.metadataXml;
  const certId = `${ids}-certificates`;
  const certError = fieldErrors.certificates;
  const testResult = testState.data;
  return (
    <>
      <ConfirmDialog
        open={confirmEntity !== null}
        title={t("sso.saml.entityChangeTitle")}
        confirmLabel={t("sso.form.issuerChangeConfirm")}
        busy={busy === "save"}
        onClose={() => setConfirmEntity(null)}
        onConfirm={() => void onSave(true)}
      >
        {t("sso.saml.entityChangeText", { people: confirmEntity ?? "" })}
      </ConfirmDialog>
      <Dialog
        open
        wide
        title={
          editing ? t("sso.form.editTitleFor", { name: provider.name }) : t("sso.saml.addTitle")
        }
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
            {provider?.spMetadataUrl ? (
              <a
                className="button button--ghost"
                href={provider.spMetadataUrl}
                target="_blank"
                rel="noopener"
              >
                <Icon name="download" />
                {t("sso.saml.spMetadata")}
              </a>
            ) : null}
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
            {base === null ? (
              <p className="sso-alarm">
                <Icon name="alert" />
                <span>{t("sso.saml.publicUrlMissing")}</span>
              </p>
            ) : null}
          </div>
          <div className="sso-form__pair">
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
                hint: t(editing ? "sso.saml.slugFixed" : "sso.saml.slugHint"),
              },
            )}
          </div>
          {textInput("metadataUrl", metadataUrl, setMetadataUrl, {
            label: t("sso.saml.metadataUrl"),
            mono: true,
            placeholder: "https://idp.example.com/saml/metadata",
            hint: t("sso.saml.metadataUrlHint"),
          })}
          <div className="field">
            <input
              ref={fileRef}
              type="file"
              accept=".xml,application/xml,text/xml,application/samlmetadata+xml"
              className="visually-hidden"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => void onFile(event)}
            />
            <div className="sso-copy">
              <button
                ref={refs.metadataXml}
                type="button"
                className="button button--secondary button--small"
                aria-describedby={describedBy(`${ids}-metadataXml`, true, xmlError)}
                onClick={() => fileRef.current?.click()}
              >
                <Icon name="upload" />
                {t("sso.saml.upload")}
              </button>
              {fileName === null ? null : (
                <button
                  type="button"
                  className="button button--ghost button--small"
                  onClick={() => {
                    setMetadataXml("");
                    setFileName(null);
                  }}
                >
                  {t("sso.saml.uploadRemove")}
                </button>
              )}
            </div>
            <p className="field__hint" id={`${ids}-metadataXml-hint`}>
              {fileName === null
                ? t("sso.saml.uploadHint")
                : t("sso.saml.uploaded", { file: fileName })}
            </p>
            {xmlError === undefined ? null : (
              <p className="field__error" id={`${ids}-metadataXml-error`}>
                <Icon name="alert" />
                <span>{xmlError}</span>
              </p>
            )}
          </div>
          <div className="sso-advanced">
            <button
              type="button"
              className="sso-advanced__toggle"
              aria-expanded={manual}
              aria-controls={`${ids}-manual`}
              onClick={() => setManual(!manual)}
            >
              <Icon name={manual ? "chevronDown" : "chevron"} />
              {t("sso.saml.manual")}
            </button>
            <div id={`${ids}-manual`} className="sso-advanced__body" hidden={!manual}>
              <p className="field__hint">{t("sso.saml.manualHint")}</p>
              {textInput("idpEntityId", idpEntityId, setIdpEntityId, {
                label: t("sso.saml.idpEntityId"),
                mono: true,
              })}
              {textInput("ssoUrl", ssoUrl, setSsoUrl, {
                label: t("sso.saml.ssoUrl"),
                mono: true,
                hint: t("sso.saml.ssoUrlHint"),
              })}
              <FormField
                id={certId}
                label={t("sso.saml.certificate")}
                hint={t("sso.saml.certificateHint")}
                error={certError}
              >
                <textarea
                  ref={refs.certificates}
                  id={certId}
                  className="input input--mono admin-textarea"
                  rows={4}
                  spellCheck={false}
                  value={certificate}
                  aria-invalid={certError === undefined ? undefined : true}
                  aria-describedby={describedBy(certId, true, certError)}
                  onChange={(event) => {
                    setCertificate(event.currentTarget.value);
                    clearError("certificates");
                  }}
                />
              </FormField>
              <FormField
                id={`${certId}-next`}
                label={t("sso.saml.nextCertificate")}
                hint={t("sso.saml.nextCertificateHint")}
                error={undefined}
              >
                <textarea
                  id={`${certId}-next`}
                  className="input input--mono admin-textarea"
                  rows={3}
                  spellCheck={false}
                  value={nextCertificate}
                  aria-describedby={`${certId}-next-hint`}
                  onChange={(event) => {
                    setNextCertificate(event.currentTarget.value);
                    clearError("certificates");
                  }}
                />
              </FormField>
            </div>
          </div>
          {certificateInfo.length === 0 ? null : (
            <ul className="sso-certs" aria-label={t("sso.saml.pinned")}>
              {certificateInfo.map((cert) => (
                <li key={cert.fingerprint} className="sso-certs__item">
                  <span className="sso-mono" translate="no">
                    {cert.fingerprint}
                  </span>
                  <span className="sso-muted sso-small">
                    {t(cert.expired ? "sso.saml.certExpired" : "sso.saml.certValid", {
                      subject: cert.subject,
                      date: formatDateTime(cert.notAfter, language, timeZone),
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {copyRow("entity", t("sso.saml.spEntityId"), entityAddress)}
          {copyRow("acs", t("sso.saml.acsUrl"), acsAddress)}
          <p className="field__hint" role="status">
            {copied === null ? t("sso.saml.addressesHint") : t("sso.form.copied")}
          </p>
          <div className="sso-form__trio">
            {textInput("emailAttribute", emailAttribute, setEmailAttribute, {
              label: t("sso.saml.emailAttribute"),
              mono: true,
            })}
            {textInput("nameAttribute", nameAttribute, setNameAttribute, {
              label: t("sso.saml.nameAttribute"),
              mono: true,
            })}
            {textInput("groupsAttribute", groupsAttribute, setGroupsAttribute, {
              label: t("sso.saml.groupsAttribute"),
              mono: true,
            })}
          </div>
          <SwitchRow
            id={`${ids}-signed`}
            label={t("sso.saml.signed")}
            hint={t("sso.saml.signedHint")}
            checked
            disabled
            state={t("sso.saml.signedOn")}
            onChange={() => {}}
          />
          <SwitchRow
            id={`${ids}-mfa`}
            label={t("sso.form.trustMfa")}
            hint={t(trustMfa ? "sso.saml.trustMfaOnHint" : "sso.form.trustMfaOffHint")}
            checked={trustMfa}
            state={t(trustMfa ? "sso.form.trustMfaOn" : "sso.form.trustMfaOff")}
            onChange={setTrustMfa}
          />
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
          <label className="sso-check">
            <input
              type="checkbox"
              checked={trustEmail}
              onChange={(event) => setTrustEmail(event.currentTarget.checked)}
            />
            <span>
              {t("sso.saml.trustEmail")}
              <span className="field__hint">{t("sso.saml.trustEmailHint")}</span>
            </span>
          </label>
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
              {t("sso.saml.saveNeedsCheck")}
            </p>
          )}
        </form>
      </Dialog>
    </>
  );
}

/** "Metadata read: https://idp… with 2 certificates (120 ms)." */
function checkText(t: Translate, check: SamlCheck): string {
  return t("sso.saml.checkOk", {
    entity: check.saml.idpEntityId,
    count: check.saml.certificates.length,
    ms: Math.round(check.durationMs),
  });
}

/** A switch with its label, hint and state word, as in the OIDC form. */
function SwitchRow({
  id,
  label,
  hint,
  checked,
  disabled = false,
  state,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  disabled?: boolean;
  state: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="sso-switch-row">
      <span className="sso-switch-row__text">
        <span className="field__label" id={id}>
          {label}
        </span>
        <span className="field__hint" id={`${id}-hint`}>
          {hint}
        </span>
      </span>
      <span className="sso-switch-row__control">
        <input
          type="checkbox"
          role="switch"
          className="settings-switch"
          checked={checked}
          disabled={disabled}
          aria-checked={checked}
          aria-labelledby={id}
          aria-describedby={`${id}-hint`}
          onChange={(event) => onChange(event.currentTarget.checked)}
        />
        <span>{state}</span>
      </span>
    </div>
  );
}
