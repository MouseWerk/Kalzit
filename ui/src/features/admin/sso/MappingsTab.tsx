import { type UseQueryResult, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type RefObject, useId, useRef, useState } from "react";
import { isApiError } from "../../../api/client";
import { Icon } from "../../../components/Icon";
import { useI18n } from "../../../i18n/i18n";
import { Segmented } from "../../settings/rows";
import { adminKeys, listOrgs, listUsers, MAX_PAGE_SIZE } from "../api";
import { roleLabel } from "../catalog";
import { Dialog } from "../components/Dialog";
import { usePagedList } from "../components/lists";
import { useNotice } from "../components/Notice";
import { PagedSelect } from "../components/PagedSelect";
import { LoadState } from "../components/Section";
import {
  createMapping,
  DEFAULT_ROLES,
  type DefaultRole,
  deleteMapping,
  fetchMappings,
  MAPPING_ROLES,
  type Mapping,
  type MappingInput,
  type MappingPreview,
  type MappingRole,
  type Mappings,
  type ProviderSummary,
  previewMapping,
  setUnmapped,
  ssoKeys,
  type Unmapped,
  updateMapping,
} from "./api";
import { outcomeDetail, ssoErrorText } from "./texts";
import "../../settings/settings.css";
import "./sso.css";

/** The fields a mapping holds, as a mapping is sent back to undo its removal or change. */
function inputOf(mapping: Mapping): MappingInput {
  return {
    providerId: mapping.providerId,
    group: mapping.group,
    orgId: mapping.orgId,
    teamId: mapping.teamId,
    role: (MAPPING_ROLES as readonly string[]).includes(mapping.role)
      ? (mapping.role as MappingRole)
      : "viewer",
    idpDecides: mapping.idpDecides,
  };
}

/** The fields of `next` that differ from `before`. */
function changedFields(before: MappingInput, next: MappingInput): Partial<MappingInput> {
  const patch: Partial<MappingInput> = {};
  for (const key of Object.keys(next) as (keyof MappingInput)[]) {
    if (before[key] !== next[key]) {
      Object.assign(patch, { [key]: next[key] });
    }
  }
  return patch;
}

type Editing = { mode: "add" } | { mode: "edit"; mapping: Mapping } | null;

/**
 * The group mapping (board frame 5F): the rule for people without a matching group, the table of
 * provider groups with organization, team, role and who decides, and "Check mapping" for one
 * person. Every change applies at once with undo; it takes effect at the next sign-in.
 */
export function MappingsTab({
  providers,
  mappings,
  adding,
  onAdded,
}: {
  providers: readonly ProviderSummary[];
  mappings: UseQueryResult<Mappings>;
  adding: boolean;
  onAdded: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const notice = useNotice();
  const [editing, setEditing] = useState<Editing>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ssoKeys.mappings });

  const remove = useMutation({
    mutationFn: (mapping: Mapping) => deleteMapping(mapping.id),
    onSuccess: async (_, mapping) => {
      await refresh();
      notice.show({
        message: t("sso.mappings.removed", { group: mapping.group }),
        undo: () => restore.mutate(inputOf(mapping)),
      });
    },
    onError: (error) => notice.showError(ssoErrorText(t, error)),
  });

  const restore = useMutation({
    mutationFn: (input: MappingInput) => createMapping(input),
    onSuccess: async () => {
      await refresh();
      notice.show({ message: t("sso.mappings.undone") });
    },
    onError: (error) => notice.showError(ssoErrorText(t, error)),
  });

  const revert = useMutation({
    mutationFn: (input: { id: string; patch: Partial<MappingInput> }) =>
      updateMapping(input.id, input.patch),
    onSuccess: async () => {
      await refresh();
      notice.show({ message: t("sso.mappings.undone") });
    },
    onError: (error) => notice.showError(ssoErrorText(t, error)),
  });

  const undoCreate = useMutation({
    mutationFn: (mapping: Mapping) => deleteMapping(mapping.id),
    onSuccess: async () => {
      await refresh();
      notice.show({ message: t("sso.mappings.undone") });
    },
    onError: (error) => notice.showError(ssoErrorText(t, error)),
  });

  /** Called by the dialog once its change is stored. */
  function saved(mapping: Mapping, before: Mapping | undefined) {
    void refresh();
    setEditing(null);
    onAdded();
    if (before === undefined) {
      notice.show({
        message: t("sso.mappings.created", { group: mapping.group }),
        undo: () => undoCreate.mutate(mapping),
      });
      return;
    }
    const back = changedFields(inputOf(mapping), inputOf(before));
    notice.show({
      message: t("sso.mappings.changed", { group: mapping.group }),
      undo: () => revert.mutate({ id: mapping.id, patch: back }),
    });
  }

  if (mappings.data === undefined) {
    return <LoadState error={mappings.error} onRetry={() => void mappings.refetch()} />;
  }
  const list = mappings.data.mappings;
  const dialog = adding ? { mode: "add" as const } : editing;

  return (
    <div className="sso-stack">
      <UnmappedCard unmapped={mappings.data.unmapped} />
      {list.length === 0 ? (
        <div className="settings-card settings-card--padded">
          <h3 className="settings-row__title">{t("sso.mappings.emptyTitle")}</h3>
          <p className="settings-row__description">
            {providers.length === 0 ? t("sso.mappings.noProviders") : t("sso.mappings.emptyText")}
          </p>
        </div>
      ) : (
        <div className="settings-card">
          <div className="sso-table-wrap">
            <table className="sso-table" aria-label={t("sso.tab.mappings")}>
              <thead>
                <tr>
                  <th scope="col">{t("sso.mappings.group")}</th>
                  <th scope="col">{t("sso.mappings.org")}</th>
                  <th scope="col">{t("sso.mappings.team")}</th>
                  <th scope="col">{t("sso.mappings.role")}</th>
                  <th scope="col">{t("sso.mappings.decides")}</th>
                  <th scope="col" className="sso-table__number">
                    {t("sso.mappings.people")}
                  </th>
                  <th scope="col">
                    <span className="visually-hidden">{t("sso.providers.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.map((mapping) => (
                  <tr key={mapping.id}>
                    <td>
                      <span className="sso-provider__text">
                        <span className="sso-mono" translate="no">
                          {mapping.group}
                        </span>
                        <span className="sso-muted sso-small">{mapping.providerName}</span>
                      </span>
                    </td>
                    <td>{mapping.orgName}</td>
                    <td>{mapping.teamName ?? "–"}</td>
                    <td>{roleLabel(t, mapping.role, undefined)}</td>
                    <td>
                      {mapping.idpDecides ? (
                        <span className="sso-decides">
                          <Icon name="lock" />
                          {t("sso.mappings.idpDecides")}
                        </span>
                      ) : (
                        t("sso.mappings.kalzitAdds")
                      )}
                    </td>
                    <td className="sso-table__number">{mapping.people}</td>
                    <td className="sso-table__actions">
                      <button
                        type="button"
                        className="button button--ghost button--small"
                        aria-label={t("sso.mappings.editNamed", { group: mapping.group })}
                        onClick={() => setEditing({ mode: "edit", mapping })}
                      >
                        {t("sso.mappings.edit")}
                      </button>
                      <button
                        type="button"
                        className="button button--ghost button--small"
                        aria-label={t("sso.mappings.removeNamed", { group: mapping.group })}
                        aria-disabled={remove.isPending}
                        onClick={() => {
                          if (!remove.isPending) {
                            remove.mutate(mapping);
                          }
                        }}
                      >
                        {t("sso.mappings.remove")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <PreviewCard />
      <p className="settings-hint sso-note">{t("sso.mappings.note")}</p>
      {dialog === null ? null : (
        <MappingDialog
          providers={providers}
          mapping={dialog.mode === "edit" ? dialog.mapping : undefined}
          onClose={() => {
            setEditing(null);
            onAdded();
          }}
          onSaved={saved}
        />
      )}
    </div>
  );
}

/** "People without a matching group": take them in with a default role, or refuse them. */
function UnmappedCard({ unmapped }: { unmapped: Unmapped }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const notice = useNotice();
  const ids = useId();
  const orgs = usePagedList(
    [...adminKeys.orgs, "picker"],
    (cursor) => listOrgs(cursor, MAX_PAGE_SIZE),
    unmapped.rule === "default",
  );

  const change = useMutation({
    mutationFn: (input: { next: Unmapped; previous: Unmapped; undo: boolean }) =>
      setUnmapped(input.next),
    onMutate: (input) => {
      queryClient.setQueryData<Mappings>(ssoKeys.mappings, (current) =>
        current === undefined ? current : { ...current, unmapped: input.next },
      );
    },
    onSuccess: (_, input) => {
      void queryClient.invalidateQueries({ queryKey: ssoKeys.mappings });
      notice.show(
        input.undo
          ? { message: t("sso.mappings.undone") }
          : {
              message: t(
                input.next.rule === "refuse"
                  ? "sso.unmapped.changedRefuse"
                  : "sso.unmapped.changedDefault",
              ),
              undo: () => change.mutate({ next: input.previous, previous: input.next, undo: true }),
            },
      );
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: ssoKeys.mappings });
      notice.showError(ssoErrorText(t, error));
    },
  });

  function apply(next: Partial<Unmapped>) {
    change.mutate({ next: { ...unmapped, ...next }, previous: unmapped, undo: false });
  }

  return (
    <div className="settings-card" id="signin.unmapped">
      <div className="settings-row">
        <div className="settings-row__text">
          <h3 className="settings-row__title" id={`${ids}-rule`}>
            {t("sso.unmapped.title")}
          </h3>
          <p className="settings-row__description">{t("sso.unmapped.description")}</p>
        </div>
        <div className="settings-row__control">
          <Segmented
            labelled={{ "aria-labelledby": `${ids}-rule` }}
            value={unmapped.rule}
            options={[
              { value: "default", label: t("sso.unmapped.default") },
              { value: "refuse", label: t("sso.unmapped.refuse") },
            ]}
            onChange={(value) => apply({ rule: value === "refuse" ? "refuse" : "default" })}
          />
        </div>
      </div>
      {unmapped.rule === "default" ? (
        <div className="settings-row" id="signin.default_org">
          <div className="settings-row__text">
            <h3 className="settings-row__title">{t("sso.unmapped.defaultRole")}</h3>
            <p className="settings-row__description">{t("sso.unmapped.defaultRoleHint")}</p>
          </div>
          <div className="settings-row__control">
            <label className="visually-hidden" htmlFor={`${ids}-org`}>
              {t("sso.unmapped.org")}
            </label>
            {orgs.items === undefined ? (
              <LoadState error={orgs.query.error} onRetry={() => void orgs.query.refetch()} />
            ) : (
              <select
                id={`${ids}-org`}
                className="select"
                value={unmapped.defaultOrgId ?? ""}
                onChange={(event) =>
                  apply({
                    defaultOrgId:
                      event.currentTarget.value === "" ? null : event.currentTarget.value,
                  })
                }
              >
                <option value="">{t("sso.unmapped.noOrg")}</option>
                {orgs.items.map((org) => (
                  <option key={org.id} value={org.id}>
                    {org.name}
                  </option>
                ))}
              </select>
            )}
            <label className="visually-hidden" htmlFor={`${ids}-role`}>
              {t("sso.unmapped.role")}
            </label>
            <select
              id={`${ids}-role`}
              className="select"
              value={unmapped.defaultRole}
              onChange={(event) => apply({ defaultRole: event.currentTarget.value as DefaultRole })}
            >
              {DEFAULT_ROLES.map((role) => (
                <option key={role} value={role}>
                  {roleLabel(t, role, undefined)}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** "Check mapping": what would apply to one person, from the groups of their last sign-ins. */
function PreviewCard() {
  const { t } = useI18n();
  const ids = useId();
  const [userId, setUserId] = useState("");
  const users = usePagedList([...adminKeys.users, "picker"], (cursor) =>
    listUsers(cursor, MAX_PAGE_SIZE),
  );
  const preview = useMutation({ mutationFn: (id: string) => previewMapping(id) });
  const picker = users.picker((user) => ({
    id: user.id,
    label: t("admin.common.nameAndEmail", { name: user.name, email: user.email }),
  }));
  const chosen = userId !== "" ? userId : (picker.options?.[0]?.id ?? "");

  return (
    <section className="settings-card settings-card--padded sso-preview" aria-labelledby={ids}>
      <h3 className="settings-row__title" id={ids}>
        {t("sso.preview.title")}
      </h3>
      <p className="settings-row__description">{t("sso.preview.lead")}</p>
      <div className="sso-preview__pick">
        <div className="field">
          <label className="field__label" htmlFor={`${ids}-user`}>
            {t("sso.preview.person")}
          </label>
          <PagedSelect
            id={`${ids}-user`}
            value={chosen}
            onChange={(value) => {
              setUserId(value);
              preview.reset();
            }}
            {...picker}
          />
        </div>
        <button
          type="button"
          className="button button--secondary"
          aria-disabled={chosen === "" || preview.isPending}
          onClick={() => {
            if (chosen !== "" && !preview.isPending) {
              preview.mutate(chosen);
            }
          }}
        >
          {t("sso.preview.run")}
        </button>
      </div>
      <div role="status" aria-atomic="true">
        {preview.data === undefined ? null : <PreviewResult preview={preview.data} />}
      </div>
      {preview.error === null ? null : (
        <p className="sso-alarm" role="alert">
          <Icon name="alert" />
          <span>{ssoErrorText(t, preview.error)}</span>
        </p>
      )}
    </section>
  );
}

function PreviewResult({ preview }: { preview: MappingPreview }) {
  const { t } = useI18n();
  return (
    <div className="sso-preview__result">
      {preview.groups.length === 0 ? (
        <p className="sso-muted">{t("sso.preview.noGroups")}</p>
      ) : (
        preview.groups.map((entry) => (
          <p key={entry.providerId}>
            <span className="sso-caps">
              {t("sso.preview.groupsAt", { provider: entry.providerName })}
            </span>{" "}
            <span className="sso-mono">
              {entry.groups.length === 0 ? "–" : entry.groups.join(", ")}
            </span>
          </p>
        ))
      )}
      {preview.outcome.refused ? (
        <p>{t("sso.outcome.refused")}</p>
      ) : preview.outcome.orgs.length === 0 ? (
        <p>{t("sso.outcome.none")}</p>
      ) : (
        <ul className="sso-preview__orgs">
          {preview.outcome.orgs.map((org) => (
            <li key={org.orgId}>
              <strong>{org.orgName}</strong> · {outcomeDetail(t, org)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const MAPPING_FIELDS = ["providerId", "group", "orgId", "teamId", "role"] as const;
type MappingField = (typeof MAPPING_FIELDS)[number];

/** Adding or changing one mapping; the change applies at once and offers undo in the notice. */
function MappingDialog({
  providers,
  mapping,
  onClose,
  onSaved,
}: {
  providers: readonly ProviderSummary[];
  mapping: Mapping | undefined;
  onClose: () => void;
  onSaved: (mapping: Mapping, before: Mapping | undefined) => void;
}) {
  const { t } = useI18n();
  const ids = useId();
  const [providerId, setProviderId] = useState(mapping?.providerId ?? providers[0]?.id ?? "");
  const [group, setGroup] = useState(mapping?.group ?? "");
  const [orgId, setOrgId] = useState(mapping?.orgId ?? "");
  const [teamId, setTeamId] = useState(mapping?.teamId ?? "");
  const [role, setRole] = useState<MappingRole>(
    mapping === undefined ? "viewer" : inputOf(mapping).role,
  );
  const [idpDecides, setIdpDecides] = useState(mapping?.idpDecides ?? false);
  const [errors, setErrors] = useState<Partial<Record<MappingField, string>>>({});
  const [formError, setFormError] = useState<string | undefined>(undefined);
  const groupRef = useRef<HTMLInputElement>(null);
  const orgs = usePagedList([...adminKeys.orgs, "picker"], (cursor) =>
    listOrgs(cursor, MAX_PAGE_SIZE),
  );
  const orgPicker = orgs.picker((org) => ({ id: org.id, label: org.name }));
  const chosenOrg = orgId !== "" ? orgId : (orgPicker.options?.[0]?.id ?? "");
  // The teams come with the mappings, so a server admin outside the organization sees them too.
  const teams = useQuery({
    queryKey: ssoKeys.mappings,
    queryFn: fetchMappings,
    select: (data) => ({ items: data.orgs.find((org) => org.id === chosenOrg)?.teams ?? [] }),
    enabled: chosenOrg !== "",
  });

  const save = useMutation({
    mutationFn: async (input: MappingInput) => {
      if (mapping === undefined) {
        return createMapping(input);
      }
      return updateMapping(mapping.id, changedFields(inputOf(mapping), input));
    },
    onSuccess: (stored) => onSaved(stored, mapping),
    onError: (error) => {
      const field = isApiError(error) ? error.field : undefined;
      const text = ssoErrorText(t, error);
      if ((MAPPING_FIELDS as readonly (string | undefined)[]).includes(field)) {
        setErrors({ [field as MappingField]: text });
        setFormError(t("sso.form.checkFields"));
        if (field === "group") {
          groupRef.current?.focus();
        } else {
          document.getElementById(`${ids}-${field}`)?.focus();
        }
      } else {
        setFormError(text);
      }
    },
  });

  function submit() {
    if (save.isPending) {
      return;
    }
    setErrors({});
    setFormError(undefined);
    if (group.trim() === "") {
      setErrors({ group: t("sso.form.required") });
      setFormError(t("sso.form.checkFields"));
      groupRef.current?.focus();
      return;
    }
    save.mutate({
      providerId,
      group: group.trim(),
      orgId: chosenOrg,
      teamId: teamId === "" ? null : teamId,
      role,
      idpDecides,
    });
  }

  function errorProps(field: MappingField, hint = false) {
    const error = errors[field];
    const parts = [
      error === undefined ? null : `${ids}-${field}-error`,
      hint ? `${ids}-${field}-hint` : null,
    ]
      .filter((part) => part !== null)
      .join(" ");
    return {
      "aria-invalid": error === undefined ? undefined : true,
      "aria-describedby": parts === "" ? undefined : parts,
    };
  }

  function errorLine(field: MappingField) {
    const error = errors[field];
    return error === undefined ? null : (
      <p className="field__error" id={`${ids}-${field}-error`}>
        <Icon name="alert" />
        <span>{error}</span>
      </p>
    );
  }

  return (
    <Dialog
      open
      title={
        mapping === undefined
          ? t("sso.mappings.addTitle")
          : t("sso.mappings.editTitle", { group: mapping.group })
      }
      onClose={onClose}
      initialFocus={groupRef as RefObject<HTMLElement | null>}
      footer={
        <>
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("admin.common.cancel")}
          </button>
          <button
            type="button"
            className="button button--primary"
            aria-disabled={save.isPending}
            onClick={submit}
          >
            {t(mapping === undefined ? "sso.mappings.addSubmit" : "sso.mappings.saveSubmit")}
          </button>
        </>
      }
    >
      <form
        className="form sso-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div role="alert" aria-atomic="true">
          {formError === undefined ? null : (
            <p className="sso-alarm">
              <Icon name="alert" />
              <span>{formError}</span>
            </p>
          )}
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`${ids}-providerId`}>
            {t("sso.mappings.provider")}
          </label>
          <select
            id={`${ids}-providerId`}
            className="select"
            value={providerId}
            {...errorProps("providerId")}
            onChange={(event) => setProviderId(event.currentTarget.value)}
          >
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
          {errorLine("providerId")}
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`${ids}-group`}>
            {t("sso.mappings.group")}
          </label>
          <input
            ref={groupRef}
            id={`${ids}-group`}
            className="input input--mono"
            value={group}
            spellCheck={false}
            autoComplete="off"
            {...errorProps("group", true)}
            onChange={(event) => setGroup(event.currentTarget.value)}
          />
          <p className="field__hint" id={`${ids}-group-hint`}>
            {t("sso.mappings.groupHint")}
          </p>
          {errorLine("group")}
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`${ids}-orgId`}>
            {t("sso.mappings.org")}
          </label>
          <PagedSelect
            id={`${ids}-orgId`}
            value={chosenOrg}
            onChange={(value) => {
              setOrgId(value);
              setTeamId("");
            }}
            {...orgPicker}
          />
          {errorLine("orgId")}
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`${ids}-teamId`}>
            {t("sso.mappings.team")}
          </label>
          {teams.isError ? (
            <p className="field__hint">{t("sso.mappings.teamsUnreadable")}</p>
          ) : (
            <select
              id={`${ids}-teamId`}
              className="select"
              value={teamId}
              {...errorProps("teamId")}
              onChange={(event) => setTeamId(event.currentTarget.value)}
            >
              <option value="">{t("sso.mappings.noTeam")}</option>
              {(teams.data?.items ?? []).map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
            </select>
          )}
          {errorLine("teamId")}
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`${ids}-role`}>
            {t("sso.mappings.role")}
          </label>
          <select
            id={`${ids}-role`}
            className="select"
            value={role}
            {...errorProps("role")}
            onChange={(event) => setRole(event.currentTarget.value as MappingRole)}
          >
            {MAPPING_ROLES.map((option) => (
              <option key={option} value={option}>
                {roleLabel(t, option, undefined)}
              </option>
            ))}
          </select>
          {errorLine("role")}
        </div>
        <div className="field">
          <span className="field__label" id={`${ids}-decides`}>
            {t("sso.mappings.decides")}
          </span>
          <Segmented
            labelled={{ "aria-labelledby": `${ids}-decides` }}
            value={idpDecides ? "idp" : "kalzit"}
            options={[
              { value: "kalzit", label: t("sso.mappings.kalzitAdds") },
              { value: "idp", label: t("sso.mappings.idpDecides") },
            ]}
            onChange={(value) => setIdpDecides(value === "idp")}
          />
          <p className="field__hint">
            {t(idpDecides ? "sso.mappings.idpDecidesHint" : "sso.mappings.kalzitAddsHint")}
          </p>
        </div>
      </form>
    </Dialog>
  );
}
