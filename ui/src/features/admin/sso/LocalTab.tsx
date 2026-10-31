import { type UseQueryResult, useMutation, useQueryClient } from "@tanstack/react-query";
import { useId } from "react";
import { isApiError } from "../../../api/client";
import { Icon } from "../../../components/Icon";
import { type MessageKey, useI18n } from "../../../i18n/i18n";
import { Segmented } from "../../settings/rows";
import { adminKeys, listUsers, MAX_PAGE_SIZE } from "../api";
import { usePagedList } from "../components/lists";
import { useNotice } from "../components/Notice";
import { LoadState } from "../components/Section";
import {
  type LocalInput,
  type LocalSignIn,
  type PasswordFormMode,
  setLocalSignIn,
  ssoKeys,
} from "./api";
import { ssoErrorText } from "./texts";
import "../../settings/settings.css";
import "./sso.css";

const FORM_LABEL: Record<PasswordFormMode, MessageKey> = {
  expanded: "sso.local.formExpanded",
  collapsed: "sso.local.formCollapsed",
  hidden: "sso.local.formHidden",
};

function inputOf(local: LocalSignIn): LocalInput {
  return {
    localPassword: local.localPassword,
    passwordForm: local.passwordForm,
    breakGlassUserId: local.breakGlass?.userId ?? null,
  };
}

/**
 * The local password sign-in (board frame 5G): the switch, the break-glass admin who still signs
 * in with a password while it is off, where the password form stands on the sign-in page, and
 * the checks that keep anyone from being locked out. Applies at once with undo.
 */
export function LocalTab({ local }: { local: UseQueryResult<LocalSignIn> }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const notice = useNotice();
  const ids = useId();
  const users = usePagedList([...adminKeys.users, "picker"], (cursor) =>
    listUsers(cursor, MAX_PAGE_SIZE),
  );

  const change = useMutation({
    mutationFn: (input: { next: LocalInput; previous: LocalInput; undo: boolean }) =>
      setLocalSignIn(input.next),
    onSuccess: async (_, input) => {
      await queryClient.invalidateQueries({ queryKey: ssoKeys.all });
      let message: string;
      if (input.undo) {
        message = t("sso.local.undone");
      } else if (input.next.localPassword !== input.previous.localPassword) {
        message = t(
          input.next.localPassword === "on" ? "sso.local.turnedOn" : "sso.local.turnedOff",
        );
      } else if (input.next.passwordForm !== input.previous.passwordForm) {
        message = t("sso.local.formChanged", { form: t(FORM_LABEL[input.next.passwordForm]) });
      } else {
        message = t("sso.local.breakGlassChanged");
      }
      notice.show(
        input.undo
          ? { message }
          : {
              message,
              undo: () => change.mutate({ next: input.previous, previous: input.next, undo: true }),
            },
      );
    },
    onError: (error) => {
      if (!(isApiError(error) && error.field === "breakGlassUserId")) {
        notice.showError(ssoErrorText(t, error));
      }
    },
  });

  if (local.data === undefined) {
    return <LoadState error={local.error} onRetry={() => void local.refetch()} />;
  }
  const data = local.data;
  const current = inputOf(data);
  const checks = data.checks;
  const blocked =
    data.localPassword === "on" &&
    !(checks.providerReady.ok && checks.breakGlassReady.ok && checks.selfViaProvider.ok);
  const switchLocked = data.readOnly || blocked || change.isPending;
  const admins = (users.items ?? []).filter((user) => user.isServerAdmin && !user.disabled);
  const breakGlassError =
    change.error !== null && isApiError(change.error) && change.error.field === "breakGlassUserId"
      ? ssoErrorText(t, change.error)
      : undefined;

  function apply(next: Partial<LocalInput>) {
    if (data.readOnly || change.isPending) {
      return;
    }
    change.mutate({ next: { ...current, ...next }, previous: current, undo: false });
  }

  return (
    <div className="sso-local">
      <div className="sso-stack">
        {data.readOnly ? (
          <p className="notice sso-readonly">
            <Icon name="lock" />
            <span>{t("sso.local.readOnly")}</span>
          </p>
        ) : null}
        <div className="settings-card">
          <div className="settings-row" id="signin.local_password" tabIndex={-1}>
            <div className="settings-row__text">
              <h3 className="settings-row__title" id={`${ids}-local`}>
                {t("sso.local.title")}
              </h3>
              <p className="settings-row__description" id={`${ids}-local-description`}>
                {t("sso.local.description")}
              </p>
              {blocked && !data.readOnly ? (
                <p className="settings-row__note" id={`${ids}-local-blocked`}>
                  {t("sso.local.blocked")}
                </p>
              ) : null}
            </div>
            <div className="settings-row__control">
              <input
                type="checkbox"
                role="switch"
                className="settings-switch"
                checked={data.localPassword === "on"}
                aria-checked={data.localPassword === "on"}
                aria-disabled={switchLocked ? true : undefined}
                aria-labelledby={`${ids}-local`}
                aria-describedby={
                  blocked
                    ? `${ids}-local-description ${ids}-local-blocked`
                    : `${ids}-local-description`
                }
                onChange={(event) => {
                  if (!switchLocked) {
                    apply({ localPassword: event.currentTarget.checked ? "on" : "off" });
                  }
                }}
              />
              <span>{t(data.localPassword === "on" ? "sso.local.on" : "sso.local.off")}</span>
            </div>
          </div>
          <div className="settings-row" id="signin.break_glass_user" tabIndex={-1}>
            <div className="settings-row__text">
              <h3 className="settings-row__title">
                <label htmlFor={`${ids}-breakglass`}>{t("sso.local.breakGlass")}</label>
              </h3>
              <p className="settings-row__description" id={`${ids}-breakglass-description`}>
                {t("sso.local.breakGlassHint")}
              </p>
              {breakGlassError === undefined ? null : (
                <p className="field__error" id={`${ids}-breakglass-error`}>
                  <Icon name="alert" />
                  <span>{breakGlassError}</span>
                </p>
              )}
            </div>
            <div className="settings-row__control">
              {users.items === undefined ? (
                <LoadState error={users.query.error} onRetry={() => void users.query.refetch()} />
              ) : (
                <select
                  id={`${ids}-breakglass`}
                  className="select settings-select"
                  value={current.breakGlassUserId ?? ""}
                  disabled={data.readOnly}
                  aria-invalid={breakGlassError === undefined ? undefined : true}
                  aria-describedby={
                    breakGlassError === undefined
                      ? `${ids}-breakglass-description`
                      : `${ids}-breakglass-error ${ids}-breakglass-description`
                  }
                  onChange={(event) =>
                    apply({
                      breakGlassUserId:
                        event.currentTarget.value === "" ? null : event.currentTarget.value,
                    })
                  }
                >
                  <option value="">{t("sso.local.noBreakGlass")}</option>
                  {data.breakGlass !== null &&
                  !admins.some((user) => user.id === data.breakGlass?.userId) ? (
                    <option value={data.breakGlass.userId}>{data.breakGlass.name}</option>
                  ) : null}
                  {admins.map((user) => (
                    <option key={user.id} value={user.id}>
                      {t("admin.common.nameAndEmail", { name: user.name, email: user.email })}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </div>
          <div className="settings-row" id="signin.password_form" tabIndex={-1}>
            <div className="settings-row__text">
              <h3 className="settings-row__title" id={`${ids}-form`}>
                {t("sso.local.form")}
              </h3>
              <p className="settings-row__description">{t("sso.local.formHint")}</p>
            </div>
            <div className="settings-row__control">
              <Segmented
                labelled={{ "aria-labelledby": `${ids}-form` }}
                value={data.passwordForm}
                options={(["expanded", "collapsed", "hidden"] as const).map((value) => ({
                  value,
                  label: t(FORM_LABEL[value]),
                }))}
                onChange={(value) => apply({ passwordForm: value as PasswordFormMode })}
              />
            </div>
          </div>
        </div>
      </div>
      <section
        className="settings-card settings-card--padded sso-checks"
        aria-labelledby={`${ids}-checks`}
      >
        <h3 className="settings-row__title" id={`${ids}-checks`}>
          {t("sso.checks.title")}
        </h3>
        <p className="settings-row__description">{t("sso.checks.lead")}</p>
        <ul className="sso-checks__list">
          <CheckLine
            ok={checks.providerReady.ok}
            text={
              checks.providerReady.ok
                ? t("sso.checks.providerReady", { name: checks.providerReady.name ?? "" })
                : t("sso.checks.providerMissing")
            }
          />
          <CheckLine
            ok={checks.breakGlassReady.ok}
            text={t(
              checks.breakGlassReady.ok
                ? "sso.checks.breakGlassReady"
                : "sso.checks.breakGlassMissing",
            )}
          />
          <CheckLine
            ok={checks.selfViaProvider.ok}
            text={t(checks.selfViaProvider.ok ? "sso.checks.selfReady" : "sso.checks.selfMissing")}
          />
        </ul>
        <p className="settings-hint">
          {t("sso.checks.passwordOnly", { count: checks.passwordOnlyAccounts })}
        </p>
      </section>
    </div>
  );
}

function CheckLine({ ok, text }: { ok: boolean; text: string }) {
  const { t } = useI18n();
  return (
    <li className={ok ? "sso-check-line" : "sso-check-line sso-check-line--open"}>
      <Icon name={ok ? "check" : "alert"} />
      <span>
        <span className="visually-hidden">{t(ok ? "sso.checks.met" : "sso.checks.notMet")} </span>
        {text}
      </span>
    </li>
  );
}
