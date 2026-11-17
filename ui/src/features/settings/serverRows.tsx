import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useId, useState } from "react";
import { IconButton } from "../../components/IconButton";
import { useI18n } from "../../i18n/i18n";
import { isComposingKey } from "../../lib/ime";
import { adminKeys, listServerSettings, type Setting, updateServerSetting } from "../admin/api";
import { settingText } from "../admin/catalog";
import { ConflictDialog, useSettingChanges } from "../admin/components/Settings";
import { resetSetting } from "./api";
import { type Changes, LockedControl, lockedBadge, lockHint, RowFrame, SettingRow } from "./rows";
import { useFoundRow } from "./SectionPage";
import "./settings.css";
import "./settings075.css";

/**
 * The server's settings with their changes, for a section that draws some rows itself: every
 * change applies at once with undo, a value from kalzit.toml or the environment is locked, and a
 * refusal shows at its row (the same as the plain sections of `SectionPage`).
 */
export function useServerRows() {
  const queryKey = adminKeys.serverSettings;
  const settings = useQuery({ queryKey, queryFn: listServerSettings });
  const changes = useSettingChanges({
    queryKey,
    patch: (key, value, version) => updateServerSetting(key, value, version),
    reset: (key, version) => resetSetting({ kind: "server" }, key, version),
  });
  const byKey = new Map((settings.data ?? []).map((setting) => [setting.key, setting]));
  return { settings, changes, byKey, queryClient: useQueryClient() };
}

/** A plain row of a setting, as the plain sections draw it. */
export function PlainRow({
  setting,
  changes,
  note,
}: {
  setting: Setting | undefined;
  changes: Changes;
  note?: ReactNode;
}) {
  const found = useFoundRow();
  if (setting === undefined) {
    return null;
  }
  return (
    <SettingRow
      setting={setting}
      rowId={setting.key}
      changes={changes}
      canWrite
      inheritable={false}
      found={found === setting.key}
      note={note}
    />
  );
}

/** The conflict dialog of a section's changes, once per section. */
export function RowsConflict({ changes }: { changes: Changes }) {
  return (
    <ConflictDialog
      conflict={changes.conflict}
      onKeepStored={changes.keepStored}
      onOverwrite={changes.overwrite}
    />
  );
}

/**
 * A setting that is a list of short texts (origins, header names, domains): the entries, each
 * with a button to take it out, and one field to add another. An entry the page knows the server
 * would refuse is not sent; the reason stands under the field.
 */
export function EntriesRow({
  setting,
  changes,
  placeholder,
  check,
  normalize = (text) => text,
  note,
}: {
  setting: Setting | undefined;
  changes: Changes;
  placeholder: string;
  /** Why the entry cannot be added; null when it can. */
  check: (entry: string) => string | null;
  /** The entry as it is stored (a domain in lower case). */
  normalize?: (entry: string) => string;
  note?: ReactNode;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const found = useFoundRow();
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  if (setting === undefined) {
    return null;
  }
  const items = Array.isArray(setting.value) ? (setting.value as unknown[]).map(String) : [];
  const text = settingText(t, setting);
  const lock = lockHint(t, setting);
  const badge = lockedBadge(t, setting, true);
  const rejected = changes.rejected?.key === setting.key ? changes.rejected.message : undefined;
  const error = problem ?? rejected;
  const errorId = `${titleId}-error`;
  function add() {
    const entry = normalize(draft.trim());
    if (entry === "" || setting === undefined) {
      return;
    }
    const refused = check(entry);
    setProblem(refused);
    if (refused !== null) {
      return;
    }
    if (!items.includes(entry)) {
      changes.apply(setting, [...items, entry]);
    }
    setDraft("");
  }
  const body = (
    <span className="s75-entries">
      {items.length === 0 ? null : (
        <ul className="s75-entries__list" aria-labelledby={titleId}>
          {items.map((item) => (
            <li key={item} className="s75-entry">
              <span className="s75-entry__text">{item}</span>
              {lock !== undefined ? null : (
                <IconButton
                  icon="close"
                  label={t("ai.chat.removeSource", { name: item })}
                  disabled={changes.pending}
                  onClick={() =>
                    changes.apply(
                      setting,
                      items.filter((other) => other !== item),
                    )
                  }
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <span className="s75-entries__add">
        <input
          className="input input--mono"
          value={draft}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          aria-labelledby={titleId}
          aria-describedby={error === undefined ? undefined : errorId}
          aria-invalid={error === undefined ? undefined : true}
          onChange={(event) => {
            setDraft(event.currentTarget.value);
            setProblem(null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !isComposingKey(event)) {
              event.preventDefault();
              add();
            }
          }}
        />
        <button
          type="button"
          className="button button--secondary"
          disabled={draft.trim() === "" || changes.pending}
          onClick={add}
        >
          {t("admin.members.addSubmit")}
        </button>
      </span>
      {/* The reason stands under the field it is about, not beside the row's title. */}
      {error === undefined || lock !== undefined ? null : (
        <span className="field__error" id={errorId} role="alert">
          {error}
        </span>
      )}
    </span>
  );
  return (
    <RowFrame
      id={setting.key}
      title={text.label ?? setting.key}
      titleId={titleId}
      description={text.description}
      note={note}
      badge={badge}
      lock={lock}
      errorId={errorId}
      found={found === setting.key}
    >
      {lock === undefined ? body : <LockedControl>{body}</LockedControl>}
    </RowFrame>
  );
}
