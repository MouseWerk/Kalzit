import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useRef, useState } from "react";
import { TextField } from "../../../components/TextField";
import { useI18n } from "../../../i18n/i18n";
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
import { type ErrorTexts, errorText, MEMBER_ERRORS } from "../errors";
import { allowedWhen, useAdminAccess } from "../sections";
import { RoleSelect, useRoles } from "./shared";

export function MembersPage() {
  const { t, language } = useI18n();
  const access = useAdminAccess();
  const orgId = access.orgId ?? "";
  const queryClient = useQueryClient();
  const canRead = access.has("users:read");
  const canWrite = access.has("users:write");
  const canInvite = access.has("users:invite");
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

  const changeRole = useMutation({
    mutationFn: (input: { member: Member; role: string; undo: boolean }) =>
      changeMemberRole(orgId, input.member.userId, input.role),
    onSuccess: async (_, { member, role, undo }) => {
      await refresh();
      const name = roleLabel(t, role, roles.data);
      notice.show(
        undo
          ? { message: t("admin.members.roleRestored", { name: member.name, role: name }) }
          : {
              message: t("admin.members.roleChanged", { name: member.name, role: name }),
              undo: () =>
                changeRole.mutate({ member: { ...member, role }, role: member.role, undo: true }),
            },
      );
    },
    onError: (error) => notice.showError(errorText(t, error, MEMBER_ERRORS)),
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
        canInvite ? (
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
          {members.map((member, index) => (
            <li key={member.userId} className="admin-row" {...keys.rowProps(index)}>
              <div className="admin-row__main">
                <span className="admin-row__title">{member.name}</span>
                <span className="admin-row__meta">{member.email}</span>
              </div>
              <span className="admin-row__meta">
                {t("admin.members.joined", { date: formatDateTime(member.joinedAt, language) })}
              </span>
              <div className="admin-row__actions">
                {canWrite ? (
                  <RoleSelect
                    label={t("admin.members.roleOf", { name: member.name })}
                    value={member.role}
                    roles={roles.data}
                    access={access}
                    disabled={changeRole.isPending}
                    onChange={(role) => changeRole.mutate({ member, role, undo: false })}
                  />
                ) : (
                  <span className="admin-badge">{roleLabel(t, member.role, roles.data)}</span>
                )}
                {canWrite ? (
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
                ) : null}
              </div>
            </li>
          ))}
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
      <AddMemberDialog
        open={adding}
        orgId={orgId}
        onClose={() => setAdding(false)}
        onAdded={async (email) => {
          setAdding(false);
          await refresh();
          notice.show({ message: t("admin.members.added", { email }) });
        }}
      />
      <ConfirmDialog
        open={removing !== null}
        title={t("admin.members.removeTitle")}
        confirmLabel={t("admin.common.remove")}
        busy={remove.isPending}
        error={remove.error === null ? null : errorText(t, remove.error, MEMBER_ERRORS)}
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

const ADD_MEMBER_ERRORS: ErrorTexts = {
  ...MEMBER_ERRORS,
  not_found: "admin.members.noAccount",
  conflict: "admin.members.alreadyMember",
};

function AddMemberDialog({
  open,
  orgId,
  onClose,
  onAdded,
}: {
  open: boolean;
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
    mutationFn: () => addMember(orgId, { email: email.trim(), role }),
    onSuccess: () => {
      onAdded(email.trim());
      setEmail("");
      setRole("viewer");
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

  function close() {
    add.reset();
    setEmailError(undefined);
    onClose();
  }

  return (
    <Dialog open={open} title={t("admin.members.addTitle")} onClose={close} initialFocus={emailRef}>
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
        {add.error === null ? null : (
          <p className="admin-error" role="alert">
            {errorText(t, add.error, ADD_MEMBER_ERRORS)}
          </p>
        )}
        <div className="admin-dialog__footer">
          <button type="button" className="button button--secondary" onClick={close}>
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
