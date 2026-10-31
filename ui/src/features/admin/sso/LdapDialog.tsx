import { useQuery } from "@tanstack/react-query";
import { type ReactNode, type RefObject, useEffect, useId, useRef, useState } from "react";
import { isApiError } from "../../../api/client";
import { Icon } from "../../../components/Icon";
import { type Translate, useI18n } from "../../../i18n/i18n";
import { reasonText } from "../../datasources/reasons";
import { Segmented } from "../../settings/rows";
import { Dialog } from "../components/Dialog";
import { LoadState } from "../components/Section";
import {
  checkLdap,
  createLdap,
  fetchLdapProvider,
  type LdapCheck,
  type LdapEncryption,
  type LdapFlavor,
  type LdapInput,
  type LdapProvider,
  type LdapSchedule,
  LOGIN_ATTRIBUTES,
  ssoKeys,
  updateLdap,
} from "./api";
import { describedBy, FormField, slugFrom } from "./ProviderDialog";
import { outcomeText, ssoErrorText } from "./texts";
import "../../settings/settings.css";
import "./sso.css";

/** The fields of the form, in their order on the page (the first bad one gets focus). */
const FIELDS = [
  "name",
  "slug",
  "url",
  "encryption",
  "bindDn",
  "bindPassword",
  "userBaseDn",
  "loginAttribute",
  "userFilter",
  "groupBaseDn",
  "emailAttribute",
  "nameAttribute",
  "caPem",
  "syncSchedule",
  "syncHour",
  "syncThreshold",
  "testLogin",
  "testPassword",
] as const;
type Field = (typeof FIELDS)[number];
type FieldErrors = Partial<Record<Field, string>>;

/** Fields behind "Advanced", which opens when one of them is refused. */
const ADVANCED: readonly Field[] = ["groupBaseDn", "emailAttribute", "nameAttribute", "caPem"];

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
const ATTRIBUTE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;

const DEFAULT_NAME_ATTRIBUTE: Record<LdapFlavor, string> = { ad: "displayName", ldap: "cn" };

function isField(value: string | undefined): value is Field {
  return (FIELDS as readonly (string | undefined)[]).includes(value);
}

/** The field the server named, without the `ldap.` of the nested form. */
function serverField(error: unknown): Field | undefined {
  const field = isApiError(error) ? error.field?.replace(/^ldap\./, "") : undefined;
  return isField(field) ? field : undefined;
}

/**
 * Adding or changing an LDAP or Active Directory provider (board frame 5E). "Check connection"
 * binds with the service account, reads the base DNs and a few people and groups, and with a test
 * person also binds as them and shows their groups and what the mapping would give them. Save
 * stays off until the check passed for the URL, encryption, certificate, bind DN and password now
 * entered (a stored provider whose connection is unchanged needs none). The bind password is never
 * shown again.
 */
export function LdapDialog({
  providerId,
  onClose,
  onSaved,
}: {
  /** The provider to change; undefined adds one. */
  providerId: string | undefined;
  onClose: () => void;
  onSaved: (name: string, created: boolean) => void;
}) {
  const { t } = useI18n();
  const stored = useQuery({
    queryKey: ssoKeys.provider(providerId ?? ""),
    queryFn: () => fetchLdapProvider(providerId ?? ""),
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
  return <LdapForm provider={stored.data} onClose={onClose} onSaved={onSaved} />;
}

interface Checked {
  key: string;
  check: LdapCheck;
}

function LdapForm({
  provider,
  onClose,
  onSaved,
}: {
  provider: LdapProvider | undefined;
  onClose: () => void;
  onSaved: (name: string, created: boolean) => void;
}) {
  const { t } = useI18n();
  const ids = useId();
  const editing = provider !== undefined;
  const ldap = provider?.ldap;
  const [name, setName] = useState(provider?.name ?? "");
  const [slug, setSlug] = useState(provider?.slug ?? "");
  const [slugEdited, setSlugEdited] = useState(editing);
  const [flavor, setFlavor] = useState<LdapFlavor>(ldap?.flavor ?? "ad");
  const [url, setUrl] = useState(ldap?.url ?? "");
  const [encryption, setEncryption] = useState<LdapEncryption>(ldap?.encryption ?? "ldaps");
  const [certificate, setCertificate] = useState<"system" | "custom">(
    ldap?.certificate ?? "system",
  );
  const [caPem, setCaPem] = useState(ldap?.caPem ?? "");
  const [bindDn, setBindDn] = useState(ldap?.bindDn ?? "");
  // Never filled from the server: a stored password stays there unless a new one is typed.
  const [bindPassword, setBindPassword] = useState("");
  const [userBaseDn, setUserBaseDn] = useState(ldap?.userBaseDn ?? "");
  const [loginAttribute, setLoginAttribute] = useState(ldap?.loginAttribute ?? "sAMAccountName");
  const [userFilter, setUserFilter] = useState(ldap?.userFilter ?? "");
  const [groupBaseDn, setGroupBaseDn] = useState(ldap?.groupBaseDn ?? "");
  const [nestedGroups, setNestedGroups] = useState(ldap?.nestedGroups ?? false);
  const [emailAttribute, setEmailAttribute] = useState(ldap?.emailAttribute ?? "mail");
  const [nameAttribute, setNameAttribute] = useState(ldap?.nameAttribute ?? "displayName");
  const [trustEmail, setTrustEmail] = useState(ldap?.trustEmail ?? true);
  const [createAccounts, setCreateAccounts] = useState(provider?.createAccounts ?? true);
  const [syncSchedule, setSyncSchedule] = useState<LdapSchedule>(ldap?.syncSchedule ?? "daily");
  const [syncHour, setSyncHour] = useState(String(ldap?.syncHour ?? 2));
  const [syncThreshold, setSyncThreshold] = useState(String(ldap?.syncThreshold ?? 10));
  const [testLogin, setTestLogin] = useState("");
  const [testPassword, setTestPassword] = useState("");
  const [version, setVersion] = useState(provider?.version ?? 0);
  const [advanced, setAdvanced] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const [checked, setChecked] = useState<Checked | null>(null);
  const [busy, setBusy] = useState<"check" | "save" | null>(null);
  const refs = {
    name: useRef<HTMLInputElement>(null),
    slug: useRef<HTMLInputElement>(null),
    url: useRef<HTMLInputElement>(null),
    encryption: useRef<HTMLDivElement>(null),
    bindDn: useRef<HTMLInputElement>(null),
    bindPassword: useRef<HTMLInputElement>(null),
    userBaseDn: useRef<HTMLInputElement>(null),
    loginAttribute: useRef<HTMLSelectElement>(null),
    userFilter: useRef<HTMLInputElement>(null),
    groupBaseDn: useRef<HTMLInputElement>(null),
    emailAttribute: useRef<HTMLInputElement>(null),
    nameAttribute: useRef<HTMLInputElement>(null),
    caPem: useRef<HTMLTextAreaElement>(null),
    syncSchedule: useRef<HTMLSelectElement>(null),
    syncHour: useRef<HTMLInputElement>(null),
    syncThreshold: useRef<HTMLInputElement>(null),
    testLogin: useRef<HTMLInputElement>(null),
    testPassword: useRef<HTMLInputElement>(null),
  } satisfies Record<Field, RefObject<HTMLElement | null>>;
  const [focusField, setFocusField] = useState<Field | null>(null);
  useEffect(() => {
    if (focusField !== null) {
      const element = refs[focusField].current;
      // A segmented control takes focus on its chosen option.
      const target =
        element instanceof HTMLDivElement
          ? element.querySelector<HTMLElement>("[aria-checked='true']")
          : element;
      target?.focus();
      setFocusField(null);
    }
  });

  const caUsed = certificate === "custom" ? caPem : "";
  // The check holds for exactly these values; any change asks for a new one.
  const connectionKey = JSON.stringify([
    url.trim(),
    encryption,
    certificate,
    caUsed,
    bindDn.trim(),
    bindPassword,
  ]);
  const checkCurrent = checked !== null && checked.key === connectionKey;
  const connectionChanged =
    !editing ||
    url.trim() !== ldap?.url ||
    encryption !== ldap.encryption ||
    certificate !== ldap.certificate ||
    (certificate === "custom" && caPem !== (ldap.caPem ?? "")) ||
    bindDn.trim() !== ldap.bindDn ||
    bindPassword !== "";
  const canSave = checkCurrent || !connectionChanged;

  function input(): LdapInput {
    return {
      slug: slug.trim(),
      name: name.trim(),
      createAccounts,
      ldap: {
        flavor,
        url: url.trim(),
        encryption,
        certificate,
        caPem: certificate === "custom" ? caPem : null,
        bindDn: bindDn.trim(),
        ...(bindPassword === "" ? {} : { bindPassword }),
        userBaseDn: userBaseDn.trim(),
        loginAttribute,
        userFilter: userFilter.trim(),
        groupBaseDn: groupBaseDn.trim(),
        nestedGroups: flavor === "ad" && nestedGroups,
        emailAttribute: emailAttribute.trim(),
        nameAttribute: nameAttribute.trim(),
        trustEmail,
        syncSchedule,
        syncHour: Number(syncHour),
        syncThreshold: Number(syncThreshold),
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
      if (ADVANCED.includes(first)) {
        setAdvanced(true);
      }
      setFormError(
        Object.keys(errors).length > 1
          ? t("sso.ldap.checkFields", { count: Object.keys(errors).length })
          : t("sso.ldap.checkField"),
      );
      setFocusField(first);
    }
  }

  /** The checks the server makes too, so the obvious ones answer before any request. */
  function checkLocally(): boolean {
    const errors: FieldErrors = {};
    const required = t("sso.form.required");
    const scheme = url.trim().toLowerCase();
    if (name.trim() === "") errors.name = required;
    if (!SLUG.test(slug.trim())) errors.slug = reason("sso.slug_invalid");
    if (!/^ldaps?:\/\/[^/?#\s]+\/?$/i.test(url.trim())) {
      errors.url = reason("ldap.url_invalid");
    } else if (
      (scheme.startsWith("ldaps://") && encryption !== "ldaps") ||
      (scheme.startsWith("ldap://") && encryption === "ldaps")
    ) {
      errors.encryption = reason("ldap.scheme_conflict");
    }
    if (bindDn.trim() === "") errors.bindDn = reason("ldap.dn_invalid");
    if (bindPassword === "" && (!editing || !ldap?.bindPasswordSet || bindChangedTarget())) {
      errors.bindPassword = reason("ldap.bind_password_required");
    }
    if (userBaseDn.trim() === "") errors.userBaseDn = reason("ldap.dn_invalid");
    const filter = userFilter.trim();
    if (filter !== "" && !(filter.startsWith("(") && filter.endsWith(")"))) {
      errors.userFilter = reason("ldap.filter_invalid");
    }
    if (!ATTRIBUTE.test(emailAttribute.trim())) {
      errors.emailAttribute = reason("ldap.attribute_invalid");
    }
    if (!ATTRIBUTE.test(nameAttribute.trim())) {
      errors.nameAttribute = reason("ldap.attribute_invalid");
    }
    if (certificate === "custom" && !caPem.includes("-----BEGIN CERTIFICATE-----")) {
      errors.caPem = reason("ldap.ca_invalid");
    }
    const hour = Number(syncHour);
    if (syncSchedule === "daily" && !(Number.isInteger(hour) && hour >= 0 && hour <= 23)) {
      errors.syncHour = reason("ldap.schedule_invalid");
    }
    const threshold = Number(syncThreshold);
    if (!(Number.isInteger(threshold) && threshold >= 1 && threshold <= 100)) {
      errors.syncThreshold = reason("ldap.threshold_invalid");
    }
    markFields(errors);
    return Object.keys(errors).length === 0;
  }

  /** The stored password goes only to the stored URL and bind DN. */
  function bindChangedTarget(): boolean {
    return editing && (url.trim() !== ldap?.url || bindDn.trim() !== ldap.bindDn);
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

  function begin(what: "check" | "save"): boolean {
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

  async function onCheck() {
    if (!begin("check")) return;
    setChecked(null);
    const key = connectionKey;
    try {
      const check = await checkLdap(input(), provider?.id, {
        login: testLogin.trim(),
        password: testPassword,
      });
      setChecked({ key, check });
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
        await updateLdap(provider.id, input(), version, connectionChanged ? token : undefined);
      } else {
        await createLdap(input(), token ?? "");
      }
      onSaved(name.trim(), !editing);
    } catch (error) {
      showFailure(error);
    } finally {
      setBusy(null);
    }
  }

  function clearError(field: Field) {
    if (fieldErrors[field] !== undefined) {
      const next = { ...fieldErrors };
      delete next[field];
      setFieldErrors(next);
    }
  }

  function textInput(
    field: Field,
    value: string,
    onChange: (value: string) => void,
    options: {
      label: string;
      mono?: boolean;
      hint?: ReactNode;
      readOnly?: boolean;
      type?: string;
      placeholder?: string;
      inputMode?: "numeric";
    },
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
          placeholder={options.placeholder}
          inputMode={options.inputMode}
          spellCheck={false}
          autoComplete={options.type === "password" ? "new-password" : "off"}
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

  function segmented<T extends string>(
    field: Field | null,
    label: string,
    value: T,
    options: { value: T; label: string }[],
    onChange: (value: T) => void,
    hint?: string,
  ) {
    const id = `${ids}-${field ?? label}`;
    const error = field === null ? undefined : fieldErrors[field];
    return (
      <div
        className="field"
        ref={field === null ? undefined : (refs[field] as RefObject<HTMLDivElement>)}
      >
        <span className="field__label" id={`${id}-label`}>
          {label}
        </span>
        <div
          className={error === undefined ? "sso-segment" : "sso-segment sso-segment--invalid"}
          aria-describedby={describedBy(id, hint !== undefined, error)}
        >
          <Segmented
            labelled={{ "aria-labelledby": `${id}-label` }}
            value={value}
            options={options}
            onChange={(next) => {
              onChange(next as T);
              if (field !== null) {
                clearError(field);
              }
            }}
          />
        </div>
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

  function select(
    field: "loginAttribute" | "syncSchedule",
    label: string,
    value: string,
    options: { value: string; label: string }[],
    onChange: (value: string) => void,
  ) {
    const id = `${ids}-${field}`;
    const error = fieldErrors[field];
    return (
      <FormField id={id} label={label} error={error}>
        <select
          ref={refs[field]}
          id={id}
          className="select"
          value={value}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={describedBy(id, false, error)}
          onChange={(event) => {
            onChange(event.currentTarget.value);
            clearError(field);
          }}
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </FormField>
    );
  }

  function chooseFlavor(next: LdapFlavor) {
    setFlavor(next);
    const attributes = LOGIN_ATTRIBUTES[next];
    if (!attributes.includes(loginAttribute)) {
      setLoginAttribute(attributes[0] ?? "");
    }
    if (nameAttribute === DEFAULT_NAME_ATTRIBUTE[flavor]) {
      setNameAttribute(DEFAULT_NAME_ATTRIBUTE[next]);
    }
  }

  const caId = `${ids}-caPem`;
  const caError = fieldErrors.caPem;
  return (
    <Dialog
      open
      wide
      title={editing ? t("sso.form.editTitleFor", { name: provider.name }) : t("sso.ldap.addTitle")}
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
            { label: t("sso.ldap.name"), hint: t("sso.ldap.nameHint") },
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
              hint: t(editing ? "sso.form.slugFixed" : "sso.ldap.slugHint"),
            },
          )}
        </div>
        {segmented(
          null,
          t("sso.ldap.flavor"),
          flavor,
          [
            { value: "ad", label: t("sso.ldap.flavor.ad") },
            { value: "ldap", label: t("sso.ldap.flavor.ldap") },
          ],
          chooseFlavor,
        )}
        <div className="sso-form__pair">
          {textInput("url", url, setUrl, {
            label: t("sso.ldap.url"),
            mono: true,
            placeholder: "ldaps://dc01.example.com:636",
          })}
          {segmented(
            "encryption",
            t("sso.ldap.encryption"),
            encryption,
            [
              { value: "ldaps", label: t("sso.ldap.encryption.ldaps") },
              { value: "starttls", label: t("sso.ldap.encryption.starttls") },
              { value: "none", label: t("sso.ldap.encryption.none") },
            ],
            setEncryption,
            encryption === "none" ? t("sso.ldap.encryption.noneHint") : undefined,
          )}
        </div>
        <div className="sso-form__pair">
          {textInput("bindDn", bindDn, setBindDn, {
            label: t("sso.ldap.bindDn"),
            mono: true,
            hint: t("sso.ldap.bindDnHint"),
          })}
          {textInput("bindPassword", bindPassword, setBindPassword, {
            label: t("sso.ldap.bindPassword"),
            mono: true,
            type: "password",
            placeholder:
              editing && ldap?.bindPasswordSet === true ? t("sso.ldap.bindPasswordStored") : "",
            hint:
              editing && ldap?.bindPasswordSet === true
                ? t("sso.ldap.bindPasswordKeep")
                : t("sso.ldap.bindPasswordHint"),
          })}
        </div>
        <div className="sso-form__pair">
          {textInput("userBaseDn", userBaseDn, setUserBaseDn, {
            label: t("sso.ldap.userBaseDn"),
            mono: true,
          })}
          {select(
            "loginAttribute",
            t("sso.ldap.loginAttribute"),
            loginAttribute,
            LOGIN_ATTRIBUTES[flavor].map((attribute) => ({ value: attribute, label: attribute })),
            setLoginAttribute,
          )}
        </div>
        {textInput("userFilter", userFilter, setUserFilter, {
          label: t("sso.ldap.userFilter"),
          mono: true,
          placeholder: "(department=Vertrieb)",
          hint: t("sso.ldap.userFilterHint"),
        })}
        {flavor === "ad" ? (
          <label className="sso-check">
            <input
              type="checkbox"
              checked={nestedGroups}
              onChange={(event) => setNestedGroups(event.currentTarget.checked)}
            />
            <span>
              {t("sso.ldap.nestedGroups")}
              <span className="field__hint">{t("sso.ldap.nestedGroupsHint")}</span>
            </span>
          </label>
        ) : null}
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
        <fieldset className="sso-fieldset">
          <legend className="field__label">{t("sso.ldap.sync")}</legend>
          <div className="sso-form__pair">
            {select(
              "syncSchedule",
              t("sso.ldap.syncSchedule"),
              syncSchedule,
              [
                { value: "daily", label: t("sso.ldap.syncSchedule.daily") },
                { value: "every6h", label: t("sso.ldap.syncSchedule.every6h") },
                { value: "off", label: t("sso.ldap.syncSchedule.off") },
              ],
              (value) => setSyncSchedule(value as LdapSchedule),
            )}
            {syncSchedule === "daily"
              ? textInput("syncHour", syncHour, setSyncHour, {
                  label: t("sso.ldap.syncHour"),
                  inputMode: "numeric",
                  hint: t("sso.ldap.syncHourHint"),
                })
              : null}
            {textInput("syncThreshold", syncThreshold, setSyncThreshold, {
              label: t("sso.ldap.syncThreshold"),
              inputMode: "numeric",
              hint: t("sso.ldap.syncThresholdHint"),
            })}
          </div>
        </fieldset>
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
            {textInput("groupBaseDn", groupBaseDn, setGroupBaseDn, {
              label: t("sso.ldap.groupBaseDn"),
              mono: true,
              hint: t("sso.ldap.groupBaseDnHint"),
            })}
            <div className="sso-form__pair">
              {textInput("emailAttribute", emailAttribute, setEmailAttribute, {
                label: t("sso.ldap.emailAttribute"),
                mono: true,
              })}
              {textInput("nameAttribute", nameAttribute, setNameAttribute, {
                label: t("sso.ldap.nameAttribute"),
                mono: true,
              })}
            </div>
            <label className="sso-check">
              <input
                type="checkbox"
                checked={trustEmail}
                onChange={(event) => setTrustEmail(event.currentTarget.checked)}
              />
              <span>
                {t("sso.ldap.trustEmail")}
                <span className="field__hint">{t("sso.ldap.trustEmailHint")}</span>
              </span>
            </label>
            {segmented(
              null,
              t("sso.ldap.certificate"),
              certificate,
              [
                { value: "system", label: t("sso.ldap.certificate.system") },
                { value: "custom", label: t("sso.ldap.certificate.custom") },
              ],
              setCertificate,
            )}
            {certificate === "custom" ? (
              <FormField
                id={caId}
                label={t("sso.ldap.caPem")}
                hint={t("sso.ldap.caPemHint")}
                error={caError}
              >
                <textarea
                  ref={refs.caPem}
                  id={caId}
                  className="input input--mono admin-textarea"
                  rows={4}
                  spellCheck={false}
                  value={caPem}
                  aria-invalid={caError === undefined ? undefined : true}
                  aria-describedby={describedBy(caId, true, caError)}
                  onChange={(event) => {
                    setCaPem(event.currentTarget.value);
                    clearError("caPem");
                  }}
                />
              </FormField>
            ) : null}
          </div>
        </div>
        <fieldset className="sso-fieldset">
          <legend className="field__label">{t("sso.ldap.test")}</legend>
          <p className="field__hint">{t("sso.ldap.testHint")}</p>
          <div className="sso-form__pair">
            {textInput("testLogin", testLogin, setTestLogin, {
              label: t("sso.ldap.testLogin"),
              mono: true,
            })}
            {textInput("testPassword", testPassword, setTestPassword, {
              label: t("sso.ldap.testPassword"),
              type: "password",
            })}
          </div>
        </fieldset>
        <div role="status" aria-atomic="true" className="sso-results">
          {checkCurrent && checked !== null ? <CheckResult t={t} check={checked.check} /> : null}
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

/** What the check found: the connection, a few people and groups, and the test person. */
function CheckResult({ t, check }: { t: Translate; check: LdapCheck }) {
  const test = check.test;
  return (
    <>
      <p className="sso-note-ok">
        <Icon name="check" />
        <span>
          {t(check.tls === null ? "sso.ldap.checkOkPlain" : "sso.ldap.checkOk", {
            tls: check.tls ?? "",
            ms: Math.round(check.durationMs),
          })}{" "}
          {t("sso.ldap.checkSample", {
            users: check.sample.users.length === 0 ? "–" : check.sample.users.join(", "),
            groups: check.sample.groups.length,
          })}
        </span>
      </p>
      {test === null ? null : (
        <p className="sso-note-ok">
          <Icon name="check" />
          <span>
            {t(test.bound ? "sso.ldap.testOk" : "sso.ldap.testFound", {
              login: test.login,
              groups:
                test.groups.length === 0 ? t("sso.form.testNoGroups") : test.groups.join(", "),
              outcome: outcomeText(t, test.outcome),
            })}
          </span>
        </p>
      )}
    </>
  );
}
