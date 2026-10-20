import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useRef, useState } from "react";
import { trimWhitespace } from "../../../auth/validation";
import { TextField } from "../../../components/TextField";
import { useI18n } from "../../../i18n/i18n";
import {
  type AdminOrg,
  adminKeys,
  createOrg,
  listOrgs,
  listUsers,
  MAX_PAGE_SIZE,
  renameOrg,
} from "../api";
import { Dialog } from "../components/Dialog";
import { usePagedList } from "../components/lists";
import { NameDialog } from "../components/NameDialog";
import { Notice, useNotice } from "../components/Notice";
import { useRowKeys } from "../components/rows";
import { LoadState, Section } from "../components/Section";
import { errorText } from "../errors";
import { allowedWhen, useAdminAccess } from "../sections";
import { nameMessage } from "../validation";

/** Every organization on the server: create one with its first owner, rename. */
export function OrgsPage() {
  const { t } = useI18n();
  const access = useAdminAccess();
  const queryClient = useQueryClient();
  const list = usePagedList(adminKeys.orgs, (cursor) => listOrgs(cursor), access.isServerAdmin);
  const notice = useNotice();
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<AdminOrg | null>(null);
  const orgs = list.items ?? [];
  const keys = useRowKeys(orgs.length);

  const refresh = () => queryClient.invalidateQueries({ queryKey: adminKeys.server });

  return (
    <Section
      title="admin.orgs.title"
      lead="admin.orgs.lead"
      allowed={allowedWhen(access, access.isServerAdmin)}
      actions={
        <button type="button" className="button button--primary" onClick={() => setCreating(true)}>
          {t("admin.orgs.create")}
        </button>
      }
    >
      <Notice notice={notice.notice} onDismiss={notice.clear} />
      {list.items === undefined ? (
        <LoadState error={list.query.error} onRetry={() => void list.query.refetch()} />
      ) : (
        <ul className="admin-list" aria-label={t("admin.orgs.title")} {...keys.listProps}>
          {orgs.map((org, index) => (
            <li key={org.id} className="admin-row" {...keys.rowProps(index)}>
              <div className="admin-row__main">
                <span className="admin-row__title">{org.name}</span>
                <span className="admin-row__meta">
                  {t(org.memberCount === 1 ? "admin.orgs.memberOne" : "admin.orgs.memberMany", {
                    count: org.memberCount,
                  })}
                </span>
              </div>
              <div className="admin-row__actions">
                <button
                  type="button"
                  className="button button--secondary"
                  aria-label={t("admin.orgs.renameNamed", { name: org.name })}
                  onClick={() => setRenaming(org)}
                >
                  {t("admin.common.rename")}
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
        <CreateOrgDialog
          onClose={() => setCreating(false)}
          onCreated={async (name) => {
            setCreating(false);
            await refresh();
            notice.show({ message: t("admin.orgs.created", { name }) });
          }}
        />
      ) : null}
      {renaming === null ? null : (
        <NameDialog
          open
          title={t("admin.orgs.renameTitle")}
          label={t("admin.orgs.name")}
          initial={renaming.name}
          submitLabel={t("admin.common.save")}
          errors={{ conflict: "admin.orgs.nameTaken" }}
          onClose={() => setRenaming(null)}
          onSubmit={async (name) => {
            const org = renaming;
            await renameOrg(org.id, name);
            await refresh();
            notice.show({
              message: t("admin.orgs.renamed", { name }),
              undo: () => {
                void renameOrg(org.id, org.name)
                  .then(refresh)
                  .catch((error: unknown) => notice.showError(errorText(t, error)));
              },
            });
          }}
        />
      )}
    </Section>
  );
}

function CreateOrgDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (name: string) => void;
}) {
  const { t } = useI18n();
  const ownerId = useId();
  const users = useQuery({
    queryKey: [...adminKeys.users, "picker"],
    queryFn: () => listUsers(undefined, MAX_PAGE_SIZE),
  });
  const [name, setName] = useState("");
  const [owner, setOwner] = useState("");
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const nameRef = useRef<HTMLInputElement>(null);
  const candidates = (users.data?.items ?? []).filter((user) => !user.disabled);
  const chosen = owner === "" ? candidates[0]?.id : owner;
  const create = useMutation({
    mutationFn: (ownerUserId: string) => createOrg({ name: trimWhitespace(name), ownerUserId }),
    onSuccess: () => onCreated(trimWhitespace(name)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (create.isPending || chosen === undefined) {
      return;
    }
    const problem = nameMessage(name);
    setNameError(problem === undefined ? undefined : t(problem.key, problem.params));
    if (problem !== undefined) {
      nameRef.current?.focus();
      return;
    }
    create.mutate(chosen);
  }

  return (
    <Dialog open title={t("admin.orgs.createTitle")} onClose={onClose} initialFocus={nameRef}>
      <form className="form" noValidate onSubmit={submit}>
        <TextField
          ref={nameRef}
          label={t("admin.orgs.name")}
          autoComplete="off"
          value={name}
          onValueChange={(value) => {
            setName(value);
            setNameError(undefined);
          }}
          error={nameError}
        />
        <div className="field">
          <label className="field__label" htmlFor={ownerId}>
            {t("admin.orgs.owner")}
          </label>
          {users.data === undefined ? (
            <LoadState error={users.error} onRetry={() => void users.refetch()} />
          ) : (
            <select
              id={ownerId}
              className="select"
              value={chosen}
              onChange={(event) => setOwner(event.currentTarget.value)}
            >
              {candidates.map((user) => (
                <option key={user.id} value={user.id}>
                  {t("admin.common.nameAndEmail", { name: user.name, email: user.email })}
                </option>
              ))}
            </select>
          )}
          <p className="field__hint">{t("admin.orgs.ownerHint")}</p>
        </div>
        {create.error === null ? null : (
          <p className="admin-error" role="alert">
            {errorText(t, create.error, { conflict: "admin.orgs.nameTaken" })}
          </p>
        )}
        <div className="admin-dialog__footer">
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("admin.common.cancel")}
          </button>
          <button type="submit" className="button button--primary" aria-disabled={create.isPending}>
            {t("admin.orgs.createSubmit")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
