import { type QueryKey, useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useId, useRef, useState } from "react";
import { isApiError } from "../../../api/client";
import { useI18n } from "../../../i18n/i18n";
import { errorText } from "../errors";
import { Dialog } from "./Dialog";
import { formatValue } from "./format";
import { Notice, useNotice } from "./Notice";
import { useRowKeys } from "./rows";

/** What the settings list needs of a setting; server settings add source and description. */
export interface EditableSetting {
  key: string;
  value: unknown;
  version: number;
}

interface Conflict {
  key: string;
  mine: unknown;
  stored: unknown;
  version: number;
}

/**
 * Settings apply as soon as a value is committed, with undo. A version conflict (someone saved
 * the setting in the meantime) shows both values and lets the user keep the stored one or
 * overwrite it on purpose.
 */
export function useSettingChanges<S extends EditableSetting>({
  queryKey,
  read,
  patch,
}: {
  queryKey: QueryKey;
  /** The settings as currently cached. */
  read: () => readonly S[] | undefined;
  patch: (key: string, value: unknown, version: number) => Promise<void>;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const notice = useNotice();
  const [conflict, setConflict] = useState<Conflict | null>(null);

  const versionOf = (key: string) => read()?.find((setting) => setting.key === key)?.version;

  const save = useMutation({
    mutationFn: (input: { key: string; value: unknown; previous: unknown; version: number }) =>
      patch(input.key, input.value, input.version),
    onSuccess: async (_, { key, value, previous }) => {
      await queryClient.invalidateQueries({ queryKey });
      notice.show({
        message: t("admin.settings.saved", { key }),
        undo: () => {
          const version = versionOf(key);
          if (version !== undefined) {
            save.mutate({ key, value: previous, previous: value, version });
          }
        },
      });
    },
    onError: async (error, { key, value }) => {
      if (!isApiError(error, "version_conflict")) {
        notice.showError(errorText(t, error));
        return;
      }
      notice.clear();
      await queryClient.refetchQueries({ queryKey });
      const stored = read()?.find((setting) => setting.key === key);
      if (stored !== undefined) {
        setConflict({ key, mine: value, stored: stored.value, version: stored.version });
      }
    },
  });

  return {
    notice,
    conflict,
    pending: save.isPending,
    apply: (setting: S, value: unknown) =>
      save.mutate({ key: setting.key, value, previous: setting.value, version: setting.version }),
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

export function SettingsList<S extends EditableSetting>({
  label,
  settings,
  changes,
  describe,
  readOnlyReason,
}: {
  label: string;
  settings: readonly S[];
  changes: ReturnType<typeof useSettingChanges<S>>;
  /** Extra text and badges under the key. */
  describe?: (setting: S) => ReactNode;
  /** Why a setting cannot be changed here, or undefined when it can. */
  readOnlyReason: (setting: S) => string | undefined;
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
          {settings.map((setting, index) => {
            const reason = readOnlyReason(setting);
            return (
              <li
                key={setting.key}
                className="admin-row admin-row--setting"
                {...keys.rowProps(index)}
              >
                <SettingField
                  // A new version from the server replaces whatever was typed into the field.
                  key={`${setting.key}:${setting.version}`}
                  setting={setting}
                  reason={reason}
                  disabled={changes.pending}
                  description={describe?.(setting)}
                  onCommit={(value) => changes.apply(setting, value)}
                />
              </li>
            );
          })}
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

function SettingField({
  setting,
  reason,
  disabled,
  description,
  onCommit,
}: {
  setting: EditableSetting;
  reason: string | undefined;
  disabled: boolean;
  description: ReactNode;
  onCommit: (value: unknown) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const descriptionId = `${id}-description`;
  const errorId = `${id}-error`;
  const { value } = setting;
  const [draft, setDraft] = useState(() =>
    typeof value === "string" ? value : formatValue(value),
  );
  const [error, setError] = useState<string | undefined>(undefined);
  const committed = useRef(false);

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
          disabled={disabled}
          aria-describedby={descriptionId}
          onChange={(event) => onCommit(event.currentTarget.checked)}
        />
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
    const parsed = parse();
    if (!parsed.ok) {
      setError(
        t(
          typeof value === "number" ? "admin.settings.invalidNumber" : "admin.settings.invalidJson",
        ),
      );
      return;
    }
    setError(undefined);
    if (JSON.stringify(parsed.value) !== JSON.stringify(value) && !committed.current) {
      // Enter and the blur that may follow must not save twice.
      committed.current = true;
      onCommit(parsed.value);
    }
  }

  const describedBy = error === undefined ? descriptionId : `${errorId} ${descriptionId}`;
  const multiline = typeof value === "object" && value !== null;
  return (
    <>
      {header}
      <div className="admin-setting__input">
        {multiline ? (
          <textarea
            id={id}
            className="input input--mono admin-setting__json"
            value={draft}
            disabled={disabled}
            aria-invalid={error === undefined ? undefined : true}
            aria-describedby={describedBy}
            onChange={(event) => {
              committed.current = false;
              setDraft(event.currentTarget.value);
            }}
            onBlur={commit}
          />
        ) : (
          <input
            id={id}
            className="input"
            type={typeof value === "number" ? "number" : "text"}
            value={draft}
            disabled={disabled}
            aria-invalid={error === undefined ? undefined : true}
            aria-describedby={describedBy}
            onChange={(event) => {
              committed.current = false;
              setDraft(event.currentTarget.value);
            }}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                commit();
              }
            }}
          />
        )}
        {error === undefined ? null : (
          <p className="field__error" id={errorId}>
            {error}
          </p>
        )}
      </div>
    </>
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
