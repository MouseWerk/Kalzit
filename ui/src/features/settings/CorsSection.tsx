import { useId, useState } from "react";
import { Icon } from "../../components/Icon";
import { Select } from "../../components/Select";
import { useI18n } from "../../i18n/i18n";
import type { Setting } from "../admin/api";
import { settingText } from "../admin/catalog";
import { LoadState } from "../admin/components/Section";
import {
  CORS_METHODS,
  type CorsAnswer,
  type CorsSettings,
  checkOrigin,
  originProblem,
  validHeaderName,
} from "./corsCheck";
import { type Changes, LockedControl, lockedBadge, lockHint, RowFrame } from "./rows";
import { useFoundRow } from "./SectionPage";
import { EntriesRow, PlainRow, RowsConflict, useServerRows } from "./serverRows";

/** A header name as an example in the field; a name of the protocol, the same in every language. */
const HEADER_EXAMPLE = "X-Request-Id";

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? (value as unknown[]).map(String) : [];

/**
 * Verwaltung > CORS (board Settings075.dc.html, frames 1 and 2): which other web pages may call
 * the API from a browser. Off by default; every change applies at once, with undo. An entry the
 * server would refuse is not sent and says why under its field; values from kalzit.toml or the
 * environment are locked and name their source. On the side, an origin is checked against the
 * settings as they are, without a request leaving the page.
 */
export function CorsSection() {
  const { t } = useI18n();
  const { settings, changes, byKey } = useServerRows();
  if (settings.data === undefined) {
    return <LoadState error={settings.error} onRetry={() => void settings.refetch()} />;
  }
  const origins = strings(byKey.get("cors.allowed_origins")?.value);
  const credentials = byKey.get("cors.allow_credentials")?.value === true;
  const current: CorsSettings = {
    enabled: byKey.get("cors.enabled")?.value === true,
    origins,
    methods: strings(byKey.get("cors.allowed_methods")?.value),
    headers: strings(byKey.get("cors.allowed_headers")?.value),
    credentials,
    maxAgeSecs: Number(byKey.get("cors.max_age_secs")?.value ?? 0),
  };
  const originCheck = (entry: string): string | null => {
    const problem = originProblem(entry);
    if (problem === null) return null;
    return problem.reason === "path" || problem.reason === "http"
      ? t(`settings.cors.${problem.reason}`, { origin: problem.origin })
      : t(`settings.cors.${problem.reason}`);
  };
  return (
    <div className="s75-wrap">
      <div className="s75-split">
        <div className="settings-card">
          <PlainRow setting={byKey.get("cors.enabled")} changes={changes} />
          <EntriesRow
            setting={byKey.get("cors.allowed_origins")}
            changes={changes}
            placeholder="https://"
            check={originCheck}
          />
          <MethodsRow setting={byKey.get("cors.allowed_methods")} changes={changes} />
          <EntriesRow
            setting={byKey.get("cors.allowed_headers")}
            changes={changes}
            placeholder={HEADER_EXAMPLE}
            check={(entry) => (validHeaderName(entry) ? null : t("settings.cors.header"))}
          />
          <PlainRow
            setting={byKey.get("cors.allow_credentials")}
            changes={changes}
            note={
              credentials && origins.some((origin) => origin.includes("*"))
                ? t("settings.cors.starOff")
                : undefined
            }
          />
          <PlainRow setting={byKey.get("cors.max_age_secs")} changes={changes} />
          <RowsConflict changes={changes} />
        </div>
        <OriginCheck settings={current} />
      </div>
    </div>
  );
}

/** The methods as boxes: only the six the server knows can be chosen. */
function MethodsRow({ setting, changes }: { setting: Setting | undefined; changes: Changes }) {
  const { t } = useI18n();
  const titleId = useId();
  const found = useFoundRow();
  if (setting === undefined) {
    return null;
  }
  const chosen = strings(setting.value).map((method) => method.toUpperCase());
  const text = settingText(t, setting);
  const lock = lockHint(t, setting);
  const error = changes.rejected?.key === setting.key ? changes.rejected.message : undefined;
  const boxes = (
    <fieldset className="settings-checks" aria-labelledby={titleId}>
      {CORS_METHODS.map((method) => (
        <label key={method} className="settings-check">
          <input
            type="checkbox"
            checked={chosen.includes(method)}
            onChange={(event) =>
              changes.apply(
                setting,
                CORS_METHODS.filter((name) =>
                  name === method ? event.currentTarget.checked : chosen.includes(name),
                ),
              )
            }
          />
          {method}
        </label>
      ))}
    </fieldset>
  );
  return (
    <RowFrame
      id={setting.key}
      title={text.label ?? setting.key}
      titleId={titleId}
      description={text.description}
      badge={lockedBadge(t, setting, true)}
      lock={lock}
      error={error}
      errorId={`${titleId}-error`}
      found={found === setting.key}
    >
      {lock === undefined ? boxes : <LockedControl>{boxes}</LockedControl>}
    </RowFrame>
  );
}

function OriginCheck({ settings }: { settings: CorsSettings }) {
  const { t } = useI18n();
  const id = useId();
  const [origin, setOrigin] = useState("");
  const [method, setMethod] = useState("GET");
  const [asked, setAsked] = useState<{ origin: string; method: string } | null>(null);
  // The answer follows the settings: a change on the left shows here without asking again.
  const answer: CorsAnswer | null =
    asked === null ? null : checkOrigin(settings, asked.origin, asked.method);
  return (
    <form
      className="s75-side"
      aria-labelledby={`${id}-title`}
      onSubmit={(event) => {
        event.preventDefault();
        if (origin.trim() !== "") setAsked({ origin: origin.trim(), method });
      }}
    >
      <h3 id={`${id}-title`}>{t("settings.cors.check")}</h3>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-origin`}>
          {t("settings.cors.origin")}
        </label>
        <input
          id={`${id}-origin`}
          className="input input--mono"
          value={origin}
          placeholder="https://app.example.com"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setOrigin(event.currentTarget.value)}
        />
      </div>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-method`}>
          {t("settings.cors.method")}
        </label>
        <Select id={`${id}-method`} value={method} onChange={setMethod}>
          {CORS_METHODS.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <button type="submit" className="button button--secondary" disabled={origin.trim() === ""}>
          {t("admin.updates.step.verify")}
        </button>
      </div>
      <div role="status" aria-live="polite">
        {answer === null ? null : answer.allowed ? (
          <div className="s75-answer s75-answer--ok">
            <p>
              <Icon name="check" />
              <span>{t("settings.cors.allowed", { entry: answer.entry })}</span>
            </p>
            <pre className="s75-code">
              {answer.headers.map(([name, value]) => `${name}: ${value}`).join("\n")}
            </pre>
          </div>
        ) : (
          <div className="s75-answer">
            <p>
              <Icon name="alert" />
              <span>
                {t(`settings.cors.refused.${answer.reason}`, { method: asked?.method ?? "" })}
              </span>
            </p>
          </div>
        )}
      </div>
      <p className="s75-muted">{t("settings.cors.note")}</p>
    </form>
  );
}
