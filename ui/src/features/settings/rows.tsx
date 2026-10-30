import { type ReactNode, useId, useRef, useState } from "react";
import {
  ACCENTS,
  checkAccent,
  DENSITIES,
  FONT_SIZES,
  START_PAGES,
} from "../../appearance/contrast";
import { Icon } from "../../components/Icon";
import { LANGUAGES, type MessageKey, type Translate, useI18n } from "../../i18n/i18n";
import { WEEK_STARTS } from "../../lib/timeSettings";
import { THEMES } from "../../theme/theme";
import type { Setting } from "../admin/api";
import { settingText } from "../admin/catalog";
import { Dialog } from "../admin/components/Dialog";
import { formatValue } from "../admin/components/format";
import type { useSettingChanges } from "../admin/components/Settings";
import { rangeLabel, TimeRangePicker } from "../dashboards/TimeRangePicker";
import type { TextRange } from "../dashboards/timeRange";
import "./settings.css";

/**
 * One row of a settings card: title, one-line description and a source badge on the left, the
 * control on the right. Every control applies its value as soon as it is committed (a choice
 * made, a field left or Enter), with an undo notice; values from kalzit.toml, the environment or
 * a missing permission show read-only with the reason as a badge.
 */

export type Changes = ReturnType<typeof useSettingChanges>;

export interface Choice {
  value: string | number;
  label: string;
}

const INHERIT = "inherit";

/** Settings chosen from a fixed list, with readable names. */
function choicesOf(t: Translate, key: string): Choice[] | undefined {
  switch (key) {
    case "appearance.default_language":
      return LANGUAGES.map((value) => ({ value, label: t(`language.${value}`) }));
    case "appearance.density":
      return DENSITIES.map((value) => ({ value, label: t(`settings.density.${value}`) }));
    case "appearance.font_size":
      return FONT_SIZES.map((value) => ({ value, label: t("settings.fontSize", { size: value }) }));
    case "appearance.start_page":
      return START_PAGES.map((value) => ({ value, label: t(`settings.startPage.${value}`) }));
    case "appearance.week_start":
      return WEEK_STARTS.map((value) => ({ value, label: t(`settings.weekStart.${value}`) }));
    case "updates.channel":
      return [
        { value: "stable", label: t("admin.updates.channel.stable") },
        { value: "preview", label: t("admin.updates.channel.preview") },
      ];
    // The organization's own setting; it may only be stricter than the server's.
    case "signin.local_password":
      return [
        { value: INHERIT, label: t("settings.inherit") },
        { value: "off", label: t("settings.off") },
      ];
    case "log.format":
      return [
        { value: "text", label: "Text" },
        { value: "json", label: "JSON" },
      ];
    case "security.two_factor_required":
      return [
        { value: "off", label: t("security.policy.off") },
        { value: "admins", label: t("security.policy.admins") },
        { value: "everyone", label: t("security.policy.everyone") },
      ];
    case "security.two_factor_methods":
      return [
        { value: "all", label: t("security.policy.methodsAll") },
        { value: "passkey", label: t("security.policy.methodsPasskey") },
        { value: "totp", label: t("security.policy.methodsTotp") },
      ];
    default:
      return undefined;
  }
}

let zoneList: string[] | undefined;
function timeZones(): string[] {
  if (zoneList === undefined) {
    try {
      zoneList = Intl.supportedValuesOf("timeZone");
    } catch {
      zoneList = ["UTC"];
    }
  }
  return zoneList;
}

function isTextRange(value: unknown): value is TextRange {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { from?: unknown }).from === "string" &&
    typeof (value as { to?: unknown }).to === "string"
  );
}

/** A value as the read-only row shows it. */
export function shownValue(
  t: Translate,
  key: string,
  value: unknown,
  extra: { language: string; timeZone: string | null },
): string {
  if (value === INHERIT) {
    return t("settings.inherit");
  }
  if (value === null || value === "") {
    return t("settings.notSet");
  }
  if (typeof value === "boolean") {
    return t(value ? "settings.on" : "settings.off");
  }
  if (key === "appearance.default_theme" && typeof value === "string") {
    return THEMES.some((theme) => theme === value)
      ? t(`theme.${value as (typeof THEMES)[number]}`)
      : value;
  }
  if (key === "appearance.accent" && typeof value === "string") {
    return (ACCENTS as readonly string[]).includes(value)
      ? t(`settings.accent.${value as (typeof ACCENTS)[number]}`)
      : value;
  }
  if (key === "appearance.time_zone" && value === "browser") {
    return t("settings.browserZone");
  }
  const choice = choicesOf(t, key)?.find((c) => c.value === value);
  if (choice !== undefined) {
    return choice.label;
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? t("settings.notSet") : value.join(", ");
  }
  if (isTextRange(value)) {
    return rangeLabel(t, extra.language as "de" | "en", value, extra.timeZone);
  }
  return typeof value === "string" ? value : formatValue(value);
}

/** Why the row is read-only, as its badge; undefined when it can be changed. */
export function lockedBadge(t: Translate, setting: Setting, canWrite: boolean): string | undefined {
  if (setting.source === "file") {
    return t("settings.locked.file");
  }
  if (setting.source === "env") {
    return t("settings.locked.env");
  }
  if (!setting.editable) {
    return t("settings.locked.config");
  }
  return canWrite ? undefined : t("settings.locked.noWrite");
}

export function RowFrame({
  id,
  title,
  titleId,
  description,
  note,
  badge,
  error,
  errorId,
  children,
  found,
}: {
  id: string;
  title: ReactNode;
  titleId: string;
  description: ReactNode;
  /** A line below the description that is not part of the setting, e.g. who it does not reach. */
  note?: ReactNode;
  badge?: string | undefined;
  error?: string | undefined;
  errorId?: string;
  children: ReactNode;
  found: boolean;
}) {
  return (
    <div
      id={id}
      className={found ? "settings-row settings-row--found" : "settings-row"}
      tabIndex={-1}
    >
      <div className="settings-row__text">
        <h3 className="settings-row__title" id={titleId}>
          {title}
        </h3>
        {description === null || description === "" ? null : (
          <p className="settings-row__description" id={`${titleId}-description`}>
            {description}
          </p>
        )}
        {note === undefined ? null : <p className="settings-row__note">{note}</p>}
        {badge === undefined ? null : <span className="settings-badge">{badge}</span>}
        {error === undefined ? null : (
          <p className="field__error" id={errorId}>
            {error}
          </p>
        )}
      </div>
      <div className="settings-row__control">{children}</div>
    </div>
  );
}

export function SettingRow({
  setting,
  rowId,
  changes,
  canWrite,
  inheritable,
  found,
  description,
  note,
  choices,
}: {
  setting: Setting;
  rowId: string;
  changes: Changes;
  canWrite: boolean;
  /** An organization's override: offers "Like the server". */
  inheritable: boolean;
  found: boolean;
  /** Overrides the catalog's description. */
  description?: string;
  note?: ReactNode;
  /** Choices the page knows, for a setting chosen from data (a provider). */
  choices?: Choice[] | undefined;
}) {
  const { t, language, timeZone } = useI18n();
  const titleId = useId();
  const errorId = `${titleId}-error`;
  const text = settingText(t, setting);
  const badge = lockedBadge(t, setting, canWrite);
  const error = changes.rejected?.key === setting.key ? changes.rejected.message : undefined;
  const commit = (value: unknown) => changes.apply(setting, value);
  const labelled = {
    "aria-labelledby": titleId,
    "aria-describedby":
      error === undefined ? `${titleId}-description` : `${errorId} ${titleId}-description`,
  };

  let control: ReactNode;
  if (badge !== undefined) {
    const shown = shownValue(t, setting.key, setting.value, { language, timeZone });
    // Addresses, paths and numbers in the code font; words ("not set", "On") in the text font.
    const raw =
      shown === String(setting.value) || (Array.isArray(setting.value) && setting.value.length > 0);
    control = (
      <output
        className={raw ? "settings-value settings-value--code" : "settings-value"}
        aria-labelledby={titleId}
      >
        {shown}
      </output>
    );
  } else {
    control = (
      <Control
        setting={setting}
        inheritable={inheritable}
        pending={changes.pending}
        labelled={labelled}
        invalid={error !== undefined}
        onCommit={commit}
        choices={choices}
      />
    );
  }
  return (
    <RowFrame
      id={rowId}
      title={text.label ?? <code translate="no">{setting.key}</code>}
      titleId={titleId}
      description={description ?? text.description}
      note={note}
      badge={badge}
      error={error}
      errorId={errorId}
      found={found}
    >
      {control}
    </RowFrame>
  );
}

interface ControlProps {
  setting: Setting;
  inheritable: boolean;
  pending: boolean;
  labelled: { "aria-labelledby": string; "aria-describedby": string };
  invalid: boolean;
  onCommit: (value: unknown) => void;
  /** Choices the page knows (the providers for a function), in place of a fixed list. */
  choices?: Choice[] | undefined;
}

function Control(props: ControlProps) {
  const { t } = useI18n();
  const { setting, inheritable, pending, labelled, onCommit } = props;
  const { key, value } = setting;
  // A change while another save is on its way is queued (useSettingChanges), not dropped.
  const guard = (next: unknown) => onCommit(next);

  if (key === "appearance.default_theme") {
    return (
      <Segmented
        labelled={labelled}
        value={String(value)}
        options={(["light", "dark", "system", "contrast"] as const).map((theme) => ({
          value: theme,
          label: t(`theme.${theme}`),
        }))}
        onChange={guard}
      />
    );
  }
  // The second factor's rules, as the board shows them: a few words side by side. An
  // organization cannot turn the server's rule off, only follow it or be stricter.
  if (key === "security.two_factor_required" || key === "security.two_factor_methods") {
    const options = (choicesOf(t, key) ?? [])
      .filter((choice) => !(inheritable && choice.value === "off"))
      .map((choice) => ({ value: String(choice.value), label: choice.label }));
    return (
      <Segmented
        labelled={labelled}
        value={String(value)}
        options={
          inheritable
            ? [{ value: INHERIT, label: t("security.policy.inherit") }, ...options]
            : options
        }
        onChange={guard}
      />
    );
  }
  if (key === "appearance.accent") {
    return (
      <AccentPicker
        value={String(value)}
        inheritable={inheritable}
        labelled={labelled}
        onChange={guard}
      />
    );
  }
  if (key === "appearance.time_zone") {
    const zones = timeZones();
    const current = String(value);
    return (
      <select
        className="select settings-select"
        value={current}
        aria-disabled={pending}
        {...labelled}
        onChange={(event) => guard(event.currentTarget.value)}
      >
        {inheritable ? <option value={INHERIT}>{t("settings.inherit")}</option> : null}
        <option value="browser">{t("settings.browserZone")}</option>
        {current !== INHERIT && current !== "browser" && !zones.includes(current) ? (
          <option value={current}>{current}</option>
        ) : null}
        {zones.map((zone) => (
          <option key={zone} value={zone}>
            {zone}
          </option>
        ))}
      </select>
    );
  }
  const choices = props.choices ?? choicesOf(t, key);
  if (choices !== undefined) {
    const numeric = typeof choices[0]?.value === "number";
    return (
      <select
        className="select settings-select"
        value={String(value)}
        aria-disabled={pending}
        {...labelled}
        onChange={(event) => {
          const raw = event.currentTarget.value;
          guard(raw === INHERIT || !numeric ? raw : Number(raw));
        }}
      >
        {inheritable ? <option value={INHERIT}>{t("settings.inherit")}</option> : null}
        {choices.map((choice) => (
          <option key={choice.value} value={String(choice.value)}>
            {choice.label}
          </option>
        ))}
      </select>
    );
  }
  if (isTextRange(value)) {
    return (
      <TimeRangePicker
        value={value}
        name={settingText(t, setting).label ?? key}
        onChange={(range) => guard({ from: range.from, to: range.to })}
      />
    );
  }
  if (typeof value === "boolean") {
    return (
      <input
        type="checkbox"
        role="switch"
        className="settings-switch"
        checked={value}
        aria-checked={value}
        aria-disabled={pending}
        {...labelled}
        onChange={(event) => guard(event.currentTarget.checked)}
      />
    );
  }
  if (Array.isArray(value)) {
    return <ListField {...props} />;
  }
  return <TextField {...props} />;
}

function TextField({ setting, pending, labelled, invalid, onCommit }: ControlProps) {
  const { t } = useI18n();
  const numeric = typeof setting.value === "number";
  const [draft, setDraft] = useState(String(setting.value ?? ""));
  const [shown, setShown] = useState(setting.value);
  const [local, setLocal] = useState<string | undefined>(undefined);
  if (shown !== setting.value) {
    setShown(setting.value);
    setDraft(String(setting.value ?? ""));
    setLocal(undefined);
  }
  const committed = useRef<string | null>(null);
  function commit() {
    let next: unknown = draft;
    if (numeric) {
      const number = Number(draft);
      if (draft.trim() === "" || !Number.isFinite(number)) {
        setLocal(t("admin.settings.invalidNumber"));
        return;
      }
      next = number;
    }
    setLocal(undefined);
    const textValue = JSON.stringify(next);
    if (textValue !== JSON.stringify(setting.value) && committed.current !== textValue) {
      committed.current = textValue;
      onCommit(next);
    }
  }
  return (
    <span className="settings-field">
      <input
        className={numeric ? "input settings-input settings-input--number" : "input settings-input"}
        type={numeric ? "number" : "text"}
        value={draft}
        readOnly={pending}
        aria-invalid={invalid || local !== undefined ? true : undefined}
        {...labelled}
        onChange={(event) => {
          committed.current = null;
          setDraft(event.currentTarget.value);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            commit();
          }
        }}
      />
      {local === undefined ? null : <span className="field__error">{local}</span>}
    </span>
  );
}

/** A list of texts (folders, hosts), one per line. */
function ListField({ setting, pending, labelled, invalid, onCommit }: ControlProps) {
  const { t } = useI18n();
  const items = Array.isArray(setting.value) ? (setting.value as unknown[]).map(String) : [];
  const [draft, setDraft] = useState(items.join("\n"));
  const [shown, setShown] = useState(setting.value);
  if (shown !== setting.value) {
    setShown(setting.value);
    setDraft(items.join("\n"));
  }
  function commit() {
    const next = draft
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (JSON.stringify(next) !== JSON.stringify(items)) {
      onCommit(next);
    }
  }
  return (
    <span className="settings-field">
      <textarea
        className="input input--mono settings-list"
        value={draft}
        readOnly={pending}
        rows={Math.min(6, Math.max(2, items.length + 1))}
        aria-invalid={invalid ? true : undefined}
        {...labelled}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={commit}
      />
      <span className="settings-hint">{t("settings.listHint")}</span>
    </span>
  );
}

export function Segmented({
  labelled,
  value,
  options,
  onChange,
}: {
  labelled: { "aria-labelledby": string };
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const index = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  function move(to: number) {
    const next = (to + options.length) % options.length;
    refs.current[next]?.focus();
    const option = options[next];
    if (option !== undefined) {
      onChange(option.value);
    }
  }
  return (
    <div
      className="settings-segmented"
      role="radiogroup"
      aria-labelledby={labelled["aria-labelledby"]}
    >
      {options.map((option, i) => (
        // biome-ignore lint/a11y/useSemanticElements: radio buttons as buttons, so a choice applies at once
        <button
          key={option.value}
          ref={(element) => {
            refs.current[i] = element;
          }}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={i === index ? 0 : -1}
          className="settings-segmented__option"
          onClick={() => {
            if (option.value !== value) {
              onChange(option.value);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowRight" || event.key === "ArrowDown") {
              event.preventDefault();
              move(i + 1);
            } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
              event.preventDefault();
              move(i - 1);
            }
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function formatRatio(language: string, ratio: number): string {
  return new Intl.NumberFormat(language, {
    maximumFractionDigits: 1,
    minimumFractionDigits: 1,
  }).format(Math.floor(ratio * 10) / 10);
}

export function contrastText(t: Translate, language: string, hex: string, key: MessageKey): string {
  const check = checkAccent(hex);
  if (check === null) {
    return "";
  }
  return t(key, {
    dark: formatRatio(language, check.onDark),
    light: formatRatio(language, check.onLight),
    label: formatRatio(language, check.label),
  });
}

/** Swatches of the vetted accents, "Like the server" for organizations, and a custom color. */
function AccentPicker({
  value,
  inheritable,
  labelled,
  onChange,
}: {
  value: string;
  inheritable: boolean;
  labelled: { "aria-labelledby": string };
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const [customOpen, setCustomOpen] = useState(false);
  const custom = value !== INHERIT && !(ACCENTS as readonly string[]).includes(value);
  const swatches: { value: string; label: string }[] = [
    ...(inheritable ? [{ value: INHERIT, label: t("settings.accent.inheritSwatch") }] : []),
    ...ACCENTS.map((accent) => ({ value: accent, label: t(`settings.accent.${accent}`) })),
  ];
  return (
    <div className="settings-accent">
      <div
        className="settings-swatches"
        role="radiogroup"
        aria-labelledby={labelled["aria-labelledby"]}
      >
        {swatches.map((swatch) => {
          const checked = swatch.value === value;
          return (
            // biome-ignore lint/a11y/useSemanticElements: radio buttons as buttons, so a choice applies at once
            <button
              key={swatch.value}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={swatch.label}
              title={swatch.label}
              className={
                swatch.value === INHERIT
                  ? "settings-swatch settings-swatch--inherit"
                  : "settings-swatch"
              }
              data-accent={swatch.value === INHERIT ? undefined : swatch.value}
              onClick={() => {
                if (!checked) {
                  onChange(swatch.value);
                }
              }}
            >
              {checked ? <Icon name="check" /> : null}
            </button>
          );
        })}
        {/* biome-ignore lint/a11y/useSemanticElements: one of the radio buttons; it opens the color dialog */}
        <button
          type="button"
          role="radio"
          aria-checked={custom}
          className="button button--secondary settings-custom-color"
          onClick={() => setCustomOpen(true)}
        >
          {custom ? (
            <span
              className="settings-custom-color__chip"
              data-accent="custom"
              ref={(element) => element?.style.setProperty("--accent-custom", value)}
            />
          ) : null}
          {custom ? value : t("settings.accent.custom")}
        </button>
      </div>
      {customOpen ? (
        <CustomAccentDialog
          initial={custom ? value : "#2563eb"}
          onClose={() => setCustomOpen(false)}
          onApply={(hex) => {
            setCustomOpen(false);
            onChange(hex);
          }}
        />
      ) : null}
    </div>
  );
}

function CustomAccentDialog({
  initial,
  onClose,
  onApply,
}: {
  initial: string;
  onClose: () => void;
  onApply: (hex: string) => void;
}) {
  const { t, language } = useI18n();
  const id = useId();
  const [hex, setHex] = useState(initial);
  const normalized = /^#?[0-9a-fA-F]{6}$/.test(hex.trim())
    ? `#${hex.trim().replace(/^#/, "").toLowerCase()}`
    : null;
  const check = normalized === null ? null : checkAccent(normalized);
  const problem =
    normalized === null
      ? t("settings.accent.invalidHex")
      : check?.passes === false
        ? t("settings.accent.tooLow")
        : undefined;
  return (
    <Dialog
      open
      title={t("settings.accent.customTitle")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("settings.transfer.cancel")}
          </button>
          <button
            type="button"
            className="button button--primary"
            aria-disabled={problem !== undefined}
            onClick={() => {
              if (problem === undefined && normalized !== null) {
                onApply(normalized);
              }
            }}
          >
            {t("settings.accent.apply")}
          </button>
        </>
      }
    >
      <p>{t("settings.accent.customLead")}</p>
      <div className="settings-custom">
        <label className="field">
          <span className="field__label">{t("settings.accent.picker")}</span>
          <input
            type="color"
            className="settings-color-input"
            value={normalized ?? "#000000"}
            onChange={(event) => setHex(event.currentTarget.value)}
          />
        </label>
        <label className="field" htmlFor={`${id}-hex`}>
          <span className="field__label">{t("settings.accent.hex")}</span>
          <input
            id={`${id}-hex`}
            className="input input--mono"
            value={hex}
            spellCheck={false}
            aria-invalid={problem === undefined ? undefined : true}
            aria-describedby={`${id}-contrast`}
            onChange={(event) => setHex(event.currentTarget.value)}
          />
        </label>
      </div>
      <p id={`${id}-contrast`} className="settings-hint" role="status">
        {normalized === null
          ? ""
          : contrastText(t, language, normalized, "settings.accent.contrast")}
        {problem === undefined ? null : <span className="field__error"> {problem}</span>}
      </p>
    </Dialog>
  );
}
