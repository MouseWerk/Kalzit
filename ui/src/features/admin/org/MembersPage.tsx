import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useRef, useState } from "react";
import { isApiError } from "../../../api/client";
import { trimWhitespace } from "../../../auth/validation";
import { Icon } from "../../../components/Icon";
import { TextField } from "../../../components/TextField";
import { type Translate, useI18n } from "../../../i18n/i18n";
import {
  addMember,
  adminKeys,
  changeMemberRole,
  listMembers,
  type Member,
  removeMember,
} from "../api";
import { roleLabel } from "../catalog";
import { ConfirmDialog, Dialog } from "../components/Dialog";
import { formatDateTime } from "../components/format";
import { usePagedList } from "../components/lists";
import { Notice, useNotice } from "../components/Notice";
import { useRowKeys } from "../components/rows";
import { LoadState, Section } from "../components/Section";
import { ADD_MEMBER_ERRORS, errorText, MEMBER_ERRORS } from "../errors";
import { allowedWhen, useAdminAccess } from "../sections";
import { ssoReason } from "../sso/texts";
import { holdsRole, RoleSelect, useRoles } from "./shared";

/**
 * Why a change of a member failed. An "IdP decides" group mapping holds the role
 * (`sso.role_managed`); the other conflicts are the last owner.
 */
function memberErrorText(t: Translate, error: unknown): string {
  if (ssoReason(error)?.reason === "sso.role_managed") {
    return t("admin.members.idpManagedError");
  }
  return errorText(t, error, MEMBER_ERRORS);
}

export function MembersPage() {
  const { t, language, timeZone } = useI18n();
  const access = useAdminAccess();
  const orgId = access.orgId ?? "";
  const queryClient = useQueryClient();
  const canRead = access.has("users:read");
  // Adding, changing and removing members all need users:write (docs/api/access.md, Members).
  const canWrite = access.has("users:write");
  const roles = useRoles(access.orgId, access.has("roles:read"));
  const list = usePagedList(
    adminKeys.members(orgId),
    (cursor) => listMembers(orgId, cursor),
    canRead,
  );
  const notice = useNotice();
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const members = list.items ?? [];
  const keys = useRowKeys(members.length);

  const refresh = () => queryClient.invalidateQueries({ queryKey: adminKeys.org(orgId) });

  // Members carry no version, so undo restores the previous role as it was when changed here; a
  // change someone else made in between is overwritten. The server still checks the guards.
  const changeRole = useMutation({
    mutationFn: (input: { member: Member; role: string; undo: boolean }) =>
      changeMemberRole(orgId, input.member.userId, input.role),
    onSuccess: async (changed, { member, undo }) => {
      await refresh();
      const name = roleLabel(t, changed.role, roles.data);
      notice.show(
        undo
          ? { message: t("admin.members.roleRestored", { name: member.name, role: name }) }
          : {
              message: t("admin.members.roleChanged", { name: member.name, role: name }),
              undo: () => changeRole.mutate({ member: changed, role: member.role, undo: true }),
            },
      );
    },
    onError: (error) => {
      notice.showError(memberErrorText(t, error));
      // The member list may be older than the mapping that locked the role.
      void refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (member: Member) => removeMember(orgId, member.userId),
    onSuccess: async (_, member) => {
      setRemoving(null);
      await refresh();
      notice.show({ message: t("admin.members.removed", { name: member.name }) });
    },
  });

  return (
    <Section
      title="admin.members.title"
      lead="admin.members.lead"
      allowed={allowedWhen(access, canRead)}
      actions={
        canWrite ? (
          <button type="button" className="button button--primary" onClick={() => setAdding(true)}>
            {t("admin.members.add")}
          </button>
        ) : undefined
      }
    >
      <Notice notice={notice.notice} onDismiss={notice.clear} />
      {list.items === undefined ? (
        <LoadState error={list.query.error} onRetry={() => void list.query.refetch()} />
      ) : (
        <ul className="admin-list" aria-label={t("admin.members.title")} {...keys.listProps}>
          {members.map((member, index) => {
            // Nobody changes or removes someone whose role holds more than they do, nor a role an
            // "IdP decides" group mapping sets.
            const managed = member.idpManaged === true;
            const canChange = canWrite && !managed && holdsRole(access, member.role, roles.data);
            return (
              <li key={member.userId} className="admin-row" {...keys.rowProps(index)}>
                <div className="admin-row__main">
                  <span className="admin-row__title">{member.name}</span>
                  <span className="admin-row__meta">{member.email}</span>
                </div>
                <span className="admin-row__meta">
                  {t("admin.members.joined", {
                    date: formatDateTime(member.joinedAt, language, timeZone),
                  })}
                </span>
                <div className="admin-row__actions">
                  {canChange ? (
                    <>
                      <RoleSelect
                        label={t("admin.members.roleOf", { name: member.name })}
                        value={member.role}
                        roles={roles.data}
                        access={access}
                        pending={changeRole.isPending}
                        onChange={(role) => changeRole.mutate({ member, role, undo: false })}
                      />
                      <button
                        type="button"
                        className="button button--secondary"
                        aria-label={t("admin.members.removeNamed", { name: member.name })}
                        onClick={() => {
                          remove.reset();
                          setRemoving(member);
                        }}
                      >
                        {t("admin.common.removeAsk")}
                      </button>
                    </>
                  ) : managed ? (
                    <span className="admin-row__locked" title={t("admin.members.idpManagedHint")}>
                      <span className="admin-badge">{roleLabel(t, member.role, roles.data)}</span>
                      <span className="admin-row__meta admin-row__lock">
                        <Icon name="lock" />
                        {t("admin.members.idpManaged")}
                      </span>
                    </span>
                  ) : (
                    <span
                      className="admin-badge"
                      title={canWrite ? t("admin.members.aboveYou") : undefined}
                    >
                      {roleLabel(t, member.role, roles.data)}
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {list.hasMore ? (
        <button
          type="button"
          className="button button--secondary"
          aria-disabled={list.loadingMore}
          onClick={list.loadMore}
        >
          {t("admin.common.showMore")}
        </button>
      ) : null}
      {adding ? (
        <AddMemberDialog
          orgId={orgId}
          onClose={() => setAdding(false)}
          onAdded={async (email) => {
            setAdding(false);
            await refresh();
            notice.show({ message: t("admin.members.added", { email }) });
          }}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        title={t("admin.members.removeTitle")}
        confirmLabel={t("admin.common.remove")}
        busy={remove.isPending}
        error={remove.error === null ? null : memberErrorText(t, remove.error)}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          if (removing !== null) {
            remove.mutate(removing);
          }
        }}
      >
        {t("admin.members.removeText", { name: removing?.name ?? "" })}
      </ConfirmDialog>
    </Section>
  );
}

function AddMemberDialog({
  orgId,
  onClose,
  onAdded,
}: {
  orgId: string;
  onClose: () => void;
  onAdded: (email: string) => void;
}) {
  const { t } = useI18n();
  const access = useAdminAccess();
  const roles = useRoles(access.orgId, access.has("roles:read"));
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("viewer");
  const [emailError, setEmailError] = useState<string | undefined>(undefined);
  const emailRef = useRef<HTMLInputElement>(null);
  const roleId = useId();
  const add = useMutation({
    mutationFn: () => addMember(orgId, { email: trimWhitespace(email), role }),
    onSuccess: () => onAdded(trimWhitespace(email)),
    onError: (error) => {
      // Problems with the address belong to its field, where they are announced.
      if (isApiError(error) && error.field === "email") {
        setEmailError(errorText(t, error, ADD_MEMBER_ERRORS));
        emailRef.current?.focus();
      }
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (add.isPending) {
      return;
    }
    if (!email.includes("@")) {
      setEmailError(t("validation.emailInvalid"));
      emailRef.current?.focus();
      return;
    }
    add.mutate();
  }

  const formError =
    add.error === null || (isApiError(add.error) && add.error.field === "email")
      ? null
      : errorText(t, add.error, ADD_MEMBER_ERRORS);

  return (
    <Dialog open title={t("admin.members.addTitle")} onClose={onClose} initialFocus={emailRef}>
      <form className="form" noValidate onSubmit={onSubmit}>
        <TextField
          ref={emailRef}
          label={t("admin.members.email")}
          hint={t("admin.members.emailHint")}
          type="email"
          autoComplete="off"
          value={email}
          onValueChange={(value) => {
            setEmail(value);
            setEmailError(undefined);
          }}
          error={emailError}
        />
        <div className="field">
          <label className="field__label" htmlFor={roleId}>
            {t("admin.members.role")}
          </label>
          <RoleSelect
            id={roleId}
            value={role}
            roles={roles.data}
            access={access}
            onChange={setRole}
          />
        </div>
        {formError === null ? null : (
          <p className="admin-error" role="alert">
            {formError}
          </p>
        )}
        <div className="admin-dialog__footer">
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("admin.common.cancel")}
          </button>
          <button type="submit" className="button button--primary" aria-disabled={add.isPending}>
            {t("admin.members.addSubmit")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
