import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useNavigate, useRouter } from "@tanstack/react-router";
import { type FormEvent, useRef, useState } from "react";
import { meQuery } from "../../../api/auth";
import { isApiError } from "../../../api/client";
import {
  type FieldErrors,
  fieldFromServer,
  firstInvalid,
  MIN_PASSWORD_LENGTH,
  trimWhitespace,
  validateSetup,
} from "../../../auth/validation";
import { TextField } from "../../../components/TextField";
import { useI18n } from "../../../i18n/i18n";
import {
  type AdminUser,
  adminKeys,
  createUser,
  listUsers,
  type UserPatch,
  updateUser,
} from "../api";
import { ConfirmDialog, Dialog } from "../components/Dialog";
import { formatDateTime } from "../components/format";
import { usePagedList } from "../components/lists";
import { NameDialog } from "../components/NameDialog";
import { Notice, setFlash, useNotice } from "../components/Notice";
import { useRowKeys } from "../components/rows";
import { LoadState, Section } from "../components/Section";
import { errorText, LOCK_ERRORS, SERVER_ADMIN_ERRORS } from "../errors";
import { allowedWhen, useAdminAccess } from "../sections";
import { newPasswordMessage } from "../validation";

const appRoute = getRouteApi("/_app");

/** Every account on the server: create, rename, lock, make server admin, set a password. */
export function UsersPage() {
  const { t, language } = useI18n();
  const access = useAdminAccess();
  const { me } = appRoute.useRouteContext();
  const queryClient = useQueryClient();
  const router = useRouter();
  const navigate = useNavigate();
  const list = usePagedList(adminKeys.users, (cursor) => listUsers(cursor), access.isServerAdmin);
  const notice = useNotice();
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<AdminUser | null>(null);
  const [settingPassword, setSettingPassword] = useState<AdminUser | null>(null);
  const users = list.items ?? [];
  const keys = useRowKeys(users.length);

  const refresh = () => queryClient.invalidateQueries({ queryKey: adminKeys.server });

  // Accounts carry no version: undo puts back the value as it was when changed here.
  const update = useMutation({
    mutationFn: (input: { user: AdminUser; patch: UserPatch; undo: UserPatch | null }) =>
      updateUser(input.user.id, input.patch),
    onSuccess: async (_, { user, patch, undo }) => {
      await refresh();
      let message = t("admin.users.saved", { name: user.name });
      if (patch.disabled !== undefined) {
        message = t(patch.disabled ? "admin.users.locked" : "admin.users.unlocked", {
          name: user.name,
        });
      } else if (patch.isServerAdmin !== undefined) {
        message = t(patch.isServerAdmin ? "admin.users.madeAdmin" : "admin.users.removedAdmin", {
          name: user.name,
        });
      }
      notice.show(
        undo === null
          ? { message }
          : { message, undo: () => update.mutate({ user, patch: undo, undo: null }) },
      );
    },
    onError: (error) => notice.showError(errorText(t, error, SERVER_ADMIN_ERRORS)),
  });

  // Locking someone, and giving up one's own server admin role, happen only after a confirmation.
  const [confirming, setConfirming] = useState<{
    kind: "lock" | "demoteSelf";
    user: AdminUser;
  } | null>(null);
  const confirm = useMutation({
    mutationFn: (input: { kind: "lock" | "demoteSelf"; user: AdminUser }) =>
      updateUser(
        input.user.id,
        input.kind === "lock" ? { disabled: true } : { isServerAdmin: false },
      ),
    onSuccess: async (_, { kind, user }) => {
      setConfirming(null);
      if (kind === "demoteSelf") {
        // The server sections are gone now: the shell and the access checks read the user from
        // the route context, which the guard fills again, and this page is no longer allowed.
        await queryClient.invalidateQueries({ queryKey: meQuery.queryKey });
        await router.invalidate();
        // The overview confirms it, since this page is gone after the navigation.
        setFlash({ message: t("admin.users.removedAdmin", { name: user.name }) });
        await navigate({ to: "/admin" });
        return;
      }
      await refresh();
      notice.show({
        message: t("admin.users.locked", { name: user.name }),
      });
    },
  });

  return (
    <Section
      title="admin.users.title"
      lead="admin.users.lead"
      allowed={allowedWhen(access, access.isServerAdmin)}
      actions={
        <button type="button" className="button button--primary" onClick={() => setCreating(true)}>
          {t("admin.users.create")}
        </button>
      }
    >
      <Notice notice={notice.notice} onDismiss={notice.clear} />
      {list.items === undefined ? (
        <LoadState error={list.query.error} onRetry={() => void list.query.refetch()} />
      ) : (
        <ul className="admin-list" aria-label={t("admin.users.title")} {...keys.listProps}>
          {users.map((user, index) => (
            <li key={user.id} className="admin-row" {...keys.rowProps(index)}>
              <div className="admin-row__main">
                <span className="admin-row__title">
                  {user.name}
                  {user.id === me.id ? (
                    <span className="admin-row__meta"> {t("admin.users.you")}</span>
                  ) : null}
                </span>
                <span className="admin-row__meta">{user.email}</span>
                <span className="admin-row__meta">
                  {t("admin.users.createdAt", { date: formatDateTime(user.createdAt, language) })}
                </span>
              </div>
              <div className="admin-row__actions">
                <label className="admin-check">
                  <input
                    type="checkbox"
                    checked={user.isServerAdmin}
                    aria-disabled={update.isPending}
                    aria-label={t("admin.users.serverAdminOf", { name: user.name })}
                    onChange={() => {
                      if (update.isPending) {
                        return;
                      }
                      if (user.id === me.id && user.isServerAdmin) {
                        // Taking it from oneself cannot be undone from here: ask first.
                        confirm.reset();
                        setConfirming({ kind: "demoteSelf", user });
                        return;
                      }
                      update.mutate({
                        user,
                        patch: { isServerAdmin: !user.isServerAdmin },
                        undo: { isServerAdmin: user.isServerAdmin },
                      });
                    }}
                  />
                  <span aria-hidden="true">{t("admin.users.serverAdmin")}</span>
                </label>
                <label className="admin-check">
                  <input
                    type="checkbox"
                    checked={user.disabled}
                    aria-disabled={update.isPending}
                    aria-label={t("admin.users.lockedOf", { name: user.name })}
                    onChange={() => {
                      if (update.isPending) {
                        return;
                      }
                      if (!user.disabled) {
                        // Locking ends every session of the account at once: ask first.
                        confirm.reset();
                        setConfirming({ kind: "lock", user });
                        return;
                      }
                      update.mutate({ user, patch: { disabled: false }, undo: null });
                    }}
                  />
                  <span aria-hidden="true">{t("admin.users.lockedLabel")}</span>
                </label>
                <button
                  type="button"
                  className="button button--secondary"
                  aria-label={t("admin.users.renameNamed", { name: user.name })}
                  onClick={() => setRenaming(user)}
                >
                  {t("admin.common.rename")}
                </button>
                <button
                  type="button"
                  className="button button--secondary"
                  aria-label={t("admin.users.setPasswordNamed", { name: user.name })}
                  onClick={() => setSettingPassword(user)}
                >
                  {t("admin.users.setPassword")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {list.hasMore ? (
        <button type="button" className="button button--secondary" onClick={list.loadMore}>
          {t("admin.common.showMore")}
        </button>
      ) : null}
      {creating ? (
        <CreateUserDialog
          onClose={() => setCreating(false)}
          onCreated={async (name) => {
            setCreating(false);
            await refresh();
            notice.show({ message: t("admin.users.created", { name }) });
          }}
        />
      ) : null}
      {renaming === null ? null : (
        <NameDialog
          open
          title={t("admin.users.renameTitle")}
          label={t("admin.users.name")}
          initial={renaming.name}
          submitLabel={t("admin.common.save")}
          onClose={() => setRenaming(null)}
          onSubmit={async (name) => {
            const user = renaming;
            await updateUser(user.id, { name });
            await refresh();
            notice.show({
              message: t("admin.users.saved", { name }),
              undo: () => update.mutate({ user, patch: { name: user.name }, undo: null }),
            });
          }}
        />
      )}
      <ConfirmDialog
        open={confirming !== null}
        title={t(
          confirming?.kind === "lock" ? "admin.users.lockTitle" : "admin.users.demoteSelfTitle",
        )}
        confirmLabel={t(
          confirming?.kind === "lock" ? "admin.users.lockConfirm" : "admin.users.demoteSelfConfirm",
        )}
        busy={confirm.isPending}
        error={
          confirm.error === null
            ? null
            : errorText(
                t,
                confirm.error,
                confirming?.kind === "lock" ? LOCK_ERRORS : SERVER_ADMIN_ERRORS,
              )
        }
        onClose={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming !== null) {
            confirm.mutate(confirming);
          }
        }}
      >
        {t(confirming?.kind === "lock" ? "admin.users.lockText" : "admin.users.demoteSelfText", {
          name: confirming?.user.name ?? "",
        })}
      </ConfirmDialog>
      {settingPassword === null ? null : (
        <SetPasswordDialog
          user={settingPassword}
          onClose={() => setSettingPassword(null)}
          onDone={(name) => {
            setSettingPassword(null);
            notice.show({ message: t("admin.users.passwordSet", { name }) });
          }}
        />
      )}
    </Section>
  );
}

type NewUserField = "name" | "email" | "password";
const NEW_USER_FIELDS: readonly NewUserField[] = ["name", "email", "password"];

/** A taken email address: `409 conflict` with field `email`. */
function conflictField(error: unknown): "email" | undefined {
  return isApiError(error, "conflict") && error.field === "email" ? "email" : undefined;
}

function CreateUserDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const { t } = useI18n();
  const [values, setValues] = useState({ name: "", email: "", password: "" });
  const [isServerAdmin, setIsServerAdmin] = useState(false);
  const [errors, setErrors] = useState<FieldErrors<NewUserField>>({});
  const refs = {
    name: useRef<HTMLInputElement>(null),
    email: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
  };
  const create = useMutation({
    mutationFn: () =>
      createUser({
        name: trimWhitespace(values.name),
        email: trimWhitespace(values.email),
        password: values.password,
        isServerAdmin,
      }),
    onSuccess: (created) => onCreated(created.name),
    onError: (error) => {
      // A field the server names gets the error at the field, where it is announced.
      const field = fieldFromServer(NEW_USER_FIELDS, error) ?? conflictField(error);
      if (field !== undefined) {
        setErrors({
          [field]: {
            key: isApiError(error, "conflict")
              ? "admin.users.emailTaken"
              : "validation.serverRejected",
          },
        });
        refs[field].current?.focus();
      }
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (create.isPending) {
      return;
    }
    // The same rules as for the first account at setup; token and organization do not apply.
    const all = validateSetup({ ...values, token: "-", orgName: "-" });
    const found: FieldErrors<NewUserField> = {};
    for (const field of NEW_USER_FIELDS) {
      const error = all[field];
      if (error !== undefined) {
        found[field] = error;
      }
    }
    setErrors(found);
    const invalid = firstInvalid(NEW_USER_FIELDS, found);
    if (invalid !== undefined) {
      refs[invalid].current?.focus();
      return;
    }
    create.mutate();
  }

  function edit(field: NewUserField) {
    return (value: string) => {
      setValues({ ...values, [field]: value });
      const next = { ...errors };
      delete next[field];
      setErrors(next);
    };
  }

  const fieldError = (field: NewUserField) => {
    const error = errors[field];
    return error === undefined ? undefined : t(error.key, error.params);
  };

  return (
    <Dialog open title={t("admin.users.createTitle")} onClose={onClose} initialFocus={refs.name}>
      <form className="form" noValidate onSubmit={submit}>
        <TextField
          ref={refs.name}
          label={t("admin.users.name")}
          autoComplete="off"
          value={values.name}
          onValueChange={edit("name")}
          error={fieldError("name")}
        />
        <TextField
          ref={refs.email}
          label={t("admin.users.email")}
          type="email"
          autoComplete="off"
          value={values.email}
          onValueChange={edit("email")}
          error={fieldError("email")}
        />
        <TextField
          ref={refs.password}
          label={t("admin.users.password")}
          hint={t("admin.users.passwordHint", { count: MIN_PASSWORD_LENGTH })}
          type="password"
          autoComplete="new-password"
          value={values.password}
          onValueChange={edit("password")}
          error={fieldError("password")}
        />
        <label className="admin-check">
          <input
            type="checkbox"
            checked={isServerAdmin}
            onChange={(event) => setIsServerAdmin(event.currentTarget.checked)}
          />
          <span>{t("admin.users.serverAdmin")}</span>
        </label>
        {create.error === null ||
        fieldFromServer(NEW_USER_FIELDS, create.error) !== undefined ||
        conflictField(create.error) !== undefined ? null : (
          <p className="admin-error" role="alert">
            {errorText(t, create.error, SERVER_ADMIN_ERRORS)}
          </p>
        )}
        <div className="admin-dialog__footer">
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("admin.common.cancel")}
          </button>
          <button type="submit" className="button button--primary" aria-disabled={create.isPending}>
            {t("admin.users.createSubmit")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function SetPasswordDialog({
  user,
  onClose,
  onDone,
}: {
  user: AdminUser;
  onClose: () => void;
  onDone: (name: string) => void;
}) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const save = useMutation({
    mutationFn: () => updateUser(user.id, { password }),
    onSuccess: () => onDone(user.name),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (save.isPending) {
      return;
    }
    const problem = newPasswordMessage(password);
    setError(problem === undefined ? undefined : t(problem.key, problem.params));
    if (problem !== undefined) {
      inputRef.current?.focus();
      return;
    }
    save.mutate();
  }

  return (
    <Dialog
      open
      title={t("admin.users.setPasswordTitle", { name: user.name })}
      onClose={onClose}
      initialFocus={inputRef}
    >
      <form className="form" noValidate onSubmit={submit}>
        <p className="admin-dialog__text">{t("admin.users.setPasswordText")}</p>
        <TextField
          ref={inputRef}
          label={t("admin.users.newPassword")}
          hint={t("admin.users.passwordHint", { count: MIN_PASSWORD_LENGTH })}
          type="password"
          autoComplete="new-password"
          value={password}
          onValueChange={(value) => {
            setPassword(value);
            setError(undefined);
          }}
          error={error}
        />
        {save.error === null ? null : (
          <p className="admin-error" role="alert">
            {errorText(t, save.error)}
          </p>
        )}
        <div className="admin-dialog__footer">
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("admin.common.cancel")}
          </button>
          <button type="submit" className="button button--primary" aria-disabled={save.isPending}>
            {t("admin.users.setPasswordSubmit")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
