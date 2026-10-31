import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useId, useRef, useState } from "react";
import { isApiError } from "../../../api/client";
import { TextField } from "../../../components/TextField";
import { type Translate, useI18n } from "../../../i18n/i18n";
import { zoneOption } from "../../../lib/timeSettings";
import { relativeTime } from "../../../shell/startData";
import { errorMessage } from "../../dashboards/ui/errors";
import {
  type ApiToken,
  adminKeys,
  type CreatedToken,
  createApiToken,
  createScimToken,
  createServiceAccount,
  deleteServiceAccount,
  fetchScimStatus,
  fetchServiceAccount,
  listServiceAccounts,
  revokeApiToken,
  revokeScimToken,
  type ScimLastError,
  type ServiceAccount,
  setScimEnabled,
  updateServiceAccount,
} from "../api";
import { roleLabel } from "../catalog";
import { ConfirmDialog, Dialog } from "../components/Dialog";
import { formatDateTime, startOfDay, startOfNextDay } from "../components/format";
import { usePagedList } from "../components/lists";
import { useNotice } from "../components/Notice";
import { LoadState, Section } from "../components/Section";
import { allowedWhen, useAdminAccess } from "../sections";
import {
  checkAllowList,
  DAY_MS,
  DEFAULT_TOKEN_DAYS,
  daysUntil,
  EXPIRY_WARNING_DAYS,
  MAX_ACCOUNT_NAME,
  MAX_TOKEN_DAYS,
  TOKEN_DAY_CHOICES,
  tokenActive,
  validAccountName,
} from "./serviceAccountRules";
import { holdsRole, RoleSelect, useRoles } from "./shared";
import "../../settings/settings.css";

/** "3 hours ago", in the short style of the lists. */
function useAgo() {
  const { t, language } = useI18n();
  const [now] = useState(() => Date.now());
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "short" });
  return {
    now,
    ago: (at: number | null) =>
      at === null
        ? t("admin.serviceAccounts.never")
        : relativeTime(format, at, now, t("admin.serviceAccounts.justNow")),
  };
}

/** Organization > Service accounts: the list, the chosen account with its tokens, and SCIM. */
export function ServiceAccountsPage() {
  const { t } = useI18n();
  const access = useAdminAccess();
  const orgId = access.orgId ?? "";
  const canManage = access.has("serviceaccounts:write");
  // The SCIM token needs every permission of an admin, as the server checks.
  const canScim = holdsRole(access, "admin", undefined);
  const roles = useRoles(access.orgId, access.has("roles:read"));
  const list = usePagedList(
    adminKeys.serviceAccounts(orgId),
    (cursor) => listServiceAccounts(orgId, cursor),
    canManage,
  );
  const [selected, setSelected] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const { now, ago } = useAgo();
  const accounts = list.items ?? [];

  return (
    <Section
      title="admin.serviceAccounts.title"
      lead="admin.serviceAccounts.lead"
      allowed={allowedWhen(access, canManage)}
      actions={
        <button type="button" className="button button--primary" onClick={() => setCreating(true)}>
          {t("admin.serviceAccounts.create")}
        </button>
      }
    >
      {list.items === undefined ? (
        <LoadState error={list.query.error} onRetry={() => void list.query.refetch()} />
      ) : accounts.length === 0 ? (
        <p className="admin-empty">{t("admin.serviceAccounts.empty")}</p>
      ) : (
        <div className="admin-table-card">
          <table className="admin-table">
            <thead>
              <tr>
                <th scope="col">{t("admin.serviceAccounts.account")}</th>
                <th scope="col">{t("admin.serviceAccounts.role")}</th>
                <th scope="col">{t("admin.serviceAccounts.tokens")}</th>
                <th scope="col">{t("admin.serviceAccounts.lastUsed")}</th>
                <th scope="col">{t("admin.serviceAccounts.createdBy")}</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((account) => (
                <tr
                  key={account.id}
                  className="admin-table__row"
                  data-selected={account.id === selected}
                >
                  <td>
                    <button
                      type="button"
                      className="admin-table__pick"
                      aria-pressed={account.id === selected}
                      onClick={() => setSelected(account.id === selected ? null : account.id)}
                    >
                      {account.name}
                    </button>
                    {account.disabled ? (
                      <span className="admin-badge">{t("admin.serviceAccounts.disabled")}</span>
                    ) : null}
                  </td>
                  <td>{roleLabel(t, account.role, roles.data)}</td>
                  <td>
                    <TokenCount t={t} account={account} now={now} />
                  </td>
                  <td className="admin-table__muted">{ago(account.lastUsedAt)}</td>
                  <td className="admin-table__muted">{account.createdByName ?? "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
      <div className="admin-sa-grid">
        {selected === null ? null : (
          <AccountDetail
            key={selected}
            orgId={orgId}
            accountId={selected}
            onClose={() => setSelected(null)}
          />
        )}
        {canScim ? <ScimCard orgId={orgId} /> : null}
      </div>
      {creating ? (
        <CreateAccountDialog
          orgId={orgId}
          onClose={() => setCreating(false)}
          onCreated={(account) => {
            setCreating(false);
            setSelected(account.id);
          }}
        />
      ) : null}
    </Section>
  );
}

function TokenCount({ t, account, now }: { t: Translate; account: ServiceAccount; now: number }) {
  if (account.activeTokens === 0) {
    return <span className="admin-table__muted">{t("admin.serviceAccounts.noTokens")}</span>;
  }
  const days = account.nextExpiry === null ? null : daysUntil(account.nextExpiry, now);
  return (
    <span className="admin-table__inline">
      {t("admin.serviceAccounts.activeTokens", { count: account.activeTokens })}
      {days !== null && days <= EXPIRY_WARNING_DAYS ? (
        <span className="admin-badge">
          {t("admin.serviceAccounts.expiresInDays", { count: days })}
        </span>
      ) : null}
    </span>
  );
}

function AccountDetail({
  orgId,
  accountId,
  onClose,
}: {
  orgId: string;
  accountId: string;
  onClose: () => void;
}) {
  const { t, language, timeZone } = useI18n();
  const access = useAdminAccess();
  const queryClient = useQueryClient();
  const roles = useRoles(access.orgId, access.has("roles:read"));
  const notice = useNotice();
  const { now, ago } = useAgo();
  const detail = useQuery({
    queryKey: adminKeys.serviceAccount(orgId, accountId),
    queryFn: () => fetchServiceAccount(orgId, accountId),
  });
  const [creatingToken, setCreatingToken] = useState(false);
  const [shown, setShown] = useState<CreatedToken | null>(null);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);
  const [deleting, setDeleting] = useState(false);
  const headingId = useId();

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: adminKeys.serviceAccounts(orgId) });

  const update = useMutation({
    mutationFn: (input: { role?: string; disabled?: boolean; undo?: () => void }) =>
      updateServiceAccount(
        orgId,
        accountId,
        input.role === undefined ? { disabled: input.disabled ?? false } : { role: input.role },
      ),
    onSuccess: async (changed, input) => {
      await refresh();
      const message =
        input.role !== undefined
          ? t("admin.serviceAccounts.roleChanged", {
              name: changed.name,
              role: roleLabel(t, changed.role, roles.data),
            })
          : t(
              changed.disabled
                ? "admin.serviceAccounts.disabledNotice"
                : "admin.serviceAccounts.enabledNotice",
              {
                name: changed.name,
              },
            );
      notice.show({ message, undo: input.undo });
    },
    onError: (error) => notice.showError(errorMessage(t, error)),
  });

  const revoke = useMutation({
    mutationFn: (token: ApiToken) => revokeApiToken(orgId, accountId, token.id),
    onSuccess: async (token) => {
      setRevoking(null);
      await refresh();
      notice.show({ message: t("admin.serviceAccounts.revoked", { name: token.name }) });
    },
  });

  const remove = useMutation({
    mutationFn: () => deleteServiceAccount(orgId, accountId),
    onSuccess: async () => {
      const name = detail.data?.name ?? "";
      setDeleting(false);
      onClose();
      await refresh();
      notice.show({ message: t("admin.serviceAccounts.deleted", { name }) });
    },
  });

  const account = detail.data;
  if (account === undefined) {
    return (
      <section className="admin-sa-card">
        <LoadState error={detail.error} onRetry={() => void detail.refetch()} />
      </section>
    );
  }
  // Nobody acts for an account whose role holds more than they do; the server refuses it too.
  const canAct = holdsRole(access, account.role, roles.data);

  return (
    <section className="admin-sa-card" aria-labelledby={headingId}>
      <div className="admin-sa-card__head">
        <div className="admin-sa-card__title">
          <h2 id={headingId}>{account.name}</h2>
          {account.description === "" ? null : (
            <p className="admin-sa-hint">{account.description}</p>
          )}
        </div>
        <button type="button" className="button button--ghost button--small" onClick={onClose}>
          {t("admin.common.close")}
        </button>
      </div>
      <div className="admin-sa-card__row">
        <div className="admin-sa-card__title">
          <h3>{t("admin.serviceAccounts.role")}</h3>
          <p className="admin-sa-hint">
            {t("admin.serviceAccounts.roleScope", { org: access.orgName ?? "" })}
          </p>
        </div>
        {canAct ? (
          <RoleSelect
            label={t("admin.serviceAccounts.roleOf", { name: account.name })}
            value={account.role}
            roles={roles.data}
            access={access}
            exclude={["owner"]}
            pending={update.isPending}
            onChange={(role) =>
              update.mutate({
                role,
                undo: () => update.mutate({ role: account.role }),
              })
            }
          />
        ) : (
          <span className="admin-badge" title={t("admin.members.aboveYou")}>
            {roleLabel(t, account.role, roles.data)}
          </span>
        )}
      </div>
      <div className="admin-sa-card__tokens">
        <div className="admin-sa-card__row admin-sa-card__row--plain">
          <h3>{t("admin.serviceAccounts.tokens")}</h3>
          {canAct ? (
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={() => setCreatingToken(true)}
            >
              {t("admin.serviceAccounts.createToken")}
            </button>
          ) : null}
        </div>
        {account.tokens.length === 0 ? (
          <p className="admin-empty">{t("admin.serviceAccounts.noTokensYet")}</p>
        ) : (
          <div className="admin-table-card">
            <table className="admin-table" aria-label={t("admin.serviceAccounts.tokens")}>
              <thead>
                <tr>
                  <th scope="col">{t("admin.serviceAccounts.token")}</th>
                  <th scope="col">{t("admin.serviceAccounts.expires")}</th>
                  <th scope="col">{t("admin.serviceAccounts.lastUsed")}</th>
                  <th scope="col">{t("admin.serviceAccounts.allowedIps")}</th>
                  <th scope="col">
                    <span className="visually-hidden">{t("admin.serviceAccounts.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {account.tokens.map((token) => {
                  const active = tokenActive(token, now);
                  const name = (
                    <td>
                      <div className={active ? "admin-table__strong" : undefined}>{token.name}</div>
                      <div className="admin-table__mono" translate="no">{`${token.prefix}…`}</div>
                    </td>
                  );
                  if (!active) {
                    const ended =
                      token.revokedAt !== null
                        ? t("admin.serviceAccounts.revokedOn", {
                            date: formatDateTime(token.revokedAt, language, timeZone),
                            name: token.revokedByName ?? "–",
                          })
                        : t("admin.serviceAccounts.expiredOn", {
                            date: formatDateTime(token.expiresAt, language, timeZone),
                          });
                    return (
                      <tr key={token.id} className="admin-table__row admin-table__row--ended">
                        {name}
                        <td colSpan={3}>{ended}</td>
                        <td />
                      </tr>
                    );
                  }
                  return (
                    <tr key={token.id} className="admin-table__row">
                      {name}
                      <td className="admin-table__nowrap">
                        {formatDateTime(token.expiresAt, language, timeZone)}
                        <div className="admin-table__muted">
                          {t("admin.serviceAccounts.inDays", {
                            count: daysUntil(token.expiresAt, now),
                          })}
                        </div>
                      </td>
                      <td className="admin-table__nowrap">
                        {ago(token.lastUsedAt)}
                        {token.lastUsedAddress === null ? null : (
                          <div className="admin-table__mono">{token.lastUsedAddress}</div>
                        )}
                      </td>
                      <td className="admin-table__mono">
                        {token.allowedIps.length === 0
                          ? t("admin.serviceAccounts.anywhere")
                          : token.allowedIps.join(", ")}
                      </td>
                      <td className="admin-table__actions">
                        {canAct ? (
                          <button
                            type="button"
                            className="button button--ghost button--small"
                            aria-label={t("admin.serviceAccounts.revokeNamed", {
                              name: token.name,
                            })}
                            onClick={() => {
                              revoke.reset();
                              setRevoking(token);
                            }}
                          >
                            {t("admin.serviceAccounts.revoke")}
                          </button>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="admin-sa-card__row admin-sa-card__row--plain">
        {access.has("audit:read") ? (
          <Link to="/admin/audit" className="button button--ghost button--small">
            {t("admin.serviceAccounts.auditLink")}
          </Link>
        ) : (
          <span />
        )}
        {canAct ? (
          <div className="admin-row__actions">
            <button
              type="button"
              className="button button--secondary button--small"
              aria-disabled={update.isPending}
              onClick={() => {
                if (!update.isPending) {
                  const disabled = !account.disabled;
                  update.mutate({ disabled, undo: () => update.mutate({ disabled: !disabled }) });
                }
              }}
            >
              {t(
                account.disabled ? "admin.serviceAccounts.enable" : "admin.serviceAccounts.disable",
              )}
            </button>
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={() => {
                remove.reset();
                setDeleting(true);
              }}
            >
              {t("admin.common.deleteAsk")}
            </button>
          </div>
        ) : null}
      </div>
      {creatingToken ? (
        <CreateTokenDialog
          orgId={orgId}
          account={account}
          onClose={() => setCreatingToken(false)}
          onCreated={async (created) => {
            setCreatingToken(false);
            setShown(created);
            await refresh();
          }}
        />
      ) : null}
      {shown === null ? null : <TokenShownDialog created={shown} onClose={() => setShown(null)} />}
      <ConfirmDialog
        open={revoking !== null}
        title={t("admin.serviceAccounts.revokeTitle", { name: revoking?.name ?? "" })}
        confirmLabel={t("admin.serviceAccounts.revoke")}
        busy={revoke.isPending}
        error={revoke.error === null ? null : errorMessage(t, revoke.error)}
        onClose={() => setRevoking(null)}
        onConfirm={() => {
          if (revoking !== null) {
            revoke.mutate(revoking);
          }
        }}
      >
        {revoking === null || revoking.lastUsedAt === null
          ? t("admin.serviceAccounts.revokeTextUnused")
          : t("admin.serviceAccounts.revokeText", {
              when: ago(revoking.lastUsedAt),
              address: revoking.lastUsedAddress ?? "–",
            })}
      </ConfirmDialog>
      <ConfirmDialog
        open={deleting}
        title={t("admin.serviceAccounts.deleteTitle")}
        confirmLabel={t("admin.common.delete")}
        busy={remove.isPending}
        error={remove.error === null ? null : errorMessage(t, remove.error)}
        onClose={() => setDeleting(false)}
        onConfirm={() => remove.mutate()}
      >
        {t("admin.serviceAccounts.deleteText", { name: account.name })}
      </ConfirmDialog>
    </section>
  );
}

function CreateAccountDialog({
  orgId,
  onClose,
  onCreated,
}: {
  orgId: string;
  onClose: () => void;
  onCreated: (account: ServiceAccount) => void;
}) {
  const { t } = useI18n();
  const access = useAdminAccess();
  const queryClient = useQueryClient();
  const roles = useRoles(access.orgId, access.has("roles:read"));
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [role, setRole] = useState("viewer");
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const nameRef = useRef<HTMLInputElement>(null);
  const roleId = useId();
  const create = useMutation({
    mutationFn: () => createServiceAccount(orgId, { name: name.trim(), description, role }),
    onSuccess: async (account) => {
      await queryClient.invalidateQueries({ queryKey: adminKeys.serviceAccounts(orgId) });
      onCreated(account);
    },
    onError: (error) => {
      if (isApiError(error) && error.field === "name") {
        setNameError(errorMessage(t, error));
        nameRef.current?.focus();
      }
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (create.isPending) {
      return;
    }
    if (!validAccountName(name.trim())) {
      setNameError(t("admin.serviceAccounts.nameRule", { max: MAX_ACCOUNT_NAME }));
      nameRef.current?.focus();
      return;
    }
    create.mutate();
  }

  const formError =
    create.error === null || (isApiError(create.error) && create.error.field === "name")
      ? null
      : errorMessage(t, create.error);

  return (
    <Dialog open title={t("admin.serviceAccounts.create")} onClose={onClose} initialFocus={nameRef}>
      <form className="form" noValidate onSubmit={onSubmit}>
        <TextField
          ref={nameRef}
          label={t("admin.serviceAccounts.name")}
          hint={t("admin.serviceAccounts.nameHint")}
          mono
          autoComplete="off"
          spellCheck={false}
          value={name}
          onValueChange={(value) => {
            setName(value);
            setNameError(undefined);
          }}
          error={nameError}
        />
        <TextField
          label={t("admin.serviceAccounts.description")}
          autoComplete="off"
          value={description}
          onValueChange={setDescription}
        />
        <div className="field">
          <label className="field__label" htmlFor={roleId}>
            {t("admin.serviceAccounts.role")}
          </label>
          <p className="field__hint">{t("admin.serviceAccounts.roleHint")}</p>
          <RoleSelect
            id={roleId}
            value={role}
            roles={roles.data}
            access={access}
            exclude={["owner"]}
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
          <button type="submit" className="button button--primary" aria-disabled={create.isPending}>
            {t("admin.serviceAccounts.createSubmit")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

type ExpiryChoice = (typeof TOKEN_DAY_CHOICES)[number] | "date";

/** `yyyy-mm-dd` of a time, for the bounds of a date input (the browser's own zone is fine here). */
function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function CreateTokenDialog({
  orgId,
  account,
  onClose,
  onCreated,
}: {
  orgId: string;
  account: ServiceAccount;
  onClose: () => void;
  onCreated: (created: CreatedToken) => void;
}) {
  const { t, language, timeZone } = useI18n();
  const [now] = useState(() => Date.now());
  const [name, setName] = useState("");
  const [choice, setChoice] = useState<ExpiryChoice>(DEFAULT_TOKEN_DAYS);
  const [date, setDate] = useState("");
  const [ips, setIps] = useState("");
  const [nameError, setNameError] = useState<string | undefined>(undefined);
  const nameRef = useRef<HTMLInputElement>(null);
  const ipsId = useId();
  const expiryId = useId();
  const dateId = useId();

  const allowList = checkAllowList(ips);
  const ipError = allowList.ok
    ? undefined
    : "tooMany" in allowList
      ? t("admin.serviceAccounts.ipTooMany")
      : t("admin.serviceAccounts.ipInvalid", { line: allowList.line, value: allowList.value });
  const expiresAt = choice === "date" ? startOfNextDay(date, timeZone) : now + choice * DAY_MS;
  const expiryValid =
    expiresAt !== undefined && expiresAt > now && expiresAt <= now + MAX_TOKEN_DAYS * DAY_MS;

  const create = useMutation({
    mutationFn: () =>
      createApiToken(orgId, account.id, {
        name: name.trim(),
        ...(choice !== "date"
          ? { expiresInDays: choice }
          : expiresAt === undefined
            ? {}
            : { expiresAt }),
        allowedIps: allowList.ok ? allowList.entries : [],
      }),
    // The token is shown once from state; the mutation keeps no copy of it.
    gcTime: 0,
    onSuccess: (created) => {
      onCreated(created);
      create.reset();
    },
    onError: (error) => {
      if (isApiError(error) && error.field === "name") {
        setNameError(errorMessage(t, error));
        nameRef.current?.focus();
      }
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (create.isPending || !allowList.ok || !expiryValid) {
      return;
    }
    if (name.trim() === "") {
      setNameError(t("admin.common.nameRequired"));
      nameRef.current?.focus();
      return;
    }
    create.mutate();
  }

  const formError =
    create.error === null || (isApiError(create.error) && create.error.field === "name")
      ? null
      : errorMessage(t, create.error);
  const choices: { value: ExpiryChoice; label: string }[] = [
    ...TOKEN_DAY_CHOICES.map((days) => ({
      value: days,
      label:
        days === MAX_TOKEN_DAYS
          ? t("admin.serviceAccounts.oneYear")
          : t("admin.serviceAccounts.days", { count: days }),
    })),
    { value: "date", label: t("admin.serviceAccounts.pickDate") },
  ];

  return (
    <Dialog
      open
      title={t("admin.serviceAccounts.tokenFor", { name: account.name })}
      onClose={onClose}
      initialFocus={nameRef}
    >
      <form className="form" noValidate onSubmit={onSubmit}>
        <TextField
          ref={nameRef}
          label={t("admin.serviceAccounts.tokenName")}
          autoComplete="off"
          value={name}
          onValueChange={(value) => {
            setName(value);
            setNameError(undefined);
          }}
          error={nameError}
        />
        <fieldset className="admin-sa-expiry">
          <legend className="field__label" id={expiryId}>
            {t("admin.serviceAccounts.expiresAfter")}
          </legend>
          <div className="admin-segmented">
            {choices.map((option) => (
              <label key={option.value} className="admin-segmented__option">
                <input
                  type="radio"
                  name={expiryId}
                  className="visually-hidden"
                  checked={choice === option.value}
                  onChange={() => setChoice(option.value)}
                />
                {option.label}
              </label>
            ))}
          </div>
          {choice === "date" ? (
            <div className="field">
              <label className="field__label" htmlFor={dateId}>
                {t("admin.serviceAccounts.expiryDate")}
              </label>
              <input
                id={dateId}
                type="date"
                className="input"
                min={isoDate(now + DAY_MS)}
                max={isoDate(now + (MAX_TOKEN_DAYS - 1) * DAY_MS)}
                value={date}
                onChange={(event) => setDate(event.currentTarget.value)}
              />
            </div>
          ) : null}
          <p className="field__hint">
            {expiryValid && expiresAt !== undefined
              ? t("admin.serviceAccounts.expiresOn", {
                  date: formatDateTime(expiresAt, language, timeZone),
                })
              : t("admin.serviceAccounts.expiryRule")}
          </p>
        </fieldset>
        <div className="field">
          <label className="field__label" htmlFor={ipsId}>
            {t("admin.serviceAccounts.allowedIpsOptional")}
          </label>
          <textarea
            id={ipsId}
            className="input admin-textarea admin-table__mono"
            rows={3}
            spellCheck={false}
            value={ips}
            aria-invalid={ipError === undefined ? undefined : true}
            aria-describedby={`${ipsId}-hint${ipError === undefined ? "" : ` ${ipsId}-error`}`}
            onChange={(event) => setIps(event.currentTarget.value)}
          />
          {ipError === undefined ? null : (
            <p className="field__error" id={`${ipsId}-error`} role="alert">
              {ipError}
            </p>
          )}
          <p className="field__hint" id={`${ipsId}-hint`}>
            {t("admin.serviceAccounts.allowedIpsHint")}
          </p>
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
          <button
            type="submit"
            className="button button--primary"
            aria-disabled={create.isPending || !allowList.ok || !expiryValid}
          >
            {t("admin.serviceAccounts.createToken")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/** The new token, shown this once; "Done" waits until the person says they saved it. */
function TokenShownDialog({ created, onClose }: { created: CreatedToken; onClose: () => void }) {
  const { t } = useI18n();
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const origin = window.location.origin;
  const example = created.token.startsWith("kz_scim_")
    ? null
    : `curl -H "Authorization: Bearer ${created.prefix}…" \\\n  ${origin}/api/orgs/…/dashboards`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(created.token);
      setCopied(true);
    } catch {
      // Without clipboard access (an insecure origin) the token can still be selected by hand.
      setCopied(false);
    }
  }

  return (
    <Dialog
      open
      title={t("admin.serviceAccounts.shownTitle")}
      onClose={onClose}
      footer={
        <button
          type="button"
          className="button button--primary"
          aria-disabled={!saved}
          onClick={() => {
            if (saved) {
              onClose();
            }
          }}
        >
          {t("admin.serviceAccounts.done")}
        </button>
      }
    >
      <div className="notice">
        <span>
          <strong>{t("admin.serviceAccounts.onlyNow")}</strong>{" "}
          {t("admin.serviceAccounts.onlyNowText")}
        </span>
      </div>
      <div className="field">
        <span className="field__label">{t("admin.serviceAccounts.token")}</span>
        <div className="admin-sa-secret">
          <span className="admin-sa-secret__text" translate="no">
            {created.token}
          </span>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => void copy()}
          >
            {t("admin.serviceAccounts.copy")}
          </button>
        </div>
        <p className="visually-hidden" role="status">
          {copied ? t("admin.serviceAccounts.copied") : ""}
        </p>
      </div>
      {example === null ? null : (
        <pre className="admin-sa-example" translate="no">
          {example}
        </pre>
      )}
      <label className="admin-check">
        <input
          type="checkbox"
          checked={saved}
          onChange={(event) => setSaved(event.currentTarget.checked)}
        />
        {t("admin.serviceAccounts.savedIt")}
      </label>
    </Dialog>
  );
}

/** The start of today in the user's time zone, where the card's counts start. */
function startOfToday(zone: string | null): number {
  const today = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...zoneOption(zone),
  }).format(new Date());
  return startOfDay(today, zone) ?? Date.now() - DAY_MS;
}

/**
 * The organization's SCIM (board Identity.dc.html, frame 8): the switch, the endpoint to copy, the
 * one token (a new one replaces the old one at once), what SCIM did today, the groups and the
 * last error.
 */
function ScimCard({ orgId }: { orgId: string }) {
  const { t, language, timeZone } = useI18n();
  const queryClient = useQueryClient();
  const access = useAdminAccess();
  const { ago } = useAgo();
  const headingId = useId();
  const switchId = useId();
  const [since] = useState(() => startOfToday(timeZone));
  const current = useQuery({
    queryKey: [...adminKeys.scim(orgId), since],
    queryFn: () => fetchScimStatus(orgId, since),
  });
  const [shown, setShown] = useState<CreatedToken | null>(null);
  const [asking, setAsking] = useState<"replace" | "revoke" | null>(null);
  const [copied, setCopied] = useState(false);
  const notice = useNotice();
  const refresh = () => queryClient.invalidateQueries({ queryKey: adminKeys.scim(orgId) });

  const create = useMutation({
    mutationFn: () => createScimToken(orgId),
    // The token is shown once from state; the mutation keeps no copy of it.
    gcTime: 0,
    onSuccess: async (created) => {
      setAsking(null);
      setShown(created);
      create.reset();
      await refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: () => revokeScimToken(orgId),
    onSuccess: async () => {
      setAsking(null);
      await refresh();
      notice.show({ message: t("admin.serviceAccounts.scimRevoked") });
    },
  });
  const toggle = useMutation({
    mutationFn: ({ enabled }: { enabled: boolean; undo?: () => void }) =>
      setScimEnabled(orgId, enabled),
    onSuccess: async (_, { enabled, undo }) => {
      await refresh();
      notice.show({
        message: t(
          enabled ? "admin.serviceAccounts.scimTurnedOn" : "admin.serviceAccounts.scimTurnedOff",
        ),
        undo,
      });
    },
    onError: (error) => notice.show({ message: errorMessage(t, error), error: true }),
  });

  async function copyEndpoint(endpoint: string) {
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopied(true);
    } catch {
      // Without clipboard access (an insecure origin) the address can still be selected by hand.
      setCopied(false);
    }
  }

  const status = current.data;
  const token = status?.token ?? null;
  return (
    <section className="admin-sa-card" aria-labelledby={headingId}>
      <div className="admin-sa-card__head">
        <div className="admin-sa-card__title">
          <h2 id={headingId}>{t("admin.serviceAccounts.scimTitle")}</h2>
          <p className="admin-sa-hint" id={`${switchId}-lead`}>
            {t("admin.serviceAccounts.scimLead")}
          </p>
        </div>
        {status === undefined ? null : (
          <input
            type="checkbox"
            role="switch"
            className="settings-switch"
            checked={status.enabled}
            aria-checked={status.enabled}
            aria-label={t("admin.serviceAccounts.scimSwitch")}
            aria-describedby={`${switchId}-lead`}
            aria-disabled={toggle.isPending ? true : undefined}
            onChange={(event) => {
              if (!toggle.isPending) {
                const enabled = event.currentTarget.checked;
                toggle.mutate({ enabled, undo: () => toggle.mutate({ enabled: !enabled }) });
              }
            }}
          />
        )}
      </div>
      <div className="admin-sa-card__body">
        {status === undefined ? (
          <LoadState error={current.error} onRetry={() => void current.refetch()} />
        ) : (
          <>
            <div className="field">
              <span className="field__label">{t("admin.serviceAccounts.scimEndpoint")}</span>
              <div className="admin-sa-secret">
                <span className="admin-sa-secret__text" translate="no">
                  {status.endpoint}
                </span>
                <button
                  type="button"
                  className="button button--ghost button--small"
                  aria-label={t("admin.serviceAccounts.scimCopyEndpoint")}
                  onClick={() => void copyEndpoint(status.endpoint)}
                >
                  {t("admin.serviceAccounts.copy")}
                </button>
              </div>
              <p className="visually-hidden" role="status">
                {copied ? t("admin.serviceAccounts.copied") : ""}
              </p>
            </div>
            {token === null ? (
              <div className="admin-sa-card__row admin-sa-card__row--plain admin-sa-card__row--flush">
                <p className="admin-empty">{t("admin.serviceAccounts.scimNone")}</p>
                <button
                  type="button"
                  className="button button--secondary button--small"
                  aria-disabled={create.isPending}
                  onClick={() => {
                    if (!create.isPending) {
                      create.mutate();
                    }
                  }}
                >
                  {t("admin.serviceAccounts.createToken")}
                </button>
              </div>
            ) : (
              <div className="admin-sa-scim">
                <div className="admin-table__inline">
                  <span className="admin-table__mono" translate="no">{`${token.prefix}…`}</span>
                  <span className="admin-badge">{t("admin.serviceAccounts.onlyToken")}</span>
                </div>
                <p className="admin-sa-hint">
                  {t(
                    token.lastUsedAt !== null && token.lastUsedAddress !== null
                      ? "admin.serviceAccounts.scimMetaFrom"
                      : "admin.serviceAccounts.scimMeta",
                    {
                      created: formatDateTime(token.createdAt, language, timeZone),
                      name: token.createdByName ?? "–",
                      expires: formatDateTime(token.expiresAt, language, timeZone),
                      used: ago(token.lastUsedAt),
                      address: token.lastUsedAddress ?? "",
                    },
                  )}
                </p>
                <div className="admin-row__actions">
                  <button
                    type="button"
                    className="button button--secondary button--small"
                    onClick={() => {
                      create.reset();
                      setAsking("replace");
                    }}
                  >
                    {t("admin.serviceAccounts.scimNew")}
                  </button>
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    onClick={() => {
                      revoke.reset();
                      setAsking("revoke");
                    }}
                  >
                    {t("admin.serviceAccounts.revoke")}
                  </button>
                </div>
              </div>
            )}
            <ul className="admin-sa-stats" aria-label={t("admin.serviceAccounts.scimActivity")}>
              <li className="admin-sa-stat">
                <span className="admin-sa-stat__label">{t("admin.serviceAccounts.scimToday")}</span>
                <span className="admin-sa-stat__value">
                  {t("admin.serviceAccounts.scimTodayValue", {
                    created: status.stats.created,
                    deactivated: status.stats.deactivated,
                  })}
                </span>
                <span className="admin-sa-stat__note">
                  {t("admin.serviceAccounts.scimTodayNote")}
                </span>
              </li>
              <li className="admin-sa-stat">
                <span className="admin-sa-stat__label">
                  {t("admin.serviceAccounts.scimGroups")}
                </span>
                <span className="admin-sa-stat__value">{status.stats.groups}</span>
                <span className="admin-sa-stat__note">
                  {t("admin.serviceAccounts.scimGroupsMapped", {
                    count: status.stats.mappedGroups,
                  })}
                </span>
              </li>
              <li className="admin-sa-stat">
                <span className="admin-sa-stat__label">
                  {t("admin.serviceAccounts.scimLastError")}
                </span>
                <span className="admin-sa-stat__value">
                  {status.stats.lastError === null ? "–" : ago(status.stats.lastError.at)}
                </span>
                <span className="admin-sa-stat__note">
                  {status.stats.lastError === null
                    ? t("admin.serviceAccounts.scimNoError")
                    : scimErrorText(t, status.stats.lastError)}
                </span>
              </li>
            </ul>
          </>
        )}
        {create.error === null || asking !== null ? null : (
          <p className="admin-error" role="alert">
            {errorMessage(t, create.error)}
          </p>
        )}
        <p className="admin-sa-hint">{t("admin.serviceAccounts.scimHint")}</p>
      </div>
      {access.has("audit:read") ? (
        <div className="admin-sa-card__row">
          <Link to="/admin/audit" className="button button--ghost button--small">
            {t("admin.serviceAccounts.auditLink")}
          </Link>
        </div>
      ) : null}
      {shown === null ? null : <TokenShownDialog created={shown} onClose={() => setShown(null)} />}
      <ConfirmDialog
        open={asking === "replace"}
        title={t("admin.serviceAccounts.scimReplaceTitle")}
        confirmLabel={t("admin.serviceAccounts.scimNew")}
        busy={create.isPending}
        error={create.error === null ? null : errorMessage(t, create.error)}
        onClose={() => setAsking(null)}
        onConfirm={() => create.mutate()}
      >
        {t("admin.serviceAccounts.scimReplaceText")}
      </ConfirmDialog>
      <ConfirmDialog
        open={asking === "revoke"}
        title={t("admin.serviceAccounts.scimRevokeTitle")}
        confirmLabel={t("admin.serviceAccounts.revoke")}
        busy={revoke.isPending}
        error={revoke.error === null ? null : errorMessage(t, revoke.error)}
        onClose={() => setAsking(null)}
        onConfirm={() => revoke.mutate()}
      >
        {t("admin.serviceAccounts.scimRevokeText")}
      </ConfirmDialog>
    </section>
  );
}

/** The reasons of refused SCIM requests the card names (docs/api/scim.md, "Reasons"). */
const SCIM_REASONS = [
  "scim.disabled",
  "scim.body_invalid",
  "scim.filter_unsupported",
  "scim.path_invalid",
  "scim.value_invalid",
  "scim.read_only",
  "scim.user_name_missing",
  "scim.user_name_taken",
  "scim.email_missing",
  "scim.email_taken",
  "scim.email_unconfirmed",
  "scim.account_linked",
  "scim.account_protected",
  "scim.last_owner",
  "scim.group_name_missing",
  "scim.group_name_taken",
  "scim.member_unknown",
] as const;

/** The last error in words: a refused token, or the reason of a refused change. */
function scimErrorText(t: Translate, error: ScimLastError): string {
  if (error.action === "api_token.refused") {
    return t("admin.serviceAccounts.scimErrorToken");
  }
  const reason = SCIM_REASONS.find((known) => known === error.reason);
  return reason === undefined
    ? t("admin.serviceAccounts.scimErrorOther", { status: error.status ?? "–" })
    : t(`admin.serviceAccounts.scimReason.${reason}`);
}
