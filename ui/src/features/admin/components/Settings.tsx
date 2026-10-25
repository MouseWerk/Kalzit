import { type QueryKey, useMutation, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { isApiError } from "../../../api/client";
import { useI18n } from "../../../i18n/i18n";
import { rangeLabel } from "../../dashboards/TimeRangePicker";
import type { TextRange } from "../../dashboards/timeRange";
import { isSetting, type Setting } from "../api";
import { settingName } from "../catalog";
import { errorText, SETTING_ERRORS } from "../errors";
import { Dialog } from "./Dialog";
import { formatValue } from "./format";
import { useNotice } from "./Notice";

interface Conflict {
  key: string;
  mine: unknown;
  stored: unknown;
  storedSource: string;
  version: number;
}

/** Settings that hold a time range: chosen with the dashboards' time range picker, not as JSON. */
const TIME_RANGE_SETTINGS: ReadonlySet<string> = new Set(["dashboards.default_time_range"]);

function isTextRange(value: unknown): value is TextRange {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { from?: unknown }).from === "string" &&
    typeof (value as { to?: unknown }).to === "string"
  );
}

/** A value as the settings list shows it: a time range by its name, anything else as JSON. */
function useShownValue(): (key: string, value: unknown) => string {
  const { t, language, timeZone } = useI18n();
  return (key, value) =>
    TIME_RANGE_SETTINGS.has(key) && isTextRange(value)
      ? rangeLabel(t, language, value, timeZone)
      : formatValue(value);
}

/**
 * Settings apply as soon as a value is committed, with undo. Undo names the version the change
 * produced, so when someone else saved in between it ends in a version conflict like any other
 * change: the conflict dialog shows both values and lets the user keep the stored one or
 * overwrite it on purpose.
 */
export function useSettingChanges({
  queryKey,
  patch,
  reset,
}: {
  queryKey: QueryKey;
  patch: (key: string, value: unknown, version: number) => Promise<Setting>;
  /**
   * Removes the stored value so the default applies again. Undo of a change to a setting that
   * had no value of its own uses it, so undo does not store a copy of the default.
   */
  reset?: (key: string, version: number) => Promise<Setting>;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const notice = useNotice();
  const [conflict, setConflict] = useState<Conflict | null>(null);
  // A value the server rejected, shown at its setting's field.
  const [rejected, setRejected] = useState<{ key: string; message: string } | null>(null);
  // Changes committed while a save is on its way, the latest per setting; they are sent in turn
  // with the version the settings have then, instead of being dropped.
  const queued = useRef(new Map<string, unknown>());

  function sendNext() {
    const next = queued.current.entries().next();
    if (next.done === true) {
      return;
    }
    const [key, value] = next.value;
    queued.current.delete(key);
    const setting = queryClient.getQueryData<Setting[]>(queryKey)?.find((s) => s.key === key);
    if (setting === undefined) {
      sendNext();
      return;
    }
    save.mutate({
      key,
      value,
      previous: setting.value,
      previousSource: setting.source,
      version: setting.version,
    });
  }

  const save = useMutation({
    mutationFn: (input: {
      key: string;
      value: unknown;
      previous: unknown;
      /** Where the value before this change came from; undo resets a `default`. */
      previousSource: string;
      version: number;
      /** Remove the stored value instead of writing `value` (the undo of such a change). */
      reset?: boolean;
    }) =>
      input.reset === true && reset !== undefined
        ? reset(input.key, input.version)
        : patch(input.key, input.value, input.version),
    onSuccess: async (saved, { previous, previousSource }) => {
      setRejected(null);
      await queryClient.invalidateQueries({ queryKey });
      notice.show({
        message: t("admin.settings.saved", { name: settingName(t, saved.key) }),
        undo: () =>
          save.mutate({
            key: saved.key,
            value: previous,
            previous: saved.value,
            previousSource: saved.source,
            version: saved.version,
            reset: previousSource === "default",
          }),
      });
    },
    // The next queued change starts once this one is done, with the versions it left.
    onSettled: () => queueMicrotask(sendNext),
    onError: (error, { key, value }) => {
      // A later change of the same setting would go over what this error is about.
      queued.current.delete(key);
      if (isApiError(error, "validation") && error.field === "value") {
        notice.clear();
        setRejected({ key, message: errorText(t, error, SETTING_ERRORS) });
        return;
      }
      if (!isApiError(error, "version_conflict")) {
        notice.showError(errorText(t, error, SETTING_ERRORS));
        return;
      }
      // The conflict answer carries the stored setting as `current`.
      const stored = error.current;
      if (!isSetting(stored) || stored.key !== key) {
        // Without the stored value there is nothing to compare; say so instead.
        notice.showError(t("errors.invalid_response"));
        return;
      }
      notice.clear();
      // Show the stored value in the list at once, then refresh the rest in the background.
      queryClient.setQueryData<Setting[]>(queryKey, (settings) =>
        settings?.map((setting) => (setting.key === key ? stored : setting)),
      );
      void queryClient.invalidateQueries({ queryKey });
      setConflict({
        key,
        mine: value,
        stored: stored.value,
        storedSource: stored.source,
        version: stored.version,
      });
    },
  });

  return {
    notice,
    conflict,
    rejected,
    pending: save.isPending,
    apply: (setting: Setting, value: unknown) => {
      setRejected(null);
      if (save.isPending) {
        queued.current.delete(setting.key);
        queued.current.set(setting.key, value);
        return;
      }
      save.mutate({
        key: setting.key,
        value,
        previous: setting.value,
        previousSource: setting.source,
        version: setting.version,
      });
    },
    keepStored: () => setConflict(null),
    overwrite: () => {
      if (conflict !== null) {
        setConflict(null);
        save.mutate({
          key: conflict.key,
          value: conflict.mine,
          previous: conflict.stored,
          previousSource: conflict.storedSource,
          version: conflict.version,
        });
      }
    },
  };
}

export function ConflictDialog({
  conflict,
  onKeepStored,
  onOverwrite,
}: {
  conflict: Conflict | null;
  onKeepStored: () => void;
  onOverwrite: () => void;
}) {
  const { t } = useI18n();
  const shown = useShownValue();
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
      <p>
        {t("admin.conflict.text", { name: conflict === null ? "" : settingName(t, conflict.key) })}
      </p>
      <dl className="admin-conflict">
        <dt>{t("admin.conflict.stored")}</dt>
        <dd>
          <code>{conflict === null ? "" : shown(conflict.key, conflict.stored)}</code>
        </dd>
        <dt>{t("admin.conflict.mine")}</dt>
        <dd>
          <code>{conflict === null ? "" : shown(conflict.key, conflict.mine)}</code>
        </dd>
      </dl>
    </Dialog>
  );
}
