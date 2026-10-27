import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  type FormEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { checkSetupCode, completeSetup, type Me, meQuery, setupStatusQuery } from "../api/auth";
import { type ErrorCode, isApiError } from "../api/client";
import { Icon } from "../components/Icon";
import { TextField } from "../components/TextField";
import { LANGUAGES, type MessageKey, useI18n } from "../i18n/i18n";
import { THEMES, useTheme } from "../theme/theme";
import { AccessAlert, AccessLayout, AccessNotice } from "./AccessLayout";
import { formatWait, useCountdown, waitUntil } from "./countdown";
import { PasswordField } from "./PasswordField";
import { CodeWhere } from "./SetupCode";
import { type SetupChoices, SetupDone } from "./SetupDone";
import "./auth.css";
import {
  type FieldErrors,
  fieldFromServer,
  firstInvalid,
  preventComposingSubmit,
  type SetupField,
  type SetupValues,
  trimWhitespace,
  validateSetup,
} from "./validation";

type Step = 1 | 2 | 3 | 4;
const STEPS: readonly MessageKey[] = [
  "access.setup.step.code",
  "access.setup.step.account",
  "access.setup.step.org",
  "access.setup.step.done",
];
const STEP_FIELDS: Record<1 | 2 | 3, readonly SetupField[]> = {
  1: ["token"],
  2: ["name", "email", "password"],
  3: ["orgName"],
};
const FIELD_ORDER: readonly SetupField[] = ["token", "name", "email", "password", "orgName"];
const EMPTY: SetupValues = { token: "", orgName: "", name: "", email: "", password: "" };

function errorCode(error: unknown): ErrorCode {
  return isApiError(error) ? error.code : "internal";
}

function stepOf(field: SetupField): 1 | 2 | 3 {
  return field === "token" ? 1 : field === "orgName" ? 3 : 2;
}

/** The browser's time zone, the default of the setup's time zone choice. */
function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

function timeZones(first: string): string[] {
  let all: string[] = [];
  try {
    all = Intl.supportedValuesOf("timeZone");
  } catch {
    all = [];
  }
  return [first, ...all.filter((zone) => zone !== first)];
}

/**
 * First-run setup in four steps: the setup code (checked on its own step), the owner's account,
 * the organization with the defaults for everyone, and a finish page with the next steps. Only
 * the third step creates anything, organization and account in one go; Back keeps every input.
 * Once Kalzit is set up, the page only says so.
 */
export function SetupPage() {
  const { t, language } = useI18n();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const status = useQuery(setupStatusQuery);
  const hint = status.data?.codeHint;

  const [step, setStep] = useState<Step>(1);
  const [values, setValues] = useState<SetupValues>(EMPTY);
  const [choices, setChoices] = useState<SetupChoices>(() => ({
    language,
    theme,
    timeZone: browserTimeZone(),
  }));
  const [errors, setErrors] = useState<FieldErrors<SetupField>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [codeChanged, setCodeChanged] = useState(false);
  const [taken, setTaken] = useState(false);
  const [done, setDone] = useState<Me | null>(null);
  const [until, setUntil] = useState<number | null>(null);
  const left = useCountdown(until);
  const waiting = until !== null && left > 0;

  const refs: Record<SetupField, RefObject<HTMLInputElement | null>> = {
    token: useRef<HTMLInputElement>(null),
    name: useRef<HTMLInputElement>(null),
    email: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
    orgName: useRef<HTMLInputElement>(null),
  };
  const heading = useRef<HTMLHeadingElement>(null);
  const focusField = useRef<SetupField | null>(null);

  // A new step gets no animation: its content, the window title and focus on its heading (or on
  // the field a server answer sent the user back to).
  const stepName = t(STEPS[step - 1] ?? "access.setup.step.code");
  const pageTitle = t("app.documentTitle", {
    page: t("access.setup.documentTitle", { step, total: STEPS.length, name: stepName }),
  });
  useEffect(() => {
    document.title = pageTitle;
  }, [pageTitle]);
  const shownStep = useRef(step);
  // The refs are stable; only a change of step moves focus.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refs are stable
  useEffect(() => {
    if (shownStep.current === step) {
      return;
    }
    shownStep.current = step;
    const field = focusField.current;
    focusField.current = null;
    if (field !== null) {
      refs[field].current?.focus();
    } else {
      heading.current?.focus();
    }
  }, [step]);

  function markSetupDone() {
    queryClient.setQueryData(setupStatusQuery.queryKey, { needed: false });
  }

  const check = useMutation({
    mutationFn: checkSetupCode,
    retry: false,
    onSuccess: () => {
      setConfirmed(true);
      setCodeChanged(false);
      setStep(2);
    },
    onError: (error) => {
      const wait = waitUntil(error);
      const code = errorCode(error);
      if (wait !== null) {
        setUntil(wait);
        setErrors({ token: { key: "access.setup.code.rateLimited" } });
      } else if (code === "invalid_setup_token") {
        setErrors({
          token: {
            key: hint === "fixed" ? "access.setup.code.wrongFixed" : "access.setup.code.wrong",
          },
        });
      } else if (code === "setup_token_expired") {
        setErrors({ token: { key: "errors.setup_token_expired" } });
      } else if (code === "setup_done") {
        markSetupDone();
        return;
      } else {
        setErrors({ token: { key: `errors.${code}` } });
      }
      refs.token.current?.focus();
    },
  });

  const setup = useMutation({
    mutationFn: completeSetup,
    retry: false,
    onSuccess: (me) => {
      queryClient.setQueryData(meQuery.queryKey, me);
      markSetupDone();
      setDone(me);
      setStep(4);
    },
    onError: (error) => {
      const code = errorCode(error);
      const rejected = fieldFromServer(FIELD_ORDER, error);
      if (code === "invalid_setup_token" || code === "setup_token_expired") {
        // The server was restarted since the code was checked: back to the code, inputs kept.
        setConfirmed(false);
        setCodeChanged(true);
        setErrors({ token: { key: "errors.setup_token_expired" } });
        focusField.current = "token";
        setStep(1);
      } else if (code === "setup_done") {
        setTaken(true);
        markSetupDone();
      } else if (rejected !== undefined) {
        setErrors({ [rejected]: { key: "validation.serverRejected" } });
        const target = stepOf(rejected);
        if (target === step) {
          refs[rejected].current?.focus();
        } else {
          focusField.current = rejected;
          setStep(target);
        }
      }
    },
  });

  function edit(field: SetupField) {
    return (value: string) => {
      setValues({ ...values, [field]: value });
      if (field === "token") {
        setConfirmed(false);
      }
      if (errors[field] !== undefined) {
        const next = { ...errors };
        delete next[field];
        setErrors(next);
      }
    };
  }

  const fieldError = (field: SetupField) => {
    const error = errors[field];
    return error === undefined ? undefined : t(error.key, error.params);
  };

  /** Checks the fields of one step; focuses the first wrong one. */
  function validStep(which: 1 | 2 | 3): boolean {
    const all = validateSetup(values);
    const found: FieldErrors<SetupField> = {};
    for (const field of STEP_FIELDS[which]) {
      if (all[field] !== undefined) {
        found[field] = all[field];
      }
    }
    setErrors(found);
    const invalid = firstInvalid(STEP_FIELDS[which], found);
    if (invalid !== undefined) {
      refs[invalid].current?.focus();
      return false;
    }
    return true;
  }

  function submitCode(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (check.isPending || waiting || !validStep(1)) {
      return;
    }
    if (confirmed) {
      setStep(2);
      return;
    }
    setUntil(null);
    check.mutate(trimWhitespace(values.token));
  }

  function submitAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (validStep(2)) {
      setStep(3);
    }
  }

  function submitOrg(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (setup.isPending || !validStep(3)) {
      return;
    }
    setup.mutate({
      token: trimWhitespace(values.token),
      orgName: trimWhitespace(values.orgName),
      name: trimWhitespace(values.name),
      email: trimWhitespace(values.email),
      password: values.password,
      language: choices.language,
      theme: choices.theme,
      timeZone: choices.timeZone,
    });
  }

  function back() {
    setErrors({});
    setStep(step === 3 ? 2 : 1);
  }

  // Kalzit is set up (by someone else, or before this page was opened): only that, no steps.
  if (status.data?.needed === false && done === null && !taken) {
    return (
      <AccessLayout context={t("access.top.setupContext")} width="wide" helpInNewTab>
        <div className="access__card setup-already">
          <span className="setup-already__mark">
            <Icon name="check" />
          </span>
          <h1 className="setup-already__title">{t("access.setup.already.title")}</h1>
          <p className="access__lead">{t("access.setup.already.text")}</p>
          <Link to="/login" className="button button--primary">
            {t("access.toLogin")}
            <Icon name="arrowRight" />
          </Link>
        </div>
      </AccessLayout>
    );
  }

  let title: string;
  let lead: string;
  let card: ReactNode;
  if (step === 1) {
    title = t("access.setup.code.title");
    lead = t("access.setup.code.lead");
    card = (
      <form
        className="access__card"
        noValidate
        onSubmit={submitCode}
        onKeyDown={preventComposingSubmit}
      >
        {codeChanged ? (
          <AccessNotice
            tone="danger"
            icon="alert"
            title={t("access.setup.org.codeChanged")}
            detail={t("access.setup.org.codeChangedDetail")}
          />
        ) : null}
        <TextField
          ref={refs.token}
          label={t("access.setup.code.label")}
          hint={t("access.setup.code.hint")}
          name="setup-token"
          autoComplete="off"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          placeholder="xxxx-xxxx-xxxx-xxxx-xxxx-xxxx"
          mono
          required
          readOnly={check.isPending}
          value={values.token}
          onValueChange={edit("token")}
          error={fieldError("token")}
        />
        {confirmed ? (
          <p className="access__ok">
            <Icon name="check" />
            <span>{t("access.setup.code.ok")}</span>
          </p>
        ) : null}
        <div className="access__foot">
          <span className="access__foot-note">{t("access.setup.code.restartNote")}</span>
          <SubmitButton busy={check.isPending} waiting={waiting} left={left}>
            {check.isPending ? t("access.setup.code.checking") : t("access.next")}
          </SubmitButton>
        </div>
        <CodeWhere hint={hint} />
      </form>
    );
  } else if (step === 2) {
    title = t("access.setup.account.title");
    lead = t("access.setup.account.lead");
    card = (
      <form
        className="access__card"
        noValidate
        onSubmit={submitAccount}
        onKeyDown={preventComposingSubmit}
      >
        <TextField
          ref={refs.name}
          label={t("access.setup.account.name")}
          hint={t("access.setup.account.nameHint")}
          name="name"
          autoComplete="name"
          required
          value={values.name}
          onValueChange={edit("name")}
          error={fieldError("name")}
        />
        <TextField
          ref={refs.email}
          label={t("access.setup.account.email")}
          hint={t("access.setup.account.emailHint")}
          type="email"
          name="email"
          autoComplete="username"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={values.email}
          onValueChange={edit("email")}
          error={fieldError("email")}
        />
        <PasswordField
          ref={refs.password}
          label={t("access.setup.account.password")}
          name="new-password"
          autoComplete="new-password"
          showStrength
          showRules
          value={values.password}
          onValueChange={edit("password")}
          error={fieldError("password")}
        />
        <p className="field__hint">{t("access.setup.account.ownerNote")}</p>
        <div className="access__foot access__foot--steps">
          <button type="button" className="button button--ghost access__back" onClick={back}>
            <Icon name="back" />
            {t("access.back")}
          </button>
          <button type="submit" className="button button--primary access__next">
            {t("access.next")}
            <Icon name="arrowRight" />
          </button>
        </div>
      </form>
    );
  } else if (step === 3) {
    title = t("access.setup.org.title");
    lead = t("access.setup.org.lead");
    card = taken ? (
      <div className="access__card">
        <AccessNotice
          tone="info"
          icon="lock"
          title={t("access.setup.org.taken")}
          detail={t("access.setup.org.takenDetail")}
        />
        <div className="access__foot">
          <span className="access__foot-note" />
          <Link to="/login" className="button button--primary">
            {t("access.toLogin")}
            <Icon name="arrowRight" />
          </Link>
        </div>
      </div>
    ) : (
      <OrgForm
        values={values}
        choices={choices}
        onChoices={setChoices}
        edit={edit}
        error={fieldError("orgName")}
        orgRef={refs.orgName}
        busy={setup.isPending}
        failure={
          setup.error === null || fieldFromServer(FIELD_ORDER, setup.error) !== undefined
            ? null
            : errorCode(setup.error)
        }
        onSubmit={submitOrg}
        onBack={back}
      />
    );
  } else {
    const firstName = (done?.name ?? "").split(/\s+/)[0] ?? "";
    title = t("access.setup.done.title", { name: firstName });
    lead = t("access.setup.done.lead", { org: done?.orgs[0]?.name ?? "" });
    card = done === null ? null : <SetupDone me={done} choices={choices} />;
  }

  return (
    <AccessLayout
      context={t("access.top.setupContext")}
      width={step === 4 ? "done" : "wide"}
      helpInNewTab
    >
      <Stepper step={step} />
      <div className="access__head">
        <h1 ref={heading} tabIndex={-1}>
          {title}
        </h1>
        <p className="access__lead">{lead}</p>
      </div>
      {card}
    </AccessLayout>
  );
}

/** The primary button of a step: busy with a spinner, or counting down a rate limit's wait. */
function SubmitButton({
  busy,
  waiting,
  left,
  children,
}: {
  busy: boolean;
  waiting: boolean;
  left: number;
  children: ReactNode;
}) {
  const { t } = useI18n();
  if (waiting) {
    return (
      <button
        type="submit"
        className="button access__next access__submit--waiting"
        aria-disabled="true"
      >
        <span className="access__wait">{t("access.retryIn", { time: formatWait(left) })}</span>
      </button>
    );
  }
  return (
    <button type="submit" className="button button--primary access__next" aria-disabled={busy}>
      {busy ? <span className="access__spinner" aria-hidden="true" /> : null}
      {children}
      {busy ? null : <Icon name="arrowRight" />}
    </button>
  );
}

/**
 * The steps as an ordered list: done ones with a check, the current one with a neutral tint and
 * weight. On phones a line "Step 2 of 4" with four neutral segments takes its place.
 */
function Stepper({ step }: { step: Step }) {
  const { t } = useI18n();
  return (
    <nav className="setup-steps" aria-label={t("access.setup.steps")}>
      <ol className="setup-steps__list">
        {STEPS.flatMap((key, index) => {
          const number = index + 1;
          const state = number < step ? "done" : number === step ? "current" : "open";
          const rule =
            index === 0
              ? []
              : [<li key={`${key}-rule`} className="setup-steps__rule" aria-hidden="true" />];
          return [
            ...rule,
            <li
              key={key}
              className={`setup-steps__item setup-steps__item--${state}`}
              aria-current={state === "current" ? "step" : undefined}
            >
              <span className="setup-steps__mark" aria-hidden="true">
                {state === "done" ? <Icon name="check" /> : number}
              </span>
              {t(key)}
              {state === "done" ? (
                <span className="visually-hidden">{t("access.setup.stepDone")}</span>
              ) : null}
            </li>,
          ];
        })}
      </ol>
      <div className="setup-steps__compact" aria-hidden="true">
        <span>
          {t("access.setup.stepOf", { step, total: STEPS.length })} ·{" "}
          <b>{t(STEPS[step - 1] ?? "access.setup.step.code")}</b>
        </span>
        <span className="setup-steps__segments">
          {STEPS.map((key, index) => (
            <span
              key={key}
              className={
                index < step
                  ? "setup-steps__segment setup-steps__segment--on"
                  : "setup-steps__segment"
              }
            />
          ))}
        </span>
      </div>
    </nav>
  );
}

const THEME_PREVIEW: Record<SetupChoices["theme"], string> = {
  system: "theme-tile__preview--system",
  light: "theme-tile__preview--light",
  dark: "theme-tile__preview--dark",
  contrast: "theme-tile__preview--contrast",
};

function OrgForm({
  values,
  choices,
  onChoices,
  edit,
  error,
  orgRef,
  busy,
  failure,
  onSubmit,
  onBack,
}: {
  values: SetupValues;
  choices: SetupChoices;
  onChoices: (choices: SetupChoices) => void;
  edit: (field: SetupField) => (value: string) => void;
  error: string | undefined;
  orgRef: RefObject<HTMLInputElement | null>;
  busy: boolean;
  failure: ErrorCode | null;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onBack: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [zones] = useState(() => timeZones(choices.timeZone));
  const browserZone = zones[0];

  return (
    <form
      className="access__card"
      noValidate
      onSubmit={onSubmit}
      onKeyDown={preventComposingSubmit}
    >
      <AccessAlert>
        {failure === null ? null : (
          <AccessNotice
            tone="danger"
            icon="alert"
            title={t(`errors.${failure}`)}
            detail={t("access.setup.org.kept")}
          />
        )}
      </AccessAlert>
      <TextField
        ref={orgRef}
        label={t("access.setup.org.name")}
        hint={t("access.setup.org.nameHint")}
        name="organization"
        autoComplete="organization"
        required
        value={values.orgName}
        onValueChange={edit("orgName")}
        error={error}
      />
      <div className="setup-defaults">
        <div>
          <h2 className="access__subhead">{t("access.setup.org.defaults")}</h2>
          <p className="field__hint">{t("access.setup.org.defaultsHint")}</p>
        </div>
        <fieldset className="setup-choice">
          <legend className="field__label">{t("access.setup.org.language")}</legend>
          <div className="segmented">
            {LANGUAGES.map((option) => (
              <label key={option} className="segmented__option" lang={option}>
                <input
                  type="radio"
                  className="visually-hidden"
                  name={`${id}-language`}
                  value={option}
                  checked={choices.language === option}
                  onChange={() => onChoices({ ...choices, language: option })}
                />
                {t(`language.${option}`)}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="setup-choice">
          <legend className="field__label">{t("access.setup.org.theme")}</legend>
          <div className="theme-tiles">
            {THEMES.map((option) => (
              <label key={option} className="theme-tile">
                <input
                  type="radio"
                  className="visually-hidden"
                  name={`${id}-theme`}
                  value={option}
                  checked={choices.theme === option}
                  onChange={() => onChoices({ ...choices, theme: option })}
                />
                <span className={`theme-tile__preview ${THEME_PREVIEW[option]}`} aria-hidden="true">
                  <span className="theme-tile__side" />
                  <span className="theme-tile__main">
                    <span className="theme-tile__line" />
                    <span className="theme-tile__line theme-tile__line--short" />
                  </span>
                </span>
                <span className="theme-tile__name">
                  {t(`theme.${option}`)}
                  {choices.theme === option ? <Icon name="check" /> : null}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="field">
          <label className="field__label" htmlFor={`${id}-zone`}>
            {t("access.setup.org.timeZone")}
          </label>
          <select
            id={`${id}-zone`}
            className="select setup-choice__select"
            value={choices.timeZone}
            aria-describedby={`${id}-zone-hint`}
            onChange={(event) => onChoices({ ...choices, timeZone: event.currentTarget.value })}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone === browserZone ? t("access.setup.org.timeZoneBrowser", { zone }) : zone}
              </option>
            ))}
          </select>
          <p className="field__hint" id={`${id}-zone-hint`}>
            {t("access.setup.org.timeZoneHint")}
          </p>
        </div>
      </div>
      <div className="access__foot access__foot--steps">
        <button type="button" className="button button--ghost access__back" onClick={onBack}>
          <Icon name="back" />
          {t("access.back")}
        </button>
        <SubmitButton busy={busy} waiting={false} left={0}>
          {busy
            ? t("access.setup.org.submitting")
            : failure === null
              ? t("access.setup.org.submit")
              : t("common.retry")}
        </SubmitButton>
      </div>
    </form>
  );
}
