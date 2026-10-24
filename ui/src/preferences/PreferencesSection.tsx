import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useId } from "react";
import { FormAlert } from "../components/FormAlert";
import { LANGUAGES, type Translate, useI18n } from "../i18n/i18n";
import { browserZone, timeZones } from "../lib/timeSettings";
import { showErrorToast, showToast } from "../lib/toasts";
import { useCurrentOrg } from "../org/useOrg";
import { search } from "../shell/homeApi";
import { apiErrorText } from "../shell/shellErrors";
import { THEMES } from "../theme/theme";
import {
  type Preferences,
  type PreferencesPatch,
  preferencesQuery,
  usePreferenceChange,
  WEEK_STARTS,
} from "./preferences";
import "../features/admin/admin.css";
import "../shell/shellUx.css";

const appRoute = getRouteApi("/_app");

/** Dashboards offered as start dashboard; more than this are found through search later. */
const START_CHOICES = 200;

/** What a patch changes, as the patch that takes it back. */
function undoPatch(patch: PreferencesPatch, previous: Preferences): PreferencesPatch {
  const undo: PreferencesPatch = {};
  if (patch.language !== undefined) undo.language = previous.language;
  if (patch.theme !== undefined) undo.theme = previous.theme;
  if (patch.timeZone !== undefined) undo.timeZone = previous.timeZone;
  if (patch.weekStart !== undefined) undo.weekStart = previous.weekStart;
  if (patch.startDashboard !== undefined) {
    undo.startDashboard =
      previous.startDashboard === null
        ? null
        : {
            orgId: previous.startDashboard.orgId,
            dashboardId: previous.startDashboard.dashboardId,
          };
  }
  return undo;
}

function savedText(t: Translate, patch: PreferencesPatch): string {
  if (patch.language !== undefined) return t("shell.preferences.saved.language");
  if (patch.theme !== undefined) return t("shell.preferences.saved.theme");
  if (patch.timeZone !== undefined) return t("shell.preferences.saved.timeZone");
  if (patch.weekStart !== undefined) return t("shell.preferences.saved.weekStart");
  return t("shell.preferences.saved.startDashboard");
}

/**
 * Personal preferences on the account page, stored on the server for the user. Each choice applies
 * at once and confirms itself with a notice that offers to undo it (CLAUDE.md).
 */
export function PreferencesSection() {
  const { t } = useI18n();
  const titleId = useId();
  const { me } = appRoute.useRouteContext();
  const preferences = useQuery(preferencesQuery(me.id));
  const change = usePreferenceChange(me.id, {
    onSaved: (patch, previous) => {
      showToast({
        message: savedText(t, patch),
        undo: previous === undefined ? undefined : () => change.mutate(undoPatch(patch, previous)),
      });
    },
    onFailed: (error) => showErrorToast(apiErrorText(t, error)),
  });
  return (
    <section className="admin-section admin-account__section" aria-labelledby={titleId}>
      <div className="admin-section__heading">
        <h2 id={titleId}>{t("shell.preferences.title")}</h2>
        <p className="admin-section__lead">{t("shell.preferences.lead")}</p>
      </div>
      {preferences.data === undefined ? (
        preferences.isError ? (
          <FormAlert>{apiErrorText(t, preferences.error)}</FormAlert>
        ) : (
          <p className="loading">{t("common.loading")}</p>
        )
      ) : (
        <PreferenceFields
          preferences={preferences.data}
          busy={change.isPending}
          onChange={(patch) => change.mutate(patch)}
        />
      )}
    </section>
  );
}

function PreferenceFields({
  preferences,
  busy,
  onChange,
}: {
  preferences: Preferences;
  busy: boolean;
  onChange: (patch: PreferencesPatch) => void;
}) {
  const { t } = useI18n();
  const org = useCurrentOrg();
  const dashboards = useQuery({
    queryKey: ["preferences", "dashboards", org?.id],
    queryFn: ({ signal }) =>
      search(org?.id ?? "", { q: "", kind: "dashboard", limit: START_CHOICES }, signal),
    enabled: org !== undefined,
  });
  const defaultLanguage = LANGUAGES.find((l) => l === preferences.defaults.language);
  const defaultTheme = THEMES.find((theme) => theme === preferences.defaults.theme);
  const zones = timeZones();
  const zone = preferences.timeZone;
  if (zone !== null && !zones.includes(zone)) {
    zones.unshift(zone);
  }
  const start = preferences.startDashboard;
  const startChoices = (dashboards.data?.items ?? []).map((hit) => ({
    id: hit.id,
    label: [...hit.path, hit.title].join(" / "),
  }));
  if (
    start !== null &&
    start.orgId === org?.id &&
    !startChoices.some((c) => c.id === start.dashboardId)
  ) {
    startChoices.unshift({ id: start.dashboardId, label: start.title });
  }
  startChoices.sort((a, b) => a.label.localeCompare(b.label));

  return (
    <div className="form admin-account__form preferences">
      <Choice
        label={t("shell.preferences.language")}
        value={preferences.language ?? ""}
        disabled={busy}
        options={[
          {
            value: "",
            label: t("shell.preferences.default", {
              value: defaultLanguage === undefined ? "" : t(`language.${defaultLanguage}`),
            }),
          },
          ...LANGUAGES.map((l) => ({ value: l, label: t(`language.${l}`), lang: l })),
        ]}
        onChange={(value) => onChange({ language: LANGUAGES.find((l) => l === value) ?? null })}
      />
      <Choice
        label={t("shell.preferences.theme")}
        value={preferences.theme ?? ""}
        disabled={busy}
        options={[
          {
            value: "",
            label: t("shell.preferences.default", {
              value: defaultTheme === undefined ? "" : t(`theme.${defaultTheme}`),
            }),
          },
          ...THEMES.map((theme) => ({ value: theme, label: t(`theme.${theme}`) })),
        ]}
        onChange={(value) => onChange({ theme: THEMES.find((theme) => theme === value) ?? null })}
      />
      <Choice
        label={t("shell.preferences.timeZone")}
        hint={t("shell.preferences.timeZoneHint")}
        value={zone ?? ""}
        disabled={busy}
        options={[
          { value: "", label: t("shell.preferences.timeZoneBrowser", { zone: browserZone() }) },
          ...zones.map((name) => ({ value: name, label: name.replaceAll("_", " ") })),
        ]}
        onChange={(value) => onChange({ timeZone: value === "" ? null : value })}
      />
      <Choice
        label={t("shell.preferences.startDashboard")}
        hint={t("shell.preferences.startDashboardHint")}
        value={start !== null && start.orgId === org?.id ? start.dashboardId : ""}
        disabled={busy || org === undefined}
        options={[
          { value: "", label: t("shell.preferences.startPage") },
          ...startChoices.map((choice) => ({ value: choice.id, label: choice.label })),
        ]}
        onChange={(value) =>
          onChange({
            startDashboard:
              value === "" || org === undefined ? null : { orgId: org.id, dashboardId: value },
          })
        }
      />
      <Choice
        label={t("shell.preferences.weekStart")}
        value={preferences.weekStart ?? ""}
        disabled={busy}
        options={[
          { value: "", label: t("shell.preferences.weekStartDefault") },
          ...WEEK_STARTS.map((day) => ({ value: day, label: t(`shell.preferences.week.${day}`) })),
        ]}
        onChange={(value) =>
          onChange({ weekStart: WEEK_STARTS.find((day) => day === value) ?? null })
        }
      />
    </div>
  );
}

function Choice({
  label,
  hint,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  options: { value: string; label: string; lang?: string }[];
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="select preferences__select"
        value={value}
        aria-describedby={hint === undefined ? undefined : `${id}-hint`}
        aria-disabled={disabled}
        onChange={(event) => {
          if (!disabled) {
            onChange(event.currentTarget.value);
          }
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} lang={option.lang}>
            {option.label}
          </option>
        ))}
      </select>
      {hint === undefined ? null : (
        <span className="field__hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
    </div>
  );
}
