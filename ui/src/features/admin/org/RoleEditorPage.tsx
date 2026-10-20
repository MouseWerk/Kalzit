import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useId, useRef, useState } from "react";
import { trimWhitespace } from "../../../auth/validation";
import { TextField } from "../../../components/TextField";
import { useI18n } from "../../../i18n/i18n";
import { adminKeys, createRole, type Role, type RoleInput, updateRole } from "../api";
import { isKnownPermission, PERMISSION_GROUPS, PERMISSION_TEXT, roleLabel } from "../catalog";
import { Notice, useNotice } from "../components/Notice";
import { LoadState, Section } from "../components/Section";
import { type ErrorTexts, errorText, GRANT_ERRORS } from "../errors";
import { type AdminAccess, allowedWhen, useAdminAccess } from "../sections";
import { nameMessage } from "../validation";
import { useRoles } from "./shared";

const ROLE_ERRORS: ErrorTexts = { ...GRANT_ERRORS, conflict: "admin.roles.nameTaken" };

const roleRoute = getRouteApi("/_app/admin/roles/$roleId");

/** The role page as a route; keyed, so moving between roles starts with fresh state. */
export function RoleRoutePage() {
  const { roleId } = roleRoute.useParams();
  return <RoleEditorPage key={roleId} roleId={roleId} />;
}

/** A role's permissions, grouped by area; `roleId` "new" starts a new custom role. */
export function RoleEditorPage({ roleId }: { roleId: string }) {
  const { t } = useI18n();
  const access = useAdminAccess();
  const canRead = access.has("roles:read");
  const roles = useRoles(access.orgId, canRead);
  const isNew = roleId === "new";
  const role = roles.data?.find((candidate) => candidate.id === roleId);

  const back = (
    <Link to="/admin/roles" className="admin-back">
      {t("admin.roles.back")}
    </Link>
  );

  let heading: string | undefined;
  if (isNew) {
    heading = t("admin.roles.newTitle");
  } else if (role !== undefined) {
    heading = roleLabel(t, role.id, roles.data);
  }

  let body = null;
  if (isNew) {
    body = access.has("roles:write") ? (
      <NewRoleForm access={access} />
    ) : (
      <p className="admin-empty">{t("admin.forbidden.section")}</p>
    );
  } else if (roles.data === undefined) {
    body = <LoadState error={roles.error} onRetry={() => void roles.refetch()} />;
  } else if (role === undefined) {
    body = <p className="admin-empty">{t("admin.roles.notFound")}</p>;
  } else if (role.builtin || !access.has("roles:write")) {
    body = <ReadOnlyRole role={role} />;
  } else {
    body = <EditRole role={role} access={access} />;
  }

  return (
    <Section
      title="admin.roles.title"
      heading={heading}
      back={back}
      allowed={allowedWhen(access, canRead)}
    >
      {body}
    </Section>
  );
}

function ReadOnlyRole({ role }: { role: Role }) {
  const { t } = useI18n();
  return (
    <>
      <p className="admin-section__lead">
        {role.builtin ? t("admin.roles.builtinReadOnly") : role.description}
      </p>
      <PermissionPicker
        selected={role.permissions}
        isAllowed={() => false}
        readOnly
        onToggle={() => undefined}
      />
    </>
  );
}

function useNameError() {
  const { t } = useI18n();
  return (name: string) => {
    const problem = nameMessage(name);
    return problem === undefined ? undefined : t(problem.key, problem.params);
  };
}

function NewRoleForm({ access }: { access: AdminAccess }) {
  const { t } = useI18n();
  const orgId = access.orgId ?? "";
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const nameText = useNameError();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [permissions, setPermissions] = useState<string[]>([]);
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const nameRef = useRef<HTMLInputElement>(null);
  const create = useMutation({
    mutationFn: (input: RoleInput) => createRole(orgId, input),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: adminKeys.roles(orgId) });
      if (created === undefined) {
        await navigate({ to: "/admin/roles" });
      } else {
        await navigate({ to: "/admin/roles/$roleId", params: { roleId: created.id } });
      }
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (create.isPending) {
      return;
    }
    const problem = nameText(name);
    setNameError(problem);
    if (problem !== undefined) {
      nameRef.current?.focus();
      return;
    }
    create.mutate({ name: trimWhitespace(name), description: description.trim(), permissions });
  }

  return (
    <form className="form" noValidate onSubmit={submit}>
      <TextField
        ref={nameRef}
        label={t("admin.roles.name")}
        value={name}
        autoComplete="off"
        onValueChange={(value) => {
          setName(value);
          setNameError(undefined);
        }}
        error={nameError}
      />
      <TextField
        label={t("admin.roles.description")}
        value={description}
        autoComplete="off"
        onValueChange={setDescription}
      />
      <PermissionPicker
        selected={permissions}
        isAllowed={(permission) => isKnownPermission(permission) && access.has(permission)}
        onToggle={(permission) =>
          setPermissions(
            permissions.includes(permission)
              ? permissions.filter((p) => p !== permission)
              : [...permissions, permission],
          )
        }
      />
      {create.error === null ? null : (
        <p className="admin-error" role="alert">
          {errorText(t, create.error, ROLE_ERRORS)}
        </p>
      )}
      <div className="form__actions">
        <button type="submit" className="button button--primary" aria-disabled={create.isPending}>
          {t("admin.roles.createSubmit")}
        </button>
      </div>
    </form>
  );
}

/**
 * An existing custom role. Each change is saved at once and can be undone; name and description
 * save when the field is left or Enter is pressed.
 */
function EditRole({ role, access }: { role: Role; access: AdminAccess }) {
  const { t } = useI18n();
  const orgId = access.orgId ?? "";
  const queryClient = useQueryClient();
  const notice = useNotice();
  const nameText = useNameError();
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description);
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  // The fields follow the stored role when it changes (a save, an undo, someone else's change).
  const [shown, setShown] = useState({ name: role.name, description: role.description });
  if (shown.name !== role.name || shown.description !== role.description) {
    setShown({ name: role.name, description: role.description });
    setName(role.name);
    setDescription(role.description);
  }
  const stored: RoleInput = {
    name: role.name,
    description: role.description,
    permissions: role.permissions,
  };

  const save = useMutation({
    mutationFn: (input: { next: RoleInput; previous: RoleInput; undo: boolean }) =>
      updateRole(orgId, role.id, input.next),
    onSuccess: async (_, { next, previous, undo }) => {
      await queryClient.invalidateQueries({ queryKey: adminKeys.org(orgId) });
      const message = t("admin.roles.saved", { name: next.name });
      notice.show(
        undo
          ? { message }
          : { message, undo: () => save.mutate({ next: previous, previous: next, undo: true }) },
      );
    },
    onError: (error) => notice.showError(errorText(t, error, ROLE_ERRORS)),
  });

  function apply(change: Partial<RoleInput>) {
    const next = { ...stored, ...change };
    if (JSON.stringify(next) !== JSON.stringify(stored)) {
      save.mutate({ next, previous: stored, undo: false });
    }
  }

  function commitName() {
    const problem = nameText(name);
    setNameError(problem);
    if (problem === undefined) {
      apply({ name: trimWhitespace(name) });
    }
  }

  return (
    <div className="form">
      <Notice notice={notice.notice} onDismiss={notice.clear} />
      <TextField
        label={t("admin.roles.name")}
        value={name}
        autoComplete="off"
        onValueChange={(value) => {
          setName(value);
          setNameError(undefined);
        }}
        onBlur={commitName}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commitName();
          }
        }}
        error={nameError}
      />
      <TextField
        label={t("admin.roles.description")}
        value={description}
        autoComplete="off"
        onValueChange={setDescription}
        onBlur={() => apply({ description: description.trim() })}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            apply({ description: description.trim() });
          }
        }}
      />
      <PermissionPicker
        selected={role.permissions}
        disabled={save.isPending}
        isAllowed={(permission) => isKnownPermission(permission) && access.has(permission)}
        onToggle={(permission) =>
          apply({
            permissions: role.permissions.includes(permission)
              ? role.permissions.filter((p) => p !== permission)
              : [...role.permissions, permission],
          })
        }
      />
    </div>
  );
}

/**
 * The permission catalog grouped by area, with what each permission allows. Permissions the user
 * does not hold cannot be added (nobody grants more than they hold), but can be taken away.
 */
function PermissionPicker({
  selected,
  isAllowed,
  onToggle,
  readOnly = false,
  disabled = false,
}: {
  selected: readonly string[];
  isAllowed: (permission: string) => boolean;
  onToggle: (permission: string) => void;
  readOnly?: boolean;
  disabled?: boolean;
}) {
  const { t } = useI18n();
  const unknown = selected.filter((permission) => !isKnownPermission(permission));
  return (
    <div className="admin-permissions">
      {PERMISSION_GROUPS.map((group) => (
        <PermissionGroupView key={group.title} title={t(group.title)}>
          {group.permissions.map((permission) => {
            const checked = selected.includes(permission);
            const blocked = !checked && !isAllowed(permission);
            return (
              <PermissionRow
                key={permission}
                permission={permission}
                text={t(PERMISSION_TEXT[permission])}
                checked={checked}
                disabled={readOnly || disabled || blocked}
                note={!readOnly && blocked ? t("admin.roles.notHeld") : undefined}
                onToggle={() => onToggle(permission)}
              />
            );
          })}
        </PermissionGroupView>
      ))}
      {unknown.length === 0 ? null : (
        <PermissionGroupView title={t("admin.permissionGroup.other")}>
          {unknown.map((permission) => (
            <PermissionRow
              key={permission}
              permission={permission}
              text={t("admin.roles.unknownPermission")}
              checked
              disabled
              onToggle={() => undefined}
            />
          ))}
        </PermissionGroupView>
      )}
    </div>
  );
}

function PermissionGroupView({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="admin-fieldset admin-permissions__group">
      <legend className="admin-permissions__title">{title}</legend>
      {children}
    </fieldset>
  );
}

function PermissionRow({
  permission,
  text,
  checked,
  disabled,
  note,
  onToggle,
}: {
  permission: string;
  text: string;
  checked: boolean;
  disabled: boolean;
  note?: string | undefined;
  onToggle: () => void;
}) {
  const id = useId();
  return (
    <div className="admin-permission">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-describedby={`${id}-text`}
        onChange={onToggle}
      />
      <label htmlFor={id} className="admin-permission__label">
        <code>{permission}</code>
      </label>
      <p className="admin-permission__text" id={`${id}-text`}>
        {text}
        {note === undefined ? null : <span className="admin-permission__note"> {note}</span>}
      </p>
    </div>
  );
}
