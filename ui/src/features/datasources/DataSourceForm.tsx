import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { Fragment, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { isApiError } from "../../api/client";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { EmptyState } from "../../components/EmptyState";
import { FormAlert } from "../../components/FormAlert";
import { Icon } from "../../components/Icon";
import { Page, PageActions } from "../../components/Page";
import { TextField } from "../../components/TextField";
import { catalogs, type MessageKey, type Translate, useI18n } from "../../i18n/i18n";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import { Dialog } from "../dashboards/ui/Dialog";
import { errorCodeMessage, errorMessage } from "../dashboards/ui/errors";
import {
  createDatasource,
  DATASOURCES_KEY,
  type Datasource,
  type DatasourceKind,
  datasourceQuery,
  type Health,
  type HealthWarning,
  kindsQuery,
  type SettingSpec,
  testDatasource,
} from "./api";
import {
  connectionFields,
  hasHost,
  MASK,
  parseConnectionString,
  supportsConnectionString,
  toConnectionString,
} from "./connectionString";
import { KindMark, kindSummary } from "./kindMarks";
import { errorReason, reasonText } from "./reasons";
import {
  groupSettings,
  KIND_PICKER_GROUPS,
  openAtFirst,
  pickerGroup,
  type Section,
  type SummaryPart,
  summarize,
} from "./settingSections";
import "./datasources.css";

const newRoute = getRouteApi("/_app/data-sources/new");

/**
 * Server-provided label keys are used when this UI knows them; a plugin field's label from its
 * manifest in the UI's language (English when it has none); otherwise the field name.
 */
export function settingLabel(t: Translate, spec: SettingSpec, language: string): string {
  if (Object.hasOwn(catalogs.en, spec.labelKey)) {
    return t(spec.labelKey as MessageKey);
  }
  return spec.labels?.[language] ?? spec.labels?.en ?? spec.name;
}

/** A plugin field's help from its manifest, in the UI's language or English. */
function settingHelp(spec: SettingSpec, language: string): string | undefined {
  return spec.help?.[language] ?? spec.help?.en;
}

/** The line under a kind's name: its summary, or for a plugin kind who publishes it. */
export function kindLine(t: Translate, kind: DatasourceKind): string | null {
  if (kind.plugin !== undefined) {
    return t("datasources.plugin.line", {
      publisher: kind.plugin.publisher ?? t("datasources.plugin.noPublisher"),
      version: kind.plugin.version,
    });
  }
  return kindSummary(t, kind.kind);
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
  const { t, language } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { kind: chosen, from } = newRoute.useSearch();
  const pickerId = useId();
  const [search, setSearch] = useState("");
  const kinds = useQuery(kindsQuery(orgId));
  // Duplicate starts from another source of the same kind: its name and settings, not secrets.
  const original = useQuery({ ...datasourceQuery(orgId, from ?? ""), enabled: from !== undefined });
  const prefill =
    original.data === undefined || original.data.kind !== chosen
      ? undefined
      : {
          ...original.data,
          name: t("datasources.duplicate.name", { name: original.data.name }),
          secrets: {},
        };
  const create = useMutation({
    mutationFn: (output: FormOutput) => createSource(output),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: [DATASOURCES_KEY, orgId] });
      await navigate({
        to: "/data-sources/$datasourceId",
        params: { datasourceId: created.id },
      });
    },
  });
  // Tests what the form holds without saving it; saving needs no test first.
  const test = useMutation({
    mutationFn: (output: FormOutput) =>
      testDatasource(orgId, {
        kind: chosen ?? "",
        settings: output.settings ?? {},
        secrets: setSecrets(output),
      }),
  });
  function setSecrets(input: FormOutput) {
    return Object.fromEntries(
      Object.entries(input.secrets).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }
  function createSource(input: FormOutput) {
    return createDatasource(orgId, {
      name: input.name,
      kind: chosen ?? "",
      settings: input.settings ?? {},
      secrets: setSecrets(input),
    });
  }

  if (kinds.isPending || (from !== undefined && original.isPending)) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  if (kinds.isError) {
    return <FormAlert>{errorMessage(t, kinds.error)}</FormAlert>;
  }
  const kind = kinds.data.find((k) => k.kind === chosen);
  const needle = search.trim().toLocaleLowerCase(language);
  const matches = kinds.data.filter((option) =>
    [option.name, option.kind, kindLine(t, option) ?? ""].some((text) =>
      text.toLocaleLowerCase(language).includes(needle),
    ),
  );
  const step = kind === undefined ? 1 : create.isPending ? 3 : 2;
  return (
    <div className={kind === undefined ? "ds-new" : "ds-new ds-new--chosen"}>
      <PageActions>
        <Stepper current={step} />
      </PageActions>
      <section className="ds-kinds" aria-labelledby={`${pickerId}-title`}>
        <div className="ds-kinds__head">
          {/* The count stays out of the heading, so the heading is named "Kind" alone. */}
          <div className="ds-kinds__title">
            <h2 id={`${pickerId}-title`}>{t("datasources.new.pickKind")}</h2>
            <span className="ds-kinds__count">
              {t("datasources.new.kindCount", { count: kinds.data.length })}
            </span>
          </div>
          <div className="ds-search ds-kinds__search">
            <Icon name="search" />
            <label className="visually-hidden" htmlFor={`${pickerId}-search`}>
              {t("datasources.new.searchKinds")}
            </label>
            <input
              id={`${pickerId}-search`}
              type="search"
              className="input ds-search__input"
              placeholder={t("datasources.new.searchKinds")}
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
            />
          </div>
        </div>
        {matches.length === 0 ? (
          <p className="ds-kinds__none">{t("datasources.new.noKind")}</p>
        ) : null}
        {KIND_PICKER_GROUPS.map((group) => {
          const options = matches.filter((option) => pickerGroup(option.kind) === group);
          if (options.length === 0) {
            return null;
          }
          return (
            <div key={group} className="ds-kinds__group">
              <h3 className="ds-kinds__group-title" id={`${pickerId}-${group}`}>
                {t(`datasources.new.group.${group}`)}
                {group === "plugins" ? (
                  <span className="ds-kinds__group-note">
                    {" "}
                    {t("datasources.new.group.pluginsNote")}
                  </span>
                ) : null}
              </h3>
              <ul className="ds-kinds__list" aria-labelledby={`${pickerId}-${group}`}>
                {options.map((option) => (
                  <li key={option.kind} className="ds-kinds__item">
                    {/* Named by the product alone; the summary next to it describes the link. */}
                    <Link
                      to="/data-sources/new"
                      search={{ kind: option.kind }}
                      className="ds-kinds__link"
                      aria-describedby={`${pickerId}-${option.kind}`}
                    >
                      <KindMark kind={option.kind} small name={option.name} />
                      <span className="ds-kinds__name">{option.name}</span>
                      {option.kind === chosen ? (
                        <span className="ds-kinds__check" aria-hidden="true">
                          <Icon name="check" />
                        </span>
                      ) : null}
                    </Link>
                    <span className="ds-kinds__summary" id={`${pickerId}-${option.kind}`}>
                      {/* A plugin kind names its publisher here, as plain text like a summary. */}
                      {kindLine(t, option)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </section>
      <div className="ds-new__form">
        {kind === undefined ? (
          <div className="ds-card ds-card--empty">
            <EmptyState icon="dataSources" title={t("datasources.new.noneChosen")}>
              {t("datasources.new.noneChosenText")}
            </EmptyState>
          </div>
        ) : (
          <>
            <Link to="/data-sources/new" search={{}} className="back-link ds-new__change">
              <Icon name="back" />
              {t("datasources.new.changeKind")}
            </Link>
            <SettingsForm
              key={kind.kind}
              kind={kind}
              initial={undefined}
              prefill={prefill}
              busy={create.isPending}
              error={create.error}
              submitLabel={t("datasources.form.create")}
              title={t("datasources.new.connect", { kind: kind.name })}
              subtitle={[t("datasources.new.step", { step: 2, count: 3 }), kindLine(t, kind)]
                .filter(Boolean)
                .join(" · ")}
              onSubmit={(output) => create.mutate(output)}
              // This page is for members who may add sources, which is what testing takes.
              onTest={(output) => test.mutate(output)}
              onEdited={test.reset}
              testing={test.isPending}
              status={
                <HealthResult
                  health={test.data ?? null}
                  error={test.error}
                  empty={
                    <div className="ds-test-status" data-state="untested">
                      <span className="ds-status__dot" aria-hidden="true" />
                      <div>
                        <strong>{t("datasources.new.untested")}</strong>
                        <p className="field__hint">{t("datasources.new.untestedText")}</p>
                      </div>
                    </div>
                  }
                />
              }
              cancel={
                <Link to="/data-sources" search={{}} className="button button--ghost">
                  {t("datasources.form.cancel")}
                </Link>
              }
            />
          </>
        )}
      </div>
    </div>
  );
}

const STEPS = ["kind", "connection", "test"] as const;

/** Where the user is in adding a source: done steps get a check, the current one is marked. */
function Stepper({ current }: { current: number }) {
  const { t } = useI18n();
  return (
    <ol className="ds-steps" aria-label={t("datasources.new.steps")}>
      {STEPS.map((step, index) => {
        const number = index + 1;
        const state = number < current ? "done" : number === current ? "current" : "next";
        return (
          <li
            key={step}
            className="ds-steps__step"
            data-state={state}
            aria-current={state === "current" ? "step" : undefined}
          >
            <span className="ds-steps__mark" aria-hidden="true">
              {state === "done" ? <Icon name="check" /> : number}
            </span>
            <span>{t(`datasources.new.stepName.${step}`)}</span>
            {state === "done" ? (
              <span className="visually-hidden">{t("datasources.new.stepDone")}</span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export interface SaveRequest {
  output: FormOutput;
  /** The `updatedAt` the change is made on. */
  expected: number | undefined;
}

export interface Conflict {
  /** The data source as it is stored now. */
  stored: Datasource;
  /** What was refused: a save of the form's output, or the delete. */
  retry: { kind: "save"; output: FormOutput } | { kind: "delete" };
}

/**
 * Someone else changed the source after this form started. Loading the stored source is the
 * default; the refused save or delete can also go through over it.
 */
export function ConflictDialog({
  conflict,
  onLoadStored,
  onOverwrite,
}: {
  conflict: Conflict;
  onLoadStored: () => void;
  onOverwrite: () => void;
}) {
  const { t } = useI18n();
  const deleting = conflict.retry.kind === "delete";
  return (
    <Dialog
      title={t("datasources.conflict.title")}
      onClose={onLoadStored}
      actions={
        <>
          <button
            type="button"
            className="button button--secondary"
            onClick={onLoadStored}
            data-autofocus
          >
            {t("datasources.conflict.loadStored")}
          </button>
          <button type="button" className="button button--primary" onClick={onOverwrite}>
            {deleting
              ? t("datasources.conflict.deleteAnyway")
              : t("datasources.conflict.overwrite")}
          </button>
        </>
      }
    >
      <p>
        {deleting
          ? t("datasources.conflict.deleteText", { name: conflict.stored.name })
          : t("datasources.conflict.text", { name: conflict.stored.name })}
      </p>
    </Dialog>
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

/**
 * What a passed connection test found that needs attention (TigerGraph: REST++ without
 * authentication), as a quiet neutral notice: the source works, saving stays allowed.
 */
export function HealthWarnings({ warnings }: { warnings: HealthWarning[] }) {
  const { t } = useI18n();
  if (warnings.length === 0) return null;
  return (
    <div className="notice ds-warnings">
      <Icon name="alert" />
      <div className="ds-health">
        <strong>{t("datasources.health.warnings")}</strong>
        {warnings.map((warning) => (
          <span key={warning.reason} className="ds-health__message">
            {reasonText(t, {
              reason: warning.reason,
              params: warning.params,
              fallback: warning.message,
            }) ?? warning.message}
          </span>
        ))}
      </div>
    </div>
  );
}

/** The outcome of "Test connection", in a live region so it is announced. */
export function HealthResult({
  health,
  error,
  empty = null,
  warnings = true,
}: {
  health: Health | null;
  error: Error | null;
  /** What shows before any test. */
  empty?: ReactNode;
  /** Whether the result shows its warnings (off where the page shows them on its own). */
  warnings?: boolean;
}) {
  const { t } = useI18n();
  let content = empty;
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
    if (warnings) {
      content = (
        <>
          {content}
          <HealthWarnings warnings={health.ok ? (health.warnings ?? []) : []} />
        </>
      );
    }
  }
  // One live region that stays mounted, so the result is announced when it arrives.
  return (
    <div role="status" aria-live="polite" className="ds-health-region">
      {content}
    </div>
  );
}

/** Before the first test: says what the test checks. */
export function UntestedNote() {
  const { t } = useI18n();
  return (
    <div className="ds-test-status" data-state="untested">
      <span className="ds-status__dot" aria-hidden="true" />
      <div>
        <strong>{t("datasources.new.untested")}</strong>
        <p className="field__hint">{t("datasources.edit.untestedText")}</p>
      </div>
    </div>
  );
}

/**
 * What the form produces; secrets follow the API's patch semantics (absent keep, null remove).
 * `settings` is left out when nothing in them changed.
 */
export interface FormOutput {
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
  /** Tests what the form holds, saved or not; without it the form offers no test. */
  onTest?: (output: FormOutput) => void;
  testing?: boolean;
  saved?: boolean;
  /** The caller may use the source but not change it: fields show, nothing can be saved. */
  readOnly?: boolean;
  /** The caller may change the source but not where it connects: target fields are locked. */
  targetLocked?: boolean;
  /** The card's heading; the kind's name when left out. */
  title?: string;
  /** One line under the heading (the step and what the kind covers). */
  subtitle?: string | undefined;
  /** The test status block above the buttons. */
  status?: ReactNode;
  /** The way out, left of the buttons. */
  cancel?: ReactNode;
  /** A source to start a new one from (Duplicate): its name and settings, never its secrets. */
  prefill?: Datasource | undefined;
  /** Told whenever the form gets or loses unsaved changes (the page's leave guard). */
  onDirtyChange?: (dirty: boolean) => void;
  /** Told after every edit of a field, so a test result of what was entered before can go. */
  onEdited?: () => void;
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
export function SettingsForm({
  kind,
  initial,
  busy,
  error,
  submitLabel,
  onSubmit,
  onTest,
  testing = false,
  saved = false,
  readOnly = false,
  targetLocked = false,
  title,
  subtitle,
  status,
  cancel,
  prefill,
  onDirtyChange,
  onEdited,
}: SettingsFormProps) {
  const { t } = useI18n();
  const plain = kind.settings.filter((spec) => !spec.secret);
  const secret = kind.settings.filter((spec) => spec.secret);
  // What the fields start with: the stored source, or the one a new source is copied from.
  const seed = initial ?? prefill;
  const [name, setName] = useState(seed?.name ?? "");
  const [values, setValues] = useState<Record<string, string | boolean>>(() =>
    Object.fromEntries(plain.map((spec) => [spec.name, initialValue(spec, seed)])),
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
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  // Whatever was typed after a test makes its result stale; the first run is no edit.
  const edited = useRef(false);
  const onEditedNow = useRef(onEdited);
  onEditedNow.current = onEdited;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the fields are the trigger
  useEffect(() => {
    if (edited.current) {
      onEditedNow.current?.();
    }
    edited.current = true;
  }, [name, values, secrets]);
  // A form that goes away (saved and started again, or left) holds nothing unsaved any more.
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const [focusInvalid, setFocusInvalid] = useState(0);
  const formRef = useRef<HTMLFormElement>(null);
  const groups = groupSettings(kind.settings);
  const [openSections, setOpenSections] = useState<Partial<Record<Section, boolean>>>(() =>
    Object.fromEntries(groups.map(({ section, specs }) => [section, openAtFirst(section, specs)])),
  );
  const [useString, setUseString] = useState(false);
  const [connStringError, setConnStringError] = useState<string | undefined>(undefined);
  const secretSet = (field: string) => {
    const state = secrets[field];
    return state?.mode === "set"
      ? state.value !== ""
      : state?.mode === "keep" && initial?.secrets[field]?.set === true;
  };

  const server = serverFieldText(
    t,
    error,
    secret.map((spec) => spec.name),
  );
  const fieldError = (field: string) =>
    errors[field] ??
    (field === "connectionString" ? connStringError : undefined) ??
    (server?.field === field ? server.text : undefined);

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
        if (spec.name === "port" && (Number(text) < 1 || Number(text) > 65535)) {
          found[spec.name] = t("datasources.form.portRange");
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
    // A string that could not be read would leave the fields at an older one: say so first.
    if (useString && connStringError !== undefined) {
      found.connectionString = connStringError;
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

  function submit() {
    const output = validate();
    if (output === null) {
      return;
    }
    setDirty(false);
    onSubmit(output);
  }

  /** Tests what is entered now; the form stays as it is, nothing is saved. */
  function testNow() {
    const output = validate();
    if (output !== null) {
      onTest?.(output);
    }
  }

  const change = (field: string, value: string | boolean) => {
    setValues((current) => ({ ...current, [field]: value }));
    setDirty(true);
  };

  return (
    <form
      ref={formRef}
      className="form ds-form ds-card"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="ds-card__head">
        <KindMark kind={kind.kind} name={kind.name} />
        <div className="ds-card__title">
          <h2>{title ?? kind.name}</h2>
          {subtitle === undefined ? null : <p className="ds-card__sub">{subtitle}</p>}
        </div>
        <span className="ds-badge">
          <Icon name="lock" />
          {t("datasources.form.readOnlyQueries")}
        </span>
      </div>
      <div className="ds-card__body">
        <p className="field__hint ds-card__hint">{readOnlyHint(t, kind)}</p>
        {readOnly ? (
          <p className="ds-locked">
            <Icon name="lock" />
            <span>{t("datasources.form.readOnlyAccess")}</span>
          </p>
        ) : targetLocked && plain.some((spec) => spec.target) ? (
          <p className="ds-locked">
            <Icon name="lock" />
            <span>{t("datasources.form.targetLocked")}</span>
          </p>
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
      </div>
      {/* Per section, each in the kind's own order, so a password follows its user name. */}
      {groups.map(({ section, specs }) => {
        const hasError = specs.some((spec) => fieldError(spec.name) !== undefined);
        const stringMode = section === "connection" && useString && !readOnly;
        return (
          <FormSection
            key={section}
            section={section}
            open={openSections[section] === true || hasError}
            onToggle={() =>
              setOpenSections((current) => ({ ...current, [section]: !current[section] }))
            }
            summary={summarize(specs, values, secretSet, section === "behavior")}
            specs={specs}
            locked={readOnly || (targetLocked && specs.some((spec) => spec.target))}
          >
            {section === "cache" ? (
              <p className="field__hint">{t("datasources.cache.hint")}</p>
            ) : null}
            {section === "connection" && supportsConnectionString(kind.kind) && !readOnly ? (
              <ConnectionStringBlock
                kind={kind}
                values={values}
                stringMode={useString}
                onMode={(next) => setUseString(next)}
                disabled={targetLocked}
                error={fieldError("connectionString")}
                onError={(text) => {
                  setConnStringError(text);
                  setErrors(({ connectionString: _, ...rest }) => rest);
                }}
                onParsed={(parsed, password) => {
                  setValues((current) => ({ ...current, ...parsed }));
                  if (password !== "unchanged") {
                    // A string without a password takes back one typed before; a stored one
                    // stays stored, as when the form opened.
                    const next: SecretState =
                      password !== undefined && password !== ""
                        ? { mode: "set", value: password }
                        : initial?.secrets.password?.set === true
                          ? { mode: "keep" }
                          : { mode: "set", value: "" };
                    setSecrets((current) => ({ ...current, password: next }));
                  }
                  setDirty(true);
                }}
              />
            ) : null}
            {specs.map((spec) =>
              stringMode &&
              connectionFields(kind.kind).includes(spec.name) &&
              fieldError(spec.name) === undefined ? null : !spec.secret ? (
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
            {section === "connection" &&
            supportsConnectionString(kind.kind) &&
            !readOnly &&
            !useString ? (
              <ConnectionStringPreview
                kind={kind}
                values={values}
                passwordSet={secretSet("password")}
              />
            ) : null}
          </FormSection>
        );
      })}
      {status === undefined ? null : <div className="ds-card__status">{status}</div>}
      {readOnly ? null : (
        <div className="ds-card__actions">
          {cancel}
          <span className="ds-form__saved" role="status">
            {saved && !dirty ? t("datasources.form.saved") : ""}
          </span>
          {onTest === undefined ? null : (
            <button
              type="button"
              className="button button--secondary"
              disabled={busy || testing}
              onClick={testNow}
            >
              <Icon name="refresh" />
              {testing ? t("datasources.health.testing") : t("datasources.health.test")}
            </button>
          )}
          <button
            type="submit"
            className="button button--primary"
            disabled={busy}
            aria-disabled={busy}
          >
            {busy ? t("datasources.form.saving") : submitLabel}
          </button>
        </div>
      )}
    </form>
  );
}

/**
 * One section of the form, as a disclosure: its title and, while closed, the values set in it.
 * Closed content stays mounted (hidden), so what was typed is kept.
 */
function FormSection({
  section,
  open,
  onToggle,
  summary,
  specs,
  locked = false,
  children,
}: {
  section: Section;
  open: boolean;
  onToggle: () => void;
  summary: SummaryPart[];
  specs: readonly SettingSpec[];
  /** Some of its fields cannot be changed by the caller: marked with a lock. */
  locked?: boolean;
  children: ReactNode;
}) {
  const { t, language } = useI18n();
  const id = useId();
  const shown = summary.slice(0, 3);
  const label = (name: string) => {
    const spec = specs.find((candidate) => candidate.name === name);
    return spec === undefined ? name : settingLabel(t, spec, language);
  };
  return (
    <section className="ds-section" aria-labelledby={`${id}-title`}>
      <h3 className="ds-section__heading">
        <button
          type="button"
          className="ds-section__toggle"
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={onToggle}
        >
          <span className="ds-section__chevron" aria-hidden="true">
            <Icon name="chevron" />
          </span>
          <span id={`${id}-title`} className="ds-section__title">
            {t(`datasources.section.${section}`)}
          </span>
          {/* Spaces between the parts keep the button's name readable; flex layout drops them. */}
          {open || shown.length === 0 ? null : " "}
          {open || shown.length === 0 ? null : (
            <span className="ds-section__summary">
              {shown.map((part, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the parts follow the fields' fixed order
                <Fragment key={index}>
                  {index > 0 ? " " : null}
                  <span
                    className={
                      part.type === "value" && part.mono ? "ds-chip ds-chip--mono" : "ds-chip"
                    }
                  >
                    {part.type === "value"
                      ? part.text
                      : part.type === "secret"
                        ? t("datasources.section.secretSet", { name: label(part.name) })
                        : label(part.name)}
                  </span>
                </Fragment>
              ))}
              {summary.length > shown.length ? " " : null}
              {summary.length > shown.length ? (
                <span className="ds-chip">
                  {t("datasources.section.more", { count: summary.length - shown.length })}
                </span>
              ) : null}
            </span>
          )}
          {locked ? " " : null}
          {locked ? (
            <span className="ds-chip ds-chip--locked">
              <Icon name="lock" />
              {t("datasources.section.locked")}
            </span>
          ) : null}
        </button>
      </h3>
      <div id={`${id}-body`} className="ds-section__body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}

/**
 * "Fields | Connection string" for the kinds whose settings a string expresses. In fields mode
 * the string is shown read-only below the fields (the password masked); in string mode a pasted
 * string fills the fields as it is typed, and an unknown part is said, not dropped.
 */
function ConnectionStringBlock({
  kind,
  values,
  stringMode,
  onMode,
  disabled,
  error,
  onError,
  onParsed,
}: {
  kind: DatasourceKind;
  values: Readonly<Record<string, string | boolean>>;
  stringMode: boolean;
  onMode: (stringMode: boolean) => void;
  disabled: boolean;
  /** A string that cannot be read; the form refuses to save while one is shown. */
  error: string | undefined;
  onError: (error: string | undefined) => void;
  /** `unchanged`: the string still holds the mask, so the password stays as it is. */
  onParsed: (
    values: Record<string, string | boolean>,
    password: string | undefined | "unchanged",
  ) => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  function read(next: string) {
    setText(next);
    if (next.trim() === "") {
      onError(undefined);
      return;
    }
    const result = parseConnectionString(kind.kind, next, kind.settings);
    if (!result.ok) {
      onError(t(`datasources.connString.error.${result.error}`, { detail: result.detail ?? "" }));
      return;
    }
    onError(undefined);
    const password = result.password === MASK ? "unchanged" : result.password;
    onParsed(result.values, password);
    if (password !== undefined && password !== "unchanged") {
      // The password moved to its field; the box shows only the mask from now on.
      setText(toConnectionString(kind.kind, { ...values, ...result.values }, kind.settings, MASK));
    }
  }
  return (
    <div className="ds-connstring">
      <fieldset className="ds-segmented" disabled={disabled}>
        <legend className="visually-hidden">{t("datasources.connString.mode")}</legend>
        <button
          type="button"
          className="ds-segmented__button"
          aria-pressed={!stringMode}
          onClick={() => {
            // The fields hold the last string that could be read; the box is emptied.
            setText("");
            onError(undefined);
            onMode(false);
          }}
        >
          {t("datasources.connString.fields")}
        </button>
        <button
          type="button"
          className="ds-segmented__button"
          aria-pressed={stringMode}
          onClick={() => {
            // Starts from the fields, without the password: it is never read back.
            setText(toConnectionString(kind.kind, values, kind.settings, undefined));
            onError(undefined);
            onMode(true);
          }}
        >
          {t("datasources.connString.string")}
        </button>
      </fieldset>
      {stringMode ? (
        <TextField
          label={t("datasources.connString.label")}
          hint={t("datasources.connString.hint")}
          value={text}
          onValueChange={read}
          error={error}
          mono
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
        />
      ) : null}
    </div>
  );
}
/** The fields as a string, read-only below them, the password masked. */
function ConnectionStringPreview({
  kind,
  values,
  passwordSet,
}: {
  kind: DatasourceKind;
  values: Readonly<Record<string, string | boolean>>;
  passwordSet: boolean;
}) {
  const { t } = useI18n();
  const id = useId();
  return (
    <div className="ds-connstring__preview">
      <span className="field__label" id={`${id}-label`}>
        {t("datasources.connString.asString")}
      </span>
      {hasHost(kind.kind, values) ? (
        <output className="ds-connstring__value" aria-labelledby={`${id}-label`}>
          {toConnectionString(kind.kind, values, kind.settings, passwordSet ? MASK : undefined)}
        </output>
      ) : (
        <p className="ds-connstring__empty">{t("datasources.connString.noHost")}</p>
      )}
      <p className="field__hint">{t("datasources.connString.previewHint")}</p>
    </div>
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
  const { t, language } = useI18n();
  const id = useId();
  const errorId = `${id}-error`;
  const label = settingLabel(t, spec, language);
  const help = settingHelp(spec, language);
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
      hint={help}
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
  const { t, language } = useI18n();
  const id = useId();
  const statusId = `${id}-status`;
  const label = settingLabel(t, spec, language);

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
