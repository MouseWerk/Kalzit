import { useId } from "react";
import { LANGUAGES, setLanguage, useI18n } from "../i18n/i18n";
import { setTheme, THEMES, useTheme } from "../theme/theme";

function pick<T extends string>(options: readonly T[], value: string, apply: (option: T) => void) {
  const option = options.find((candidate) => candidate === value);
  if (option !== undefined) {
    apply(option);
  }
}

/** Language and theme choice for pages without the app shell (sign in, setup). */
export function PreferenceSelects() {
  const { t, language } = useI18n();
  const theme = useTheme();
  const languageId = useId();
  const themeId = useId();

  return (
    <div className="auth__footer">
      <div className="preference">
        <label htmlFor={languageId}>{t("language.label")}</label>
        <select
          id={languageId}
          className="select"
          value={language}
          onChange={(event) => pick(LANGUAGES, event.currentTarget.value, setLanguage)}
        >
          {LANGUAGES.map((option) => (
            <option key={option} value={option} lang={option}>
              {t(`language.${option}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="preference">
        <label htmlFor={themeId}>{t("theme.label")}</label>
        <select
          id={themeId}
          className="select"
          value={theme}
          onChange={(event) => pick(THEMES, event.currentTarget.value, setTheme)}
        >
          {THEMES.map((option) => (
            <option key={option} value={option}>
              {t(`theme.${option}`)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
