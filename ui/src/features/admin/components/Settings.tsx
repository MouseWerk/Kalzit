import { type QueryKey, useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useId, useRef, useState } from "react";
import { isApiError } from "../../../api/client";
import { LANGUAGES, type MessageKey, useI18n } from "../../../i18n/i18n";
import { THEMES } from "../../../theme/theme";
import type { Setting } from "../api";
import { errorText, SETTING_ERRORS } from "../errors";
import { Dialog } from "./Dialog";
import { formatValue } from "./format";
import { Notice, useNotice } from "./Notice";
import { useRowKeys } from "./rows";

interface Conflict {
  key: string;
  mine: unknown;
  stored: unknown;
  version: number;
}

/** Settings whose value is one of a fixed set, offered as a select with readable names. */
const CHOICES: Record<string, readonly { value: string; label: MessageKey }[]> = {
  "appearance.default_language": LANGUAGES.map((language) => ({
    value: language,
    label: `language.${language}` as const,
  })),
  "appearance.default_theme": THEMES.map((theme) => ({
    value: theme,
    label: `theme.${theme}` as const,
  })),
};

/**
 * Settings apply as soon as a value is committed, with undo. Undo names the version the change
 * produced, so when someone else saved in between it ends in a version conflict like any other
 * change: the conflict dialog shows both values and lets the user keep the stored one or
 * overwrite it on purpose.
 */
export function useSettingChanges({
  queryKey,
  read,
  patch,
}: {
  queryKey: QueryKey;
  /** The settings as currently cached. */
  read: () => readonly Setting[] | undefined;
  patch: (key: string, value: unknown, version: number) => Promise<Setting>;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const notice = useNotice();
  const [conflict, setConflict] = useState<Conflict | null>(null);
  // A value the server rejected, shown at its setting's field.
  const [rejected, setRejected] = useState<{ key: string; message: string } | null>(null);

  const save = useMutation({
    mutationFn: (input: { key: string; value: unknown; previous: unknown; version: number }) =>
      patch(input.key, input.value, input.version),
    onSuccess: async (saved, { previous }) => {
      setRejected(null);
      await queryClient.invalidateQueries({ queryKey });
      notice.show({
        message: t("admin.settings.saved", { key: saved.key }),
        undo: () =>
          save.mutate({
            key: saved.key,
            value: previous,
            previous: saved.value,
            version: saved.version,
          }),
      });
    },
    onError: async (error, { key, value }) => {
      if (isApiError(error, "validation") && error.field === "value") {
        notice.clear();
        setRejected({ key, message: errorText(t, error, SETTING_ERRORS) });
        return;
      }
      if (!isApiError(error, "version_conflict")) {
        notice.showError(errorText(t, error, SETTING_ERRORS));
        return;
      }
      notice.clear();
      try {
        await queryClient.refetchQueries({ queryKey }, { throwOnError: true });
      } catch (refetchError) {
        // Without the stored value there is nothing to compare; say so instead.
        notice.showError(errorText(t, refetchError));
        return;
      }
      const stored = read()?.find((setting) => setting.key === key);
      if (stored !== undefined) {
        setConflict({ key, mine: value, stored: stored.value, version: stored.version });
      }
    },
  });

  return {
    notice,
    conflict,
    rejected,
    pending: save.isPending,
    apply: (setting: Setting, value: unknown) => {
      if (!save.isPending) {
        setRejected(null);
        save.mutate({ key: setting.key, value, previous: setting.value, version: setting.version });
      }
    },
    keepStored: () => setConflict(null),
    overwrite: () => {
      if (conflict !== null) {
        setConflict(null);
        save.mutate({
          key: conflict.key,
          value: conflict.mine,
          previous: conflict.stored,
          version: conflict.version,
        });
      }
    },
  };
}

export function SettingsList({
  label,
  settings,
  changes,
  describe,
  readOnlyReason,
}: {
  label: string;
  settings: readonly Setting[];
  changes: ReturnType<typeof useSettingChanges>;
  /** Extra text and badges under the key. */
  describe?: (setting: Setting) => ReactNode;
  /** Why a setting cannot be changed here, or undefined when it can. */
  readOnlyReason: (setting: Setting) => string | undefined;
}) {
  const { t } = useI18n();
  const keys = useRowKeys(settings.length);
  return (
    <>
      <Notice notice={changes.notice.notice} onDismiss={changes.notice.clear} />
      {settings.length === 0 ? (
        <p className="admin-empty">{t("admin.settings.empty")}</p>
      ) : (
        <ul className="admin-list" aria-label={label} {...keys.listProps}>
          {settings.map((setting, index) => (
            <li
              key={setting.key}
              className="admin-row admin-row--setting"
              {...keys.rowProps(index)}
            >
              <SettingField
                setting={setting}
                reason={readOnlyReason(setting)}
                pending={changes.pending}
                rejected={
                  changes.rejected?.key === setting.key ? changes.rejected.message : undefined
                }
                description={describe?.(setting)}
                onCommit={(value) => changes.apply(setting, value)}
              />
            </li>
          ))}
        </ul>
      )}
      <ConflictDialog
        conflict={changes.conflict}
        onKeepStored={changes.keepStored}
        onOverwrite={changes.overwrite}
      />
    </>
  );
}

/** The server's description (English until the UI has its own texts) and the default value. */
export function SettingDescription({ setting }: { setting: Setting }) {
  const { t } = useI18n();
  return (
    <>
      {setting.description === "" ? null : (
        <p className="admin-setting__text" lang="en">
          {setting.description}
        </p>
      )}
      <p className="admin-setting__text">
        {t("admin.settings.default", { value: formatValue(setting.default) })}
      </p>
    </>
  );
}

function draftOf(value: unknown): string {
  return typeof value === "string" ? value : formatValue(value);
}

/**
 * One setting's field. It stays mounted across saves (focus stays where it is); the draft follows
 * the stored value whenever that changes.
 */
function SettingField({
  setting,
  reason,
  pending,
  rejected,
  description,
  onCommit,
}: {
  setting: Setting;
  reason: string | undefined;
  pending: boolean;
  rejected: string | undefined;
  description: ReactNode;
  onCommit: (value: unknown) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const { value } = setting;
  const [draft, setDraft] = useState(() => draftOf(value));
  const [shown, setShown] = useState(value);
  const [invalid, setInvalid] = useState<string | undefined>(undefined);
  if (JSON.stringify(shown) !== JSON.stringify(value)) {
    setShown(value);
    setDraft(draftOf(value));
    setInvalid(undefined);
  }
  // The value last committed, so Enter and the blur that may follow do not save twice.
  const committed = useRef<string | null>(null);
  const error = invalid ?? rejected;

  const header = (
    <div className="admin-setting__header">
      <label htmlFor={id} className="admin-setting__key">
        <code>{setting.key}</code>
      </label>
      <div className="admin-setting__description" id={descriptionId}>
        {description}
        {reason === undefined ? null : <p className="admin-setting__reason">{reason}</p>}
      </div>
    </div>
  );

  if (reason !== undefined) {
    return (
      <>
        {header}
        <output id={id} className="admin-setting__value" aria-describedby={descriptionId}>
          <code>{formatValue(value)}</code>
        </output>
      </>
    );
  }

  if (typeof value === "boolean") {
    return (
      <>
        {header}
        <input
          id={id}
          type="checkbox"
          className="admin-setting__check"
          checked={value}
          aria-disabled={pending}
          aria-describedby={descriptionId}
          onChange={(event) => {
            if (!pending) {
              onCommit(event.currentTarget.checked);
            }
          }}
        />
      </>
    );
  }

  const choices = CHOICES[setting.key];
  if (choices !== undefined && typeof value === "string") {
    return (
      <>
        {header}
        <div className="admin-setting__input">
          <select
            id={id}
            className="select"
            value={value}
            aria-disabled={pending}
            aria-describedby={describedBy(error, errorId, descriptionId)}
            onChange={(event) => {
              if (!pending) {
                onCommit(event.currentTarget.value);
              }
            }}
          >
            {choices.some((choice) => choice.value === value) ? null : (
              <option value={value}>{value}</option>
            )}
            {choices.map((choice) => (
              <option key={choice.value} value={choice.value}>
                {t(choice.label)}
              </option>
            ))}
          </select>
          <FieldError id={errorId} error={error} />
        </div>
      </>
    );
  }

  function parse(): { ok: true; value: unknown } | { ok: false } {
    if (typeof value === "string") {
      return { ok: true, value: draft };
    }
    if (typeof value === "number") {
      const number = Number(draft);
      return draft.trim() !== "" && Number.isFinite(number)
        ? { ok: true, value: number }
        : { ok: false };
    }
    try {
      return { ok: true, value: JSON.parse(draft) as unknown };
    } catch {
      return { ok: false };
    }
  }

  function commit() {
    if (pending) {
      return;
    }
    const parsed = parse();
    if (!parsed.ok) {
      setInvalid(
        t(
          typeof value === "number" ? "admin.settings.invalidNumber" : "admin.settings.invalidJson",
        ),
      );
      return;
    }
    setInvalid(undefined);
    const text = JSON.stringify(parsed.value);
    if (text !== JSON.stringify(value) && committed.current !== text) {
      committed.current = text;
      onCommit(parsed.value);
    }
  }

  function edit(next: string) {
    committed.current = null;
    setDraft(next);
  }

  const multiline = typeof value === "object" && value !== null;
  const common = {
    id,
    value: draft,
    readOnly: pending,
    "aria-disabled": pending,
    "aria-invalid": error === undefined ? undefined : true,
    "aria-describedby": describedBy(error, errorId, descriptionId),
    onBlur: commit,
  } as const;
  return (
    <>
      {header}
      <div className="admin-setting__input">
        {multiline ? (
          <textarea
            {...common}
            className="input input--mono admin-setting__json"
            onChange={(event) => edit(event.currentTarget.value)}
          />
        ) : (
          <input
            {...common}
            className="input"
            type={typeof value === "number" ? "number" : "text"}
            onChange={(event) => edit(event.currentTarget.value)}
            onKeyDown={(event) => {
              // Enter also confirms an input method's candidate; that must not save.
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                commit();
              }
            }}
          />
        )}
        <FieldError id={errorId} error={error} />
      </div>
    </>
  );
}

function describedBy(error: string | undefined, errorId: string, descriptionId: string) {
  return error === undefined ? descriptionId : `${errorId} ${descriptionId}`;
}

function FieldError({ id, error }: { id: string; error: string | undefined }) {
  return error === undefined ? null : (
    <p className="field__error" id={id}>
      {error}
    </p>
  );
}

function ConflictDialog({
  conflict,
  onKeepStored,
  onOverwrite,
}: {
  conflict: Conflict | null;
  onKeepStored: () => void;
  onOverwrite: () => void;
}) {
  const { t } = useI18n();
  const keepRef = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={conflict !== null}
      title={t("admin.conflict.title")}
      onClose={onKeepStored}
      initialFocus={keepRef}
      footer={
        <>
          <button
            ref={keepRef}
            type="button"
            className="button button--secondary"
            onClick={onKeepStored}
          >
            {t("admin.conflict.keepStored")}
          </button>
          <button type="button" className="button button--primary" onClick={onOverwrite}>
            {t("admin.conflict.overwrite")}
          </button>
        </>
      }
    >
      <p>{t("admin.conflict.text", { key: conflict?.key ?? "" })}</p>
      <dl className="admin-conflict">
        <dt>{t("admin.conflict.stored")}</dt>
        <dd>
          <code>{formatValue(conflict?.stored)}</code>
        </dd>
        <dt>{t("admin.conflict.mine")}</dt>
        <dd>
          <code>{formatValue(conflict?.mine)}</code>
        </dd>
      </dl>
    </Dialog>
  );
}
