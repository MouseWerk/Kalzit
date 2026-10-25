import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { isApiError } from "../../api/client";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { EmptyState } from "../../components/EmptyState";
import { FormAlert } from "../../components/FormAlert";
import { Icon } from "../../components/Icon";
import { Page } from "../../components/Page";
import { TextField } from "../../components/TextField";
import { catalogs, type MessageKey, type Translate, useI18n } from "../../i18n/i18n";
import { showErrorToast, showToast } from "../../lib/toasts";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import { AccessButton } from "../dashboards/accessIntegration";
import { ConfirmDialog } from "../dashboards/ui/Dialog";
import { errorCodeMessage, errorMessage } from "../dashboards/ui/errors";
import {
  checkHealth,
  createDatasource,
  DATASOURCES_KEY,
  type Datasource,
  type DatasourceKind,
  datasourceQuery,
  deleteDatasource,
  type Health,
  kindsQuery,
  restoreDatasource,
  type SettingSpec,
  sourceAccess,
  updateDatasource,
} from "./api";
import { KindMark, kindSummary } from "./kindMarks";
import { errorReason, reasonText } from "./reasons";
import { forgetHealth, healthQuery } from "./sourceStatus";
import "./datasources.css";

const newRoute = getRouteApi("/_app/data-sources/new");
const editRoute = getRouteApi("/_app/data-sources/$datasourceId");

/** Server-provided label keys are used when this UI knows them; otherwise the field name. */
function settingLabel(t: Translate, spec: SettingSpec): string {
  return Object.hasOwn(catalogs.en, spec.labelKey) ? t(spec.labelKey as MessageKey) : spec.name;
}

/** The read-only login advice of the kind (`hintKey`), or the general one for unknown keys. */
function readOnlyHint(t: Translate, kind: DatasourceKind): string {
  return Object.hasOwn(catalogs.en, kind.hintKey)
    ? t(kind.hintKey as MessageKey)
    : t("datasources.readOnly.lead");
}

/**
 * Text for a field the server named in an error: its reason when the server sent one (see
 * reasons.ts), else a refused target and a name in use are said as such, and anything else is a
 * value the server did not accept.
 */
function serverFieldText(
  t: Translate,
  error: unknown,
  secretFields: readonly string[],
): { field: string; text: string } | null {
  if (!isApiError(error) || error.field === undefined) {
    return null;
  }
  const field = error.field.replace(/^(settings|secrets)\./, "");
  if (field === "settings" || field === "secrets") {
    return null;
  }
  const reason = errorReason(error);
  const reasoned = reason === undefined ? undefined : reasonText(t, reason);
  if (reasoned !== undefined) {
    return { field, text: reasoned };
  }
  // A secret named in a 422: the target moved and the secret has to be entered again.
  if (error.code === "validation" && secretFields.includes(field)) {
    return { field, text: t("datasources.secret.reenter") };
  }
  if (error.code === "datasource_target_blocked") {
    return { field, text: t("errors.datasource_target_blocked") };
  }
  if (error.code === "conflict" && field === "name") {
    return { field, text: t("datasources.form.nameTaken") };
  }
  if (error.code === "validation") {
    return { field, text: t("validation.serverRejected") };
  }
  return null;
}

function useWriteAccess() {
  const org = useCurrentOrg();
  const permissions = useOrgPermissions();
  return { org, permissions, canWrite: permissions.has("datasources:write") };
}

function NoAccess() {
  const { t } = useI18n();
  return (
    <EmptyState icon="lock" title={t("datasources.forbidden.title")}>
      {t("datasources.forbidden.textWrite")}
    </EmptyState>
  );
}

export function NewDataSourcePage() {
  const { t } = useI18n();
  useDocumentTitle("datasources.new.title");
  const { org, permissions, canWrite } = useWriteAccess();
  let body = null;
  if (org !== undefined && canWrite) {
    body = <NewDataSource orgId={org.id} />;
  } else if (permissions.loaded) {
    body = <NoAccess />;
  }
  return (
    <>
      <Breadcrumbs
        crumbs={[
          { label: t("datasources.title"), link: { to: "/data-sources", search: {} } },
          { label: t("datasources.new.title") },
        ]}
      />
      <Page title={t("datasources.new.title")} lead={t("datasources.new.lead")}>
        {body}
      </Page>
    </>
  );
}

function NewDataSource({ orgId }: { orgId: string }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { kind: chosen } = newRoute.useSearch();
  const pickerId = useId();
  const kinds = useQuery(kindsQuery(orgId));
  const create = useMutation({
    mutationFn: (input: FormOutput) =>
      createDatasource(orgId, {
        name: input.name,
        kind: chosen ?? "",
        settings: input.settings ?? {},
        secrets: Object.fromEntries(
          Object.entries(input.secrets).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
      }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: [DATASOURCES_KEY, orgId] });
      await navigate({
        to: "/data-sources/$datasourceId",
        params: { datasourceId: created.id },
      });
    },
  });

  if (kinds.isPending) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  if (kinds.isError) {
    return <FormAlert>{errorMessage(t, kinds.error)}</FormAlert>;
  }
  const kind = kinds.data.find((k) => k.kind === chosen);
  if (kind === undefined) {
    return (
      <section className="ds-kinds" aria-labelledby="ds-kinds-title">
        <h2 id="ds-kinds-title" className="section-title">
          {t("datasources.new.pickKind")}
        </h2>
        <ul className="ds-kinds__list">
          {kinds.data.map((option) => (
            <li key={option.kind} className="ds-kinds__item">
              {/* Named by the product alone; the summary next to it describes the link. */}
              <Link
                to="/data-sources/new"
                search={{ kind: option.kind }}
                className="ds-kinds__link"
                aria-describedby={`${pickerId}-${option.kind}`}
              >
                <KindMark kind={option.kind} />
                <span className="ds-kinds__name">{option.name}</span>
              </Link>
              <span className="ds-kinds__summary" id={`${pickerId}-${option.kind}`}>
                {kindSummary(t, option.kind)}
              </span>
            </li>
          ))}
        </ul>
      </section>
    );
  }
  return (
    <SettingsForm
      kind={kind}
      initial={undefined}
      busy={create.isPending}
      error={create.error}
      submitLabel={t("datasources.form.create")}
      onSubmit={(output) => create.mutate(output)}
    />
  );
}

/** Data sources, then the source's name once it is loaded (the form reads the same query). */
function EditCrumbs({ orgId }: { orgId: string }) {
  const { t } = useI18n();
  const { datasourceId } = editRoute.useParams();
  const source = useQuery(datasourceQuery(orgId, datasourceId));
  return (
    <Breadcrumbs
      crumbs={[
        { label: t("datasources.title"), link: { to: "/data-sources", search: {} } },
        { label: source.data?.name ?? t("datasources.edit.title") },
      ]}
    />
  );
}

export function EditDataSourcePage() {
  const { t } = useI18n();
  useDocumentTitle("datasources.edit.title");
  const org = useCurrentOrg();
  // A grant on this source can allow editing without the org-wide permission, so the server
  // decides: it answers 404 for a source the caller may not see and 403 for a change they may
  // not make.
  return (
    <>
      {org === undefined ? null : <EditCrumbs orgId={org.id} />}
      <Page title={t("datasources.edit.title")}>
        {org === undefined ? null : <EditDataSource orgId={org.id} />}
      </Page>
    </>
  );
}

function EditDataSource({ orgId }: { orgId: string }) {
  const { t } = useI18n();
  const { datasourceId } = editRoute.useParams();
  const permissions = useOrgPermissions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const source = useQuery(datasourceQuery(orgId, datasourceId));
  const kinds = useQuery(kindsQuery(orgId));
  const [health, setHealth] = useState<Health | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Bumped after a save so the form starts again from what the server stored.
  const [formKey, setFormKey] = useState(0);

  const save = useMutation({
    mutationFn: (output: FormOutput) =>
      updateDatasource(orgId, datasourceId, {
        name: output.name,
        secrets: output.secrets,
        ...(output.settings === undefined ? {} : { settings: output.settings }),
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(datasourceQuery(orgId, datasourceId).queryKey, saved);
      // The last test was of the old settings.
      forgetHealth(queryClient, orgId, datasourceId);
      void queryClient.invalidateQueries({ queryKey: [DATASOURCES_KEY, orgId], exact: true });
      setFormKey((key) => key + 1);
    },
  });
  const test = useMutation({
    mutationFn: () => checkHealth(orgId, datasourceId),
    onMutate: () => setHealth(null),
    onSuccess: (result) => {
      setHealth(result);
      // The list shows the same result.
      queryClient.setQueryData(healthQuery(orgId, datasourceId).queryKey, result);
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteDatasource(orgId, datasourceId),
    onSuccess: async () => {
      forgetHealth(queryClient, orgId, datasourceId);
      // The deleted source's own queries (this page, its schema) would only answer 404 now:
      // they are dropped after leaving the page instead of being loaded again.
      const ofThisSource = (query: { queryKey: readonly unknown[] }) =>
        query.queryKey.includes(datasourceId);
      await queryClient.invalidateQueries({
        queryKey: [DATASOURCES_KEY, orgId],
        predicate: (query) => !ofThisSource(query),
      });
      showToast({
        message: t("datasources.deleted"),
        undo: () => {
          restoreDatasource(orgId, datasourceId).then(
            () => {
              forgetHealth(queryClient, orgId, datasourceId);
              return queryClient.invalidateQueries({ queryKey: [DATASOURCES_KEY, orgId] });
            },
            (error: unknown) => showErrorToast(errorMessage(t, error)),
          );
        },
      });
      await navigate({ to: "/data-sources", search: {} });
      queryClient.removeQueries({ queryKey: [DATASOURCES_KEY, orgId], predicate: ofThisSource });
    },
  });

  if (source.isPending || kinds.isPending) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  if (source.isError || kinds.isError) {
    return <FormAlert>{errorMessage(t, source.error ?? kinds.error)}</FormAlert>;
  }
  const kind = kinds.data.find((k) => k.kind === source.data.kind);
  if (kind === undefined) {
    return <FormAlert>{t("datasources.form.unknownKind")}</FormAlert>;
  }
  // The source's own rights (grants included), else the org role. Testing needs query, which
  // admins hold with the built-in roles; a custom role may allow changing without querying.
  const access = sourceAccess(source.data.access, permissions);
  const canTest = access.query;
  // Where the source connects needs `changeTarget`: the org-wide write or an admin grant.
  const targetLocked = !access.changeTarget;

  return (
    <div className="ds-edit">
      <SettingsForm
        key={formKey}
        kind={kind}
        initial={source.data}
        busy={save.isPending}
        error={save.error}
        submitLabel={t("datasources.form.save")}
        onSubmit={(output) => save.mutate(output)}
        readOnly={!access.write}
        targetLocked={targetLocked}
        {...(canTest && access.write
          ? {
              onSubmitAndTest: (output: FormOutput) =>
                save.mutate(output, { onSuccess: () => test.mutate() }),
              onTest: () => test.mutate(),
            }
          : {})}
        testing={test.isPending}
        saved={save.isSuccess}
      />
      {canTest && !access.write ? (
        <div className="form__actions">
          <button
            type="button"
            className="button button--secondary"
            disabled={test.isPending}
            onClick={() => test.mutate()}
          >
            {test.isPending ? t("datasources.health.testing") : t("datasources.health.test")}
          </button>
        </div>
      ) : null}
      <HealthResult health={health} error={test.error} />
      <div className="ds-edit__footer">
        <AccessButton
          resource={{ kind: "datasource", id: datasourceId, name: source.data.name }}
          allowed={source.data.access?.permissions}
        />
        {access.write ? (
          <button
            type="button"
            className="button button--secondary"
            onClick={() => setConfirmDelete(true)}
          >
            {t("datasources.delete")}
          </button>
        ) : null}
      </div>
      {confirmDelete ? (
        <ConfirmDialog
          title={t("datasources.delete.title")}
          confirmLabel={t("datasources.delete.confirm")}
          onCancel={() => {
            remove.reset();
            setConfirmDelete(false);
          }}
          onConfirm={() => remove.mutate()}
          busy={remove.isPending}
          error={remove.isError ? errorMessage(t, remove.error) : undefined}
        >
          {t("datasources.delete.text", { name: source.data.name })}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}

/**
 * What a connection test found, below its heading: the reason in the UI's language (with the
 * source's own wording in it), else the failure's code and the server's text.
 */
function healthText(t: Translate, health: Health) {
  const text =
    health.reason === undefined
      ? undefined
      : reasonText(t, { reason: health.reason, params: health.params, fallback: health.message });
  if (text !== undefined) {
    return <span className="ds-health__message">{text}</span>;
  }
  return (
    <>
      {health.ok || health.code === undefined ? null : (
        <span>{errorCodeMessage(t, health.code)}</span>
      )}
      {health.message === "" ? null : <span className="ds-health__message">{health.message}</span>}
    </>
  );
}

/** The outcome of "Test connection", in a live region so it is announced. */
export function HealthResult({ health, error }: { health: Health | null; error: Error | null }) {
  const { t } = useI18n();
  let content = null;
  if (error !== null) {
    content = (
      <div className="notice notice--danger">
        <Icon name="alert" />
        <span>{errorMessage(t, error)}</span>
      </div>
    );
  } else if (health !== null) {
    content = (
      <div className={health.ok ? "notice" : "notice notice--danger"}>
        <Icon name={health.ok ? "check" : "alert"} className={health.ok ? "icon--success" : ""} />
        <div className="ds-health">
          <strong>
            {health.ok
              ? t("datasources.health.ok", { ms: Math.round(health.latencyMs) })
              : t("datasources.health.failed")}
          </strong>
          {healthText(t, health)}
        </div>
      </div>
    );
  }
  // One live region that stays mounted, so the result is announced when it arrives.
  return (
    <div role="status" aria-live="polite" className="ds-health-region">
      {content}
    </div>
  );
}

/**
 * What the form produces; secrets follow the API's patch semantics (absent keep, null remove).
 * `settings` is left out when nothing in them changed.
 */
interface FormOutput {
  name: string;
  settings?: Record<string, unknown>;
  secrets: Record<string, string | null>;
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

type SecretState = { mode: "keep" } | { mode: "remove" } | { mode: "set"; value: string };

interface SettingsFormProps {
  kind: DatasourceKind;
  /** The stored data source when editing; undefined when adding. */
  initial: Datasource | undefined;
  busy: boolean;
  error: Error | null;
  submitLabel: string;
  onSubmit: (output: FormOutput) => void;
  onSubmitAndTest?: (output: FormOutput) => void;
  onTest?: () => void;
  testing?: boolean;
  saved?: boolean;
  /** The caller may use the source but not change it: fields show, nothing can be saved. */
  readOnly?: boolean;
  /** The caller may change the source but not where it connects: target fields are locked. */
  targetLocked?: boolean;
}

/**
 * What a field starts with: the stored value, else the kind's default, so an untouched form never
 * sends something weaker than the server would use (TLS modes, encryption).
 */
function initialValue(spec: SettingSpec, initial: Datasource | undefined): string | boolean {
  const stored = initial?.settings[spec.name];
  const value = stored === undefined || stored === null ? spec.default : stored;
  if (spec.type === "bool") {
    return value === true;
  }
  return value === undefined || value === null ? "" : String(value);
}

/** A whole number of at least 0, as the `number` setting type requires. */
const WHOLE_NUMBER = /^\d+$/;

/**
 * The settings form of one kind, rendered from the kind's schema. Secret fields are write-only:
 * a stored secret shows as "set" and can be replaced or removed, never read.
 */
function SettingsForm({
  kind,
  initial,
  busy,
  error,
  submitLabel,
  onSubmit,
  onSubmitAndTest,
  onTest,
  testing = false,
  saved = false,
  readOnly = false,
  targetLocked = false,
}: SettingsFormProps) {
  const { t } = useI18n();
  const plain = kind.settings.filter((spec) => !spec.secret);
  const secret = kind.settings.filter((spec) => spec.secret);
  const [name, setName] = useState(initial?.name ?? "");
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(plain.map((spec) => [spec.name, initialValue(spec, initial)])),
  );
  const [secrets, setSecrets] = useState<Record<string, SecretState>>(() =>
    Object.fromEntries(
      secret.map((spec) => [
        spec.name,
        initial?.secrets[spec.name]?.set === true ? { mode: "keep" } : { mode: "set", value: "" },
      ]),
    ),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [focusInvalid, setFocusInvalid] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);

  const server = serverFieldText(
    t,
    error,
    secret.map((spec) => spec.name),
  );
  const fieldError = (field: string) =>
    errors[field] ?? (server?.field === field ? server.text : undefined);

  function validate(): FormOutput | null {
    const found: Record<string, string> = {};
    if (name.trim() === "") {
      found.name = t("datasources.form.nameRequired");
    }
    // Every field as the form holds it; undefined for an empty one.
    const parsed: Record<string, unknown> = {};
    for (const spec of plain) {
      const value = values[spec.name];
      if (spec.type === "bool") {
        parsed[spec.name] = value === true;
        continue;
      }
      const text = String(value ?? "").trim();
      if (text === "") {
        if (spec.required) {
          found[spec.name] = t("datasources.form.required");
        }
        continue;
      }
      if (spec.type === "number") {
        if (!WHOLE_NUMBER.test(text)) {
          found[spec.name] = t("datasources.form.number");
          continue;
        }
        parsed[spec.name] = Number(text);
      } else {
        parsed[spec.name] = text;
      }
    }
    const stored = initial?.settings;
    let settings: Record<string, unknown> | undefined;
    if (stored === undefined) {
      settings = Object.fromEntries(Object.entries(parsed).filter(([, v]) => v !== undefined));
    } else {
      // Only what the user changed: a default the form filled in for a field that is not stored
      // is no change, so a rename never touches the settings (or the stored secrets).
      const next: Record<string, unknown> = { ...stored };
      for (const spec of plain) {
        if (values[spec.name] === initialValue(spec, initial)) {
          continue;
        }
        if (parsed[spec.name] === undefined) {
          delete next[spec.name];
        } else {
          next[spec.name] = parsed[spec.name];
        }
      }
      settings = sameJson(next, stored) ? undefined : next;
    }
    // Changing where the source connects needs every stored secret again (or its removal), so a
    // stored password never goes to a new host unasked (docs/api/datasources.md, Update).
    const movesTarget =
      settings !== undefined &&
      stored !== undefined &&
      plain.some((spec) => spec.target && !sameJson(settings?.[spec.name], stored[spec.name]));
    const reenter: string[] = [];
    const secretOutput: Record<string, string | null> = {};
    for (const spec of secret) {
      const state = secrets[spec.name] ?? { mode: "keep" };
      const isStored = initial?.secrets[spec.name]?.set === true;
      if (
        movesTarget &&
        isStored &&
        (state.mode === "keep" || (state.mode === "set" && state.value === ""))
      ) {
        found[spec.name] = t("datasources.secret.reenter");
        reenter.push(spec.name);
        continue;
      }
      if (state.mode === "remove") {
        if (spec.required) {
          found[spec.name] = t("datasources.form.required");
        }
        secretOutput[spec.name] = null;
      } else if (state.mode === "set") {
        if (state.value !== "") {
          secretOutput[spec.name] = state.value;
        } else if (spec.required && initial?.secrets[spec.name]?.set !== true) {
          found[spec.name] = t("datasources.form.required");
        }
      }
    }
    if (reenter.length > 0) {
      setSecrets((current) => ({
        ...current,
        ...Object.fromEntries(reenter.map((field) => [field, { mode: "set", value: "" }])),
      }));
    }
    setErrors(found);
    if (Object.keys(found).length > 0) {
      setFocusInvalid((count) => count + 1);
      return null;
    }
    const output: FormOutput = { name: name.trim(), secrets: secretOutput };
    if (settings !== undefined) {
      output.settings = settings;
    }
    return output;
  }

  // After a failed submit, focus moves to the first field marked invalid, in form order.
  useEffect(() => {
    if (focusInvalid > 0) {
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    }
  }, [focusInvalid]);

  function submit(andTest: boolean) {
    const output = validate();
    if (output === null) {
      return;
    }
    setDirty(false);
    if (andTest && onSubmitAndTest !== undefined) {
      onSubmitAndTest(output);
    } else {
      onSubmit(output);
    }
  }

  const change = (field: string, value: string | boolean) => {
    setValues((current) => ({ ...current, [field]: value }));
    setDirty(true);
  };

  return (
    <form
      ref={formRef}
      className="form ds-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit(false);
      }}
    >
      <p className="ds-form__kind">
        <KindMark kind={kind.kind} small />
        <span>{kind.name}</span>
      </p>
      <div className="notice">
        <Icon name="lock" />
        <span>{readOnlyHint(t, kind)}</span>
      </div>
      {readOnly ? (
        <p className="field__hint">{t("datasources.form.readOnlyAccess")}</p>
      ) : targetLocked && plain.some((spec) => spec.target) ? (
        <p className="field__hint">{t("datasources.form.targetLocked")}</p>
      ) : null}
      <FormAlert>{error === null || server !== null ? null : errorMessage(t, error)}</FormAlert>
      <TextField
        label={t("datasources.form.name")}
        value={name}
        onValueChange={(value) => {
          setName(value);
          setDirty(true);
        }}
        error={fieldError("name")}
        autoComplete="off"
        required
        disabled={readOnly}
      />
      {/* In the kind's own order, so a password follows its user name, not the limits. */}
      {kind.settings.map((spec) =>
        !spec.secret ? (
          <SettingField
            key={spec.name}
            spec={spec}
            value={values[spec.name] ?? ""}
            error={fieldError(spec.name)}
            onChange={(value) => change(spec.name, value)}
            disabled={readOnly || (targetLocked && spec.target)}
          />
        ) : readOnly ? null : (
          <SecretField
            key={spec.name}
            spec={spec}
            state={secrets[spec.name] ?? { mode: "keep" }}
            stored={initial?.secrets[spec.name]?.set === true}
            error={fieldError(spec.name)}
            onChange={(state) => {
              setSecrets((current) => ({ ...current, [spec.name]: state }));
              setDirty(true);
            }}
          />
        ),
      )}
      {readOnly ? null : (
        <div className="form__actions">
          <button
            type="submit"
            className="button button--primary"
            disabled={busy}
            aria-disabled={busy}
          >
            {busy ? t("datasources.form.saving") : submitLabel}
          </button>
          {onTest === undefined ? null : (
            <button
              type="button"
              className="button button--secondary"
              disabled={busy || testing}
              onClick={() => {
                if (dirty) {
                  // Tests run against what is stored, so unsaved changes are saved first.
                  submit(true);
                } else {
                  onTest();
                }
              }}
            >
              {testing
                ? t("datasources.health.testing")
                : dirty
                  ? t("datasources.health.saveAndTest")
                  : t("datasources.health.test")}
            </button>
          )}
          <span className="ds-form__saved" role="status">
            {saved && !dirty ? t("datasources.form.saved") : ""}
          </span>
        </div>
      )}
    </form>
  );
}

function SettingField({
  spec,
  value,
  error,
  onChange,
  disabled = false,
}: {
  spec: SettingSpec;
  value: string | boolean;
  error: string | undefined;
  onChange: (value: string | boolean) => void;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const id = useId();
  const errorId = `${id}-error`;
  const label = settingLabel(t, spec);
  const errorText =
    error === undefined ? null : (
      <p className="field__error" id={errorId}>
        <Icon name="alert" />
        <span>{error}</span>
      </p>
    );

  if (spec.type === "bool") {
    return (
      <div className="field">
        <label className="checkbox" htmlFor={id}>
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            disabled={disabled}
            onChange={(event) => onChange(event.currentTarget.checked)}
          />
          {label}
        </label>
        {errorText}
      </div>
    );
  }
  if (spec.type === "select") {
    return (
      <div className="field">
        <label className="field__label" htmlFor={id}>
          {label}
        </label>
        <select
          id={id}
          className="select"
          value={String(value)}
          disabled={disabled}
          onChange={(event) => onChange(event.currentTarget.value)}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={error === undefined ? undefined : errorId}
        >
          {spec.required || spec.default !== undefined ? null : (
            <option value="">{t("datasources.form.serverDefault")}</option>
          )}
          {(spec.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        {errorText}
      </div>
    );
  }
  const fullLabel = spec.required ? label : t("datasources.form.optional", { label });
  if (spec.type === "text") {
    return (
      <div className="field">
        <label className="field__label" htmlFor={id}>
          {fullLabel}
        </label>
        <textarea
          id={id}
          className="input input--mono ds-textarea"
          rows={5}
          value={String(value)}
          disabled={disabled}
          spellCheck={false}
          onChange={(event) => onChange(event.currentTarget.value)}
          aria-invalid={error === undefined ? undefined : true}
          aria-describedby={error === undefined ? undefined : errorId}
        />
        {errorText}
      </div>
    );
  }
  return (
    <TextField
      label={fullLabel}
      value={String(value)}
      onValueChange={onChange}
      error={error}
      mono={spec.name === "path" || spec.name === "url"}
      inputMode={spec.type === "number" ? "numeric" : undefined}
      autoComplete="off"
      spellCheck={false}
      disabled={disabled}
    />
  );
}

function SecretField({
  spec,
  state,
  stored,
  error,
  onChange,
}: {
  spec: SettingSpec;
  state: SecretState;
  stored: boolean;
  error: string | undefined;
  onChange: (state: SecretState) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const statusId = `${id}-status`;
  const label = settingLabel(t, spec);

  if (state.mode !== "set") {
    return (
      <div className="field">
        <span className="field__label" id={`${id}-label`}>
          {label}
        </span>
        <div className="ds-secret">
          <span className="ds-secret__status" id={statusId}>
            {state.mode === "keep" ? t("datasources.secret.set") : t("datasources.secret.removed")}
          </span>
          <button
            type="button"
            className="button button--secondary"
            aria-invalid={error === undefined ? undefined : true}
            aria-describedby={`${id}-label ${statusId}`}
            onClick={() => onChange({ mode: "set", value: "" })}
          >
            {t("datasources.secret.change")}
          </button>
          {state.mode === "keep" ? (
            <button
              type="button"
              className="button button--ghost"
              aria-describedby={`${id}-label`}
              onClick={() => onChange({ mode: "remove" })}
            >
              {t("datasources.secret.remove")}
            </button>
          ) : (
            <button
              type="button"
              className="button button--ghost"
              onClick={() => onChange({ mode: "keep" })}
            >
              {t("datasources.secret.keep")}
            </button>
          )}
        </div>
        {error === undefined ? null : (
          <p className="field__error">
            <Icon name="alert" />
            <span>{error}</span>
          </p>
        )}
      </div>
    );
  }
  return (
    <div className="ds-secret-input">
      <TextField
        type="password"
        label={spec.required ? label : t("datasources.form.optional", { label })}
        hint={stored ? t("datasources.secret.replaceHint") : t("datasources.secret.hint")}
        value={state.value}
        onValueChange={(value) => onChange({ mode: "set", value })}
        error={error}
        autoComplete="new-password"
      />
      {stored ? (
        <button
          type="button"
          className="button button--ghost"
          onClick={() => onChange({ mode: "keep" })}
        >
          {t("datasources.secret.keep")}
        </button>
      ) : null}
    </div>
  );
}
