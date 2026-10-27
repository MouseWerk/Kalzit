import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { Icon } from "../../../components/Icon";
import { useI18n } from "../../../i18n/i18n";
import { showToast } from "../../../lib/toasts";
import { errorText } from "../../admin/errors";
import {
  type AiAccess,
  aiAdminKeys,
  fetchAiAccess,
  MAX_EXCLUDED_FIELD_CHARS,
  MAX_EXCLUDED_FIELDS,
  saveAiAccess,
} from "../adminApi";
import { aiErrorText } from "../reasons";
import { useAiStatus } from "../useAiStatus";
import "../../datasources/datasources.css";
import "../admin/ai-admin.css";

type AccessInput = { readable: boolean; excludedFields: string[] };

/** Whether a field name or dotted path is one the server takes: no empty parts, no line breaks. */
function fieldProblem(name: string): boolean {
  return (
    name.length > MAX_EXCLUDED_FIELD_CHARS ||
    name.split(".").some((part) => part.trim() === "") ||
    Array.from(name).some((char) => (char.codePointAt(0) ?? 0) < 32 || char === "\u007f")
  );
}

/**
 * "AI may read" of one data source (board frame 6), part of its settings while AI is usable:
 * the switch (closed by default), what then leaves the server and the row limit, and the fields
 * whose values AI never receives. Changes apply at once with undo; who may not edit the source
 * sees them read-only with the reason.
 */
export function AiAccessSection({
  orgId,
  datasourceId,
  canWrite,
}: {
  orgId: string;
  datasourceId: string;
  canWrite: boolean;
}) {
  const { t, language } = useI18n();
  const queryClient = useQueryClient();
  const ids = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const { status } = useAiStatus();
  const queryKey = aiAdminKeys.access(orgId, datasourceId);
  const access = useQuery({
    queryKey,
    queryFn: ({ signal }) => fetchAiAccess(orgId, datasourceId, signal),
  });
  const [draft, setDraft] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const save = useMutation({
    mutationFn: (input: AccessInput & { previous?: AiAccess; undoable: boolean }) =>
      saveAiAccess(orgId, datasourceId, {
        readable: input.readable,
        excludedFields: input.excludedFields,
      }),
    onSuccess: (saved, input) => {
      setFieldError(undefined);
      queryClient.setQueryData(queryKey, saved);
      void queryClient.invalidateQueries({ queryKey: aiAdminKeys.readable(orgId) });
      const previous = input.previous;
      showToast({
        message: t("ai.source.saved"),
        undo:
          input.undoable && previous !== undefined
            ? () =>
                save.mutate({
                  readable: previous.readable,
                  excludedFields: previous.excludedFields,
                  undoable: false,
                })
            : undefined,
      });
    },
    onError: (error) => {
      setFieldError(aiErrorText(t, error) ?? errorText(t, error));
      inputRef.current?.focus();
    },
  });

  const titleId = `${ids}-title`;
  if (access.data === undefined) {
    return (
      <section id="ai" className="ds-card" aria-labelledby={titleId}>
        <div className="ds-card__head">
          <div className="ds-card__title">
            <h2 id={titleId}>{t("ai.source.title")}</h2>
          </div>
        </div>
        <div className="ds-card__body">
          <p className={access.isError ? "field__error" : "loading"} role="status">
            {access.isError ? errorText(t, access.error) : t("common.loading")}
          </p>
        </div>
      </section>
    );
  }
  const current = access.data;
  const maxRows = status?.maxRowsToModel;
  const busy = save.isPending;

  function apply(next: AccessInput) {
    save.mutate({ ...next, previous: current, undoable: true });
  }

  function add() {
    const name = draft.trim();
    if (name === "") {
      return;
    }
    if (fieldProblem(name)) {
      setFieldError(t("ai.source.fieldInvalid", { max: MAX_EXCLUDED_FIELD_CHARS }));
      return;
    }
    if (current.excludedFields.length >= MAX_EXCLUDED_FIELDS) {
      setFieldError(t("ai.source.tooMany", { max: MAX_EXCLUDED_FIELDS }));
      return;
    }
    setDraft("");
    setFieldError(undefined);
    if (current.excludedFields.some((field) => field.toLowerCase() === name.toLowerCase())) {
      return;
    }
    apply({ readable: current.readable, excludedFields: [...current.excludedFields, name] });
  }

  const describedBy = [fieldError === undefined ? null : `${ids}-error`, `${ids}-fields-hint`]
    .filter((part) => part !== null)
    .join(" ");

  return (
    <section id="ai" className="ds-card" aria-labelledby={titleId} tabIndex={-1}>
      <div className="ds-card__head">
        <div className="ds-card__title">
          <h2 id={titleId}>{t("ai.source.title")}</h2>
          <p className="ds-card__sub">{t("ai.source.lead")}</p>
        </div>
      </div>
      <div className="ds-card__body">
        {canWrite ? null : (
          <p className="ds-locked">
            <Icon name="lock" />
            <span>{t("ai.source.readOnly")}</span>
          </p>
        )}
        <div className="ai-source__switch">
          <div className="ai-source__text">
            <h3 className="ai-source__heading" id={`${ids}-readable`}>
              {t("ai.source.readable")}
            </h3>
            <p className="settings-hint" id={`${ids}-readable-text`}>
              {t("ai.source.readableText")}
            </p>
          </div>
          <input
            type="checkbox"
            role="switch"
            className="settings-switch"
            checked={current.readable}
            aria-checked={current.readable}
            disabled={!canWrite}
            aria-disabled={busy || undefined}
            aria-labelledby={`${ids}-readable`}
            aria-describedby={`${ids}-readable-text`}
            onChange={(event) => {
              if (!busy) {
                apply({
                  readable: event.currentTarget.checked,
                  excludedFields: current.excludedFields,
                });
              }
            }}
          />
        </div>
        <p className="ai-note">
          <span>
            <strong>{t("ai.source.leaves")}</strong> {t("ai.source.leavesText")}
            {maxRows === undefined
              ? null
              : ` ${t("ai.source.rowLimit", { rows: new Intl.NumberFormat(language).format(maxRows) })}`}
          </span>
        </p>
        <div className="field">
          <label className="field__label" htmlFor={`${ids}-field`} id={`${ids}-fields`}>
            {t("ai.source.excluded")}
          </label>
          <div className="ai-chips">
            <ul className="ai-chips__list" aria-labelledby={`${ids}-fields`}>
              {current.excludedFields.map((field) => (
                <li key={field} className="ai-chip ai-chip--field">
                  <span className="ai-mono" translate="no">
                    {field}
                  </span>
                  {canWrite ? (
                    <button
                      type="button"
                      className="ai-chip__remove"
                      aria-label={t("ai.source.removeFieldNamed", { name: field })}
                      title={t("ai.source.removeField")}
                      disabled={busy}
                      onClick={() =>
                        apply({
                          readable: current.readable,
                          excludedFields: current.excludedFields.filter((f) => f !== field),
                        })
                      }
                    >
                      <Icon name="close" />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
            {canWrite ? (
              <input
                ref={inputRef}
                id={`${ids}-field`}
                className="ai-chips__input"
                value={draft}
                placeholder={t("ai.source.addField")}
                spellCheck={false}
                autoComplete="off"
                aria-invalid={fieldError === undefined ? undefined : true}
                aria-describedby={describedBy}
                onChange={(event) => {
                  setDraft(event.currentTarget.value);
                  setFieldError(undefined);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    add();
                  } else if (
                    event.key === "Backspace" &&
                    draft === "" &&
                    current.excludedFields.length > 0 &&
                    !busy
                  ) {
                    apply({
                      readable: current.readable,
                      excludedFields: current.excludedFields.slice(0, -1),
                    });
                  }
                }}
              />
            ) : current.excludedFields.length === 0 ? (
              <span className="ai-muted">{t("ai.source.noFields")}</span>
            ) : null}
          </div>
          {fieldError === undefined ? null : (
            <p className="field__error" id={`${ids}-error`} role="alert">
              <Icon name="alert" />
              <span>{fieldError}</span>
            </p>
          )}
          <p className="field__hint" id={`${ids}-fields-hint`}>
            {t("ai.source.excludedHint", { max: MAX_EXCLUDED_FIELDS })}
          </p>
        </div>
      </div>
    </section>
  );
}
