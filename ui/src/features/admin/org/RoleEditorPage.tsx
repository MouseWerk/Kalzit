import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import {
  type FormEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { isApiError } from "../../../api/client";
import { characterCount, trimWhitespace } from "../../../auth/validation";
import { TextField } from "../../../components/TextField";
import { useI18n } from "../../../i18n/i18n";
import {
  adminKeys,
  createRole,
  listRoles,
  MAX_ROLE_DESCRIPTION,
  type Role,
  type RoleInput,
  updateRole,
} from "../api";
import {
  holdsAll,
  isBuiltInRole,
  isKnownPermission,
  OWNER_ONLY,
  PERMISSION_GROUPS,
  PERMISSION_TEXT,
  roleLabel,
} from "../catalog";
import { Notice, setFlash, useNotice } from "../components/Notice";
import { LoadState, Section } from "../components/Section";
import { errorText, ROLE_ERRORS } from "../errors";
import { type AdminAccess, allowedWhen, useAdminAccess } from "../sections";
import { nameMessage } from "../validation";
import { useRoles } from "./shared";

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
  } else if (role.builtin) {
    body = <ReadOnlyRole role={role} reason={t("admin.roles.builtinReadOnly")} />;
  } else if (!access.has("roles:write")) {
    body = <ReadOnlyRole role={role} reason={role.description} />;
  } else if (!holdsAll(access.has, role.permissions)) {
    // Changing a role also needs holding what it has now (docs/api/access.md, Roles).
    body = <ReadOnlyRole role={role} reason={t("admin.roles.aboveYou")} />;
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

function ReadOnlyRole({ role, reason }: { role: Role; reason: string }) {
  return (
    <>
      {reason === "" ? null : <p className="admin-section__lead">{reason}</p>}
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
    if (problem !== undefined) {
      return t(problem.key, problem.params);
    }
    // The server refuses the names of the built-in roles in any case (routes/roles.rs).
    return isBuiltInRole(trimWhitespace(name).toLowerCase())
      ? t("admin.roles.nameBuiltin")
      : undefined;
  };
}

function descriptionError(t: ReturnType<typeof useI18n>["t"], description: string) {
  return characterCount(description.trim()) > MAX_ROLE_DESCRIPTION
    ? t("validation.tooLong", { count: MAX_ROLE_DESCRIPTION })
    : undefined;
}

/** Whether the permission may be added: held by the user, and not one only owners have. */
function grantable(access: AdminAccess, permission: string): boolean {
  return (
    isKnownPermission(permission) && access.has(permission) && !OWNER_ONLY.includes(permission)
  );
}

/** The server error for the name or description field, if it names one of them. */
function fieldOf(error: unknown): "name" | "description" | undefined {
  if (!isApiError(error)) {
    return undefined;
  }
  return error.field === "name" || error.field === "description" ? error.field : undefined;
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
  const [errors, setErrors] = useState<{
    name?: string | undefined;
    description?: string | undefined;
  }>({});
  const nameRef = useRef<HTMLInputElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const create = useMutation({
    mutationFn: (input: RoleInput) => createRole(orgId, input),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: adminKeys.roles(orgId) });
      setFlash({ message: t("admin.roles.created", { name: created.name }) });
      await navigate({ to: "/admin/roles/$roleId", params: { roleId: created.id } });
    },
    onError: (error) => {
      const field = fieldOf(error);
      if (field !== undefined) {
        setErrors({ [field]: errorText(t, error, ROLE_ERRORS) });
        (field === "name" ? nameRef : descriptionRef).current?.focus();
      }
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (create.isPending) {
      return;
    }
    const found = { name: nameText(name), description: descriptionError(t, description) };
    setErrors(found);
    if (found.name !== undefined) {
      nameRef.current?.focus();
      return;
    }
    if (found.description !== undefined) {
      descriptionRef.current?.focus();
      return;
    }
    create.mutate({ name: trimWhitespace(name), description: description.trim(), permissions });
  }

  const formError =
    create.error === null || fieldOf(create.error) !== undefined
      ? null
      : errorText(t, create.error, ROLE_ERRORS);

  return (
    <form className="form" noValidate onSubmit={submit}>
      <TextField
        ref={nameRef}
        label={t("admin.roles.name")}
        value={name}
        autoComplete="off"
        onValueChange={(value) => {
          setName(value);
          setErrors({ ...errors, name: undefined });
        }}
        error={errors.name}
      />
      <DescriptionField
        ref={descriptionRef}
        value={description}
        error={errors.description}
        onChange={(value) => {
          setDescription(value);
          setErrors({ ...errors, description: undefined });
        }}
      />
      <PermissionPicker
        selected={permissions}
        isAllowed={(permission) => grantable(access, permission)}
        onToggle={(permission) =>
          setPermissions(
            permissions.includes(permission)
              ? permissions.filter((p) => p !== permission)
              : [...permissions, permission],
          )
        }
      />
      {formError === null ? null : (
        <p className="admin-error" role="alert">
          {formError}
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

/** Undo found the role changed by someone else since the change it would revert. */
class ChangedMeanwhile extends Error {}

function sameRole(a: RoleInput, b: RoleInput): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    [...a.permissions].sort().join(" ") === [...b.permissions].sort().join(" ")
  );
}

function inputOf(role: Role): RoleInput {
  return { name: role.name, description: role.description, permissions: role.permissions };
}

/**
 * An existing custom role the user holds every permission of. Each change is saved at once and
 * can be undone; name and description save when the field is left or Enter is pressed. Roles
 * carry no version, so undo first re-reads the role and refuses when someone changed it since.
 */
function EditRole({ role, access }: { role: Role; access: AdminAccess }) {
  const { t } = useI18n();
  const orgId = access.orgId ?? "";
  const queryClient = useQueryClient();
  const notice = useNotice();
  const nameText = useNameError();
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description);
  const [errors, setErrors] = useState<{
    name?: string | undefined;
    description?: string | undefined;
  }>({});
  // The fields follow the stored role when it changes (a save, an undo, someone else's change).
  const [shown, setShown] = useState({ name: role.name, description: role.description });
  if (shown.name !== role.name || shown.description !== role.description) {
    setShown({ name: role.name, description: role.description });
    setName(role.name);
    setDescription(role.description);
  }
  const stored = inputOf(role);
  // What was last sent, so Enter followed by leaving the field does not save the same twice.
  const lastSent = useRef<RoleInput | null>(null);
  // A change made while a save is on its way; sent when that save ends, the latest value winning.
  const queued = useRef<Partial<RoleInput> | null>(null);

  const save = useMutation({
    mutationFn: async (input: { change: Partial<RoleInput>; expected?: RoleInput }) => {
      if (input.expected !== undefined) {
        const current = (await listRoles(orgId)).find((candidate) => candidate.id === role.id);
        if (current === undefined || !sameRole(inputOf(current), input.expected)) {
          throw new ChangedMeanwhile();
        }
      }
      return updateRole(orgId, role.id, input.change);
    },
    onSuccess: async (saved, { change, expected }) => {
      await queryClient.invalidateQueries({ queryKey: adminKeys.org(orgId) });
      lastSent.current = null;
      const message = t(expected === undefined ? "admin.roles.saved" : "admin.roles.restored", {
        name: saved.name,
      });
      if (expected !== undefined) {
        notice.show({ message });
        return;
      }
      // Undo puts back the fields this change touched, if the role is still as saved here.
      const previous: Partial<RoleInput> = {};
      for (const field of Object.keys(change) as (keyof RoleInput)[]) {
        Object.assign(previous, { [field]: stored[field] });
      }
      notice.show({
        message,
        undo: () => save.mutate({ change: previous, expected: inputOf(saved) }),
      });
    },
    onError: async (error) => {
      lastSent.current = null;
      if (error instanceof ChangedMeanwhile) {
        await queryClient.invalidateQueries({ queryKey: adminKeys.roles(orgId) });
        notice.showError(t("admin.common.changedMeanwhile"));
        return;
      }
      const field = fieldOf(error);
      if (field !== undefined) {
        setErrors({ [field]: errorText(t, error, ROLE_ERRORS) });
        return;
      }
      notice.showError(errorText(t, error, ROLE_ERRORS));
    },
  });

  function apply(change: Partial<RoleInput>) {
    if (save.isPending) {
      queued.current = { ...queued.current, ...change };
      return;
    }
    const next = { ...stored, ...change };
    if (sameRole(next, stored)) {
      return;
    }
    if (lastSent.current !== null && sameRole(next, lastSent.current)) {
      return;
    }
    lastSent.current = next;
    save.mutate({ change });
  }

  // Runs after the render that ends the save, so the queued change compares with the stored role.
  const saving = save.isPending;
  useEffect(() => {
    if (saving || queued.current === null) {
      return;
    }
    const change = queued.current;
    queued.current = null;
    apply(change);
  });

  function commitName() {
    const problem = nameText(name);
    setErrors({ ...errors, name: problem });
    if (problem === undefined) {
      apply({ name: trimWhitespace(name) });
    }
  }

  function commitDescription() {
    const problem = descriptionError(t, description);
    setErrors({ ...errors, description: problem });
    if (problem === undefined) {
      apply({ description: description.trim() });
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
          setErrors({ ...errors, name: undefined });
        }}
        onBlur={commitName}
        onKeyDown={(event) => {
          // Enter also confirms an input method's candidate; that must not save.
          if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            commitName();
          }
        }}
        error={errors.name}
      />
      <DescriptionField
        value={description}
        error={errors.description}
        onChange={(value) => {
          setDescription(value);
          setErrors({ ...errors, description: undefined });
        }}
        onBlur={commitDescription}
      />
      <PermissionPicker
        selected={role.permissions}
        pending={save.isPending}
        isAllowed={(permission) => grantable(access, permission)}
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

/** The role description: several lines, at most 500 characters, with the count shown. */
function DescriptionField({
  value,
  error,
  onChange,
  onBlur,
  ref,
}: {
  value: string;
  error: string | undefined;
  onChange: (value: string) => void;
  onBlur?: () => void;
  ref?: Ref<HTMLTextAreaElement>;
}) {
  const { t } = useI18n();
  const id = useId();
  const count = characterCount(value.trim());
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {t("admin.roles.description")}
      </label>
      <textarea
        ref={ref}
        id={id}
        className="input admin-textarea"
        value={value}
        rows={3}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={`${id}-count${error === undefined ? "" : ` ${id}-error`}`}
        onChange={(event) => onChange(event.currentTarget.value)}
        onBlur={onBlur}
      />
      <p className="field__hint" id={`${id}-count`}>
        {t("admin.roles.descriptionCount", { count, max: MAX_ROLE_DESCRIPTION })}
      </p>
      {error === undefined ? null : (
        <p className="field__error" id={`${id}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The permission catalog grouped by area, with what each permission allows. Permissions the user
 * does not hold, and those only the owner role has, cannot be added.
 */
function PermissionPicker({
  selected,
  isAllowed,
  onToggle,
  readOnly = false,
  pending = false,
}: {
  selected: readonly string[];
  isAllowed: (permission: string) => boolean;
  onToggle: (permission: string) => void;
  readOnly?: boolean;
  /** A change is on its way: the boxes stay focusable but ignore clicks. */
  pending?: boolean;
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
            let note: string | undefined;
            if (!readOnly && blocked) {
              note = t(
                OWNER_ONLY.includes(permission) ? "admin.roles.ownerOnly" : "admin.roles.notHeld",
              );
            }
            return (
              <PermissionRow
                key={permission}
                permission={permission}
                text={t(PERMISSION_TEXT[permission])}
                checked={checked}
                disabled={readOnly || blocked}
                pending={pending}
                note={note}
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
  pending = false,
  note,
  onToggle,
}: {
  permission: string;
  text: string;
  checked: boolean;
  disabled: boolean;
  pending?: boolean;
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
        aria-disabled={pending || undefined}
        aria-describedby={`${id}-text`}
        onChange={() => {
          if (!pending) {
            onToggle();
          }
        }}
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
