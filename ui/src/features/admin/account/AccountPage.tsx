import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useRouter } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { meQuery } from "../../../api/auth";
import { isApiError } from "../../../api/client";
import { MIN_PASSWORD_LENGTH, trimWhitespace } from "../../../auth/validation";
import { Page } from "../../../components/Page";
import { TextField } from "../../../components/TextField";
import { useI18n } from "../../../i18n/i18n";
import { useDocumentTitle } from "../../../lib/useDocumentTitle";
import { useCurrentOrg, useOrgPermissions } from "../../../org/useOrg";
import { PreferencesSection } from "../../../preferences/PreferencesSection";
import { WhyCanI } from "../access/WhyCanI";
import "../admin.css";
import {
  adminKeys,
  changeMyPassword,
  listMySessions,
  revokeOtherSessions,
  revokeSession,
  type Session,
  updateMyName,
} from "../api";
import { PERMISSION_GROUPS, PERMISSION_TEXT, roleLabel } from "../catalog";
import { ConfirmDialog } from "../components/Dialog";
import { formatDateTime } from "../components/format";
import { usePagedList } from "../components/lists";
import { Notice, useNotice } from "../components/Notice";
import { useRowKeys } from "../components/rows";
import { LoadState } from "../components/Section";
import { errorText } from "../errors";
import { nameMessage, newPasswordMessage } from "../validation";

const appRoute = getRouteApi("/_app");

/** The signed-in user's own account: name, password, sessions and permissions. */
export function AccountPage() {
  const { t } = useI18n();
  useDocumentTitle("admin.account.title");
  return (
    <Page title={t("admin.account.title")} lead={t("admin.account.lead")}>
      <ProfileSection />
      <PreferencesSection />
      <PasswordSection />
      <SessionsSection />
      <PermissionsSection />
    </Page>
  );
}

function AccountSection({
  title,
  lead,
  children,
}: {
  title: string;
  lead?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  return (
    <section className="admin-section admin-account__section" aria-labelledby={titleId}>
      <div className="admin-section__heading">
        <h2 id={titleId}>{title}</h2>
        {lead === undefined ? null : <p className="admin-section__lead">{lead}</p>}
      </div>
      {children}
    </section>
  );
}

function ProfileSection() {
  const { t } = useI18n();
  const { me } = appRoute.useRouteContext();
  const router = useRouter();
  const queryClient = useQueryClient();
  const notice = useNotice();
  const [name, setName] = useState(me.name);
  const [error, setError] = useState<string | undefined>(undefined);
  const save = useMutation({
    mutationFn: (input: { next: string; previous: string; undo: boolean }) =>
      updateMyName(input.next),
    onSuccess: async (_, { next, previous, undo }) => {
      await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
      // The shell reads the user from the route context, which the guard fills on navigation.
      await router.invalidate();
      setName(next);
      const message = t("admin.account.nameSaved");
      notice.show(
        undo
          ? { message }
          : { message, undo: () => save.mutate({ next: previous, previous: next, undo: true }) },
      );
    },
    onError: (failure) => notice.showError(errorText(t, failure)),
  });

  function commit() {
    const problem = nameMessage(name, "validation.nameRequired");
    setError(problem === undefined ? undefined : t(problem.key, problem.params));
    const next = trimWhitespace(name);
    if (problem === undefined && next !== me.name && !save.isPending) {
      save.mutate({ next, previous: me.name, undo: false });
    }
  }

  return (
    <AccountSection title={t("admin.account.profile")}>
      <Notice notice={notice.notice} onDismiss={notice.clear} />
      <div className="form admin-account__form">
        <TextField
          label={t("admin.account.name")}
          autoComplete="name"
          value={name}
          onValueChange={(value) => {
            setName(value);
            setError(undefined);
          }}
          onBlur={commit}
          onKeyDown={(event) => {
            // Enter also confirms an input method candidate; that must not save.
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              commit();
            }
          }}
          error={error}
        />
        <div className="field">
          <span className="field__label">{t("admin.account.email")}</span>
          <span>{me.email}</span>
          <span className="field__hint">{t("admin.account.emailHint")}</span>
        </div>
      </div>
    </AccountSection>
  );
}

type PasswordField = "current" | "next" | "confirm";

/**
 * Changing the password is the one form here with an explicit save: the three fields depend on
 * each other and the server checks the current password with the new one.
 */
function PasswordSection() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const notice = useNotice();
  const empty = { current: "", next: "", confirm: "" };
  const [values, setValues] = useState(empty);
  const [errors, setErrors] = useState<Partial<Record<PasswordField, string>>>({});
  const refs = {
    current: useRef<HTMLInputElement>(null),
    next: useRef<HTMLInputElement>(null),
    confirm: useRef<HTMLInputElement>(null),
  };
  const change = useMutation({
    mutationFn: () => changeMyPassword({ current: values.current, new: values.next }),
    onSuccess: async () => {
      setValues(empty);
      notice.show({ message: t("admin.account.passwordChanged") });
      // The server ended every other session.
      await queryClient.invalidateQueries({ queryKey: adminKeys.sessions });
    },
    onError: (failure) => {
      // A wrong current password is a validation error of the field "current".
      if (isApiError(failure, "validation") && failure.field === "current") {
        setErrors({ current: t("admin.account.currentWrong") });
        refs.current.current?.focus();
        return;
      }
      if (isApiError(failure, "validation") && failure.field === "new") {
        setErrors({ next: t("validation.serverRejected") });
        refs.next.current?.focus();
        return;
      }
      notice.showError(errorText(t, failure));
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (change.isPending) {
      return;
    }
    const found: Partial<Record<PasswordField, string>> = {};
    if (values.current === "") {
      found.current = t("validation.passwordRequired");
    }
    const problem = newPasswordMessage(values.next);
    if (problem !== undefined) {
      found.next = t(problem.key, problem.params);
    } else if (values.confirm !== values.next) {
      found.confirm = t("admin.account.confirmMismatch");
    }
    setErrors(found);
    const invalid = (["current", "next", "confirm"] as const).find((field) => found[field]);
    if (invalid !== undefined) {
      refs[invalid].current?.focus();
      return;
    }
    notice.clear();
    change.mutate();
  }

  function edit(field: PasswordField) {
    return (value: string) => {
      setValues({ ...values, [field]: value });
      setErrors({ ...errors, [field]: undefined });
    };
  }

  return (
    <AccountSection title={t("admin.account.password")} lead={t("admin.account.passwordLead")}>
      <Notice notice={notice.notice} onDismiss={notice.clear} />
      <form className="form admin-account__form" noValidate onSubmit={submit}>
        <TextField
          ref={refs.current}
          label={t("admin.account.currentPassword")}
          type="password"
          autoComplete="current-password"
          value={values.current}
          onValueChange={edit("current")}
          error={errors.current}
        />
        <TextField
          ref={refs.next}
          label={t("admin.account.newPassword")}
          hint={t("admin.users.passwordHint", { count: MIN_PASSWORD_LENGTH })}
          type="password"
          autoComplete="new-password"
          value={values.next}
          onValueChange={edit("next")}
          error={errors.next}
        />
        <TextField
          ref={refs.confirm}
          label={t("admin.account.confirmPassword")}
          type="password"
          autoComplete="new-password"
          value={values.confirm}
          onValueChange={edit("confirm")}
          error={errors.confirm}
        />
        <div className="form__actions">
          <button type="submit" className="button button--primary" aria-disabled={change.isPending}>
            {t("admin.account.changePassword")}
          </button>
        </div>
      </form>
    </AccountSection>
  );
}

function SessionsSection() {
  const { t, language, timeZone } = useI18n();
  const queryClient = useQueryClient();
  const notice = useNotice();
  const sessions = usePagedList(adminKeys.sessions, (cursor) => listMySessions(cursor));
  const [confirming, setConfirming] = useState(false);
  const list = sessions.items ?? [];
  const keys = useRowKeys(list.length);
  const refresh = () => queryClient.invalidateQueries({ queryKey: adminKeys.sessions });

  const revoke = useMutation({
    mutationFn: (session: Session) => revokeSession(session.id),
    onSuccess: async () => {
      await refresh();
      notice.show({ message: t("admin.account.sessionRevoked") });
    },
    onError: (failure) => notice.showError(errorText(t, failure)),
  });
  const revokeOthers = useMutation({
    mutationFn: revokeOtherSessions,
    onSuccess: async () => {
      setConfirming(false);
      await refresh();
      notice.show({ message: t("admin.account.othersRevoked") });
    },
  });
  const others = list.filter((session) => !session.current);

  return (
    <AccountSection title={t("admin.account.sessions")} lead={t("admin.account.sessionsLead")}>
      <Notice notice={notice.notice} onDismiss={notice.clear} />
      {sessions.items === undefined ? (
        <LoadState error={sessions.query.error} onRetry={() => void sessions.query.refetch()} />
      ) : (
        <ul className="admin-list" aria-label={t("admin.account.sessions")} {...keys.listProps}>
          {list.map((session, index) => {
            const created = formatDateTime(session.createdAt, language, timeZone);
            return (
              <li key={session.id} className="admin-row" {...keys.rowProps(index)}>
                <div className="admin-row__main">
                  <span className="admin-row__title">
                    {t("admin.account.sessionCreated", { date: created })}
                  </span>
                  <span className="admin-row__meta">
                    {t("admin.account.sessionTimes", {
                      seen: formatDateTime(session.lastSeenAt, language, timeZone),
                      expires: formatDateTime(session.expiresAt, language, timeZone),
                    })}
                  </span>
                </div>
                <div className="admin-row__actions">
                  {session.current ? (
                    <span className="admin-badge">{t("admin.account.thisBrowser")}</span>
                  ) : (
                    <button
                      type="button"
                      className="button button--secondary"
                      aria-label={t("admin.account.revokeNamed", { date: created })}
                      aria-disabled={revoke.isPending}
                      onClick={() => {
                        if (!revoke.isPending) {
                          revoke.mutate(session);
                        }
                      }}
                    >
                      {t("admin.account.revoke")}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {sessions.hasMore ? (
        <button type="button" className="button button--secondary" onClick={sessions.loadMore}>
          {t("admin.common.showMore")}
        </button>
      ) : null}
      {others.length === 0 ? null : (
        <div className="form__actions">
          <button
            type="button"
            className="button button--secondary"
            onClick={() => {
              revokeOthers.reset();
              setConfirming(true);
            }}
          >
            {t("admin.account.revokeOthers")}
          </button>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        title={t("admin.account.revokeOthersTitle")}
        confirmLabel={t("admin.account.revokeOthersConfirm")}
        busy={revokeOthers.isPending}
        error={revokeOthers.error === null ? null : errorText(t, revokeOthers.error)}
        onClose={() => setConfirming(false)}
        onConfirm={() => revokeOthers.mutate()}
      >
        {t("admin.account.revokeOthersText")}
      </ConfirmDialog>
    </AccountSection>
  );
}

/** The user's role and permissions in the current organization, each with where it comes from. */
function PermissionsSection() {
  const { t } = useI18n();
  const org = useCurrentOrg();
  const permissions = useOrgPermissions();
  if (org === undefined) {
    return null;
  }
  const held = PERMISSION_GROUPS.flatMap((group) => group.permissions).filter((permission) =>
    permissions.has(permission),
  );
  return (
    <AccountSection
      title={t("admin.account.permissions")}
      lead={t("admin.account.permissionsLead", {
        org: org.name,
        role: roleLabel(t, org.role, undefined),
      })}
    >
      {!permissions.loaded ? null : held.length === 0 ? (
        <p className="admin-empty">{t("admin.account.noPermissions")}</p>
      ) : (
        <ul className="admin-permission-list">
          {held.map((permission) => (
            <li key={permission} className="admin-permission-list__item">
              <code>{permission}</code>
              <span className="admin-permission-list__text">{t(PERMISSION_TEXT[permission])}</span>
              <WhyCanI permission={permission} />
            </li>
          ))}
        </ul>
      )}
    </AccountSection>
  );
}
