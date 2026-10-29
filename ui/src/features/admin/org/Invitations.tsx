import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useId, useRef, useState } from "react";
import { isApiError } from "../../../api/client";
import { Icon } from "../../../components/Icon";
import { type Translate, useI18n } from "../../../i18n/i18n";
import { writeClipboard } from "../../../lib/clipboard";
import { errorReason } from "../../datasources/reasons";
import { adminKeys, listTeams, MAX_PAGE_SIZE } from "../api";
import { roleLabel } from "../catalog";
import { ConfirmDialog, Dialog } from "../components/Dialog";
import { formatDateTime } from "../components/format";
import { usePagedList } from "../components/lists";
import { useNotice } from "../components/Notice";
import { useRowKeys } from "../components/rows";
import { errorText } from "../errors";
import {
  createInvitations,
  type Invitation,
  type IssuedInvitation,
  invitationKeys,
  invitationLink,
  listInvitations,
  looksLikeEmail,
  MAX_INVITE_EMAILS,
  resendInvitation,
  revokeInvitation,
  splitEmails,
} from "../invitationsApi";
import { useAdminAccess } from "../sections";
import { RoleSelect, useRoles } from "./shared";
import "../admin.css";
import "./invitations.css";

/**
 * The text of a refused invitation request: the address the server names, the missing public
 * address, or what the caller may not give.
 */
export function invitationErrorText(t: Translate, error: unknown): string {
  const reason = errorReason(error);
  const email = reason?.params?.email ?? "";
  switch (reason?.reason) {
    case "mail.address_invalid":
      return t("admin.invitations.emailInvalid", { email });
    case "mail.invite_already_member":
      return t("admin.invitations.alreadyMember", { email });
    case "mail.invite_pending":
      return t("admin.invitations.alreadyInvited", { email });
    case "mail.public_url_missing":
      return t("admin.invitations.publicUrlMissing");
    case "mail.invite_role_gone":
      return t("admin.invitations.roleGone");
    case "mail.invite_expired":
      return t("admin.invitations.expiredCopy");
    case "mail.invite_link_unavailable":
      return t("admin.invitations.linkUnavailable");
    default:
      return errorText(t, error, { forbidden: "admin.members.cannotGrant" });
  }
}

/**
 * Open invitations above the members (board docs/design/blueprint/Identity.dc.html, frame 7):
 * each with its role and team, who invited, how long it is valid and how its mail went, and the
 * actions "Copy link", "Send again" and "Revoke"; expired ones are invited again or removed.
 */
export function PendingInvitations({
  orgId,
  onLinks,
}: {
  orgId: string;
  /** Shows links to pass on (no mail server). */
  onLinks: (items: IssuedInvitation[]) => void;
}) {
  const { t, language, timeZone } = useI18n();
  const access = useAdminAccess();
  const queryClient = useQueryClient();
  const roles = useRoles(access.orgId, access.has("roles:read"));
  const notice = useNotice();
  const list = usePagedList(
    invitationKeys.list(orgId),
    (cursor) => listInvitations(orgId, cursor),
    access.has("users:invite"),
  );
  const [revoking, setRevoking] = useState<Invitation | null>(null);
  const items = list.items ?? [];
  const keys = useRowKeys(items.length);
  const headingId = useId();

  const refresh = () => queryClient.invalidateQueries({ queryKey: invitationKeys.list(orgId) });

  const copy = useMutation({
    mutationFn: (invitation: Invitation) => invitationLink(orgId, invitation.id),
    onSuccess: async ({ link }, invitation) => {
      if (await writeClipboard(link)) {
        notice.show({ message: t("admin.invitations.copied") });
      } else {
        // Without a clipboard (plain HTTP), the link is shown to copy by hand.
        onLinks([{ invitation, link }]);
      }
    },
    onError: (error) => notice.showError(invitationErrorText(t, error)),
  });
  const resend = useMutation({
    mutationFn: (invitation: Invitation) => resendInvitation(orgId, invitation.id),
    onSuccess: async (issued) => {
      await refresh();
      const { invitation, link } = issued;
      if (link !== null) {
        onLinks([issued]);
      } else if (invitation.delivery === "failed") {
        notice.showError(
          t("admin.invitations.refused", {
            email: invitation.email,
            reply: invitation.deliveryDetail ?? "",
          }),
        );
      } else {
        notice.show({ message: t("admin.invitations.resent", { email: invitation.email }) });
      }
    },
    onError: (error) => notice.showError(invitationErrorText(t, error)),
  });
  const revoke = useMutation({
    mutationFn: (invitation: Invitation) => revokeInvitation(orgId, invitation.id),
    onSuccess: async (_, invitation) => {
      setRevoking(null);
      await refresh();
      notice.show({
        message:
          invitation.state === "expired"
            ? t("admin.invitations.removed", { email: invitation.email })
            : t("admin.invitations.revoked", { email: invitation.email }),
      });
    },
  });

  if (items.length === 0) {
    return null;
  }
  return (
    <section className="admin-subsection invitations" aria-labelledby={headingId}>
      <div className="admin-subsection__header">
        <h3 id={headingId} className="invitations__heading">
          {t("admin.invitations.title")}
          <span className="admin-badge">{items.length}</span>
        </h3>
        <p className="admin-section__lead">{t("admin.invitations.lead")}</p>
      </div>
      <ul className="admin-list" aria-label={t("admin.invitations.title")} {...keys.listProps}>
        {items.map((invitation, index) => {
          const expired = invitation.state === "expired";
          const role = roleLabel(t, invitation.role, roles.data);
          return (
            <li key={invitation.id} className="admin-row" {...keys.rowProps(index)}>
              <div className="admin-row__main">
                <span className="admin-row__title">{invitation.email}</span>
                <span className="admin-row__meta">
                  {invitation.teamName === null
                    ? role
                    : t("admin.invitations.roleTeam", { role, team: invitation.teamName })}
                  {invitation.invitedByName === null
                    ? null
                    : ` · ${t("admin.invitations.invitedBy", { name: invitation.invitedByName })}`}
                </span>
              </div>
              <span className="admin-row__meta">
                {expired
                  ? t("admin.invitations.expired")
                  : t("admin.invitations.validUntil", {
                      date: formatDateTime(invitation.expiresAt, language, timeZone),
                    })}
              </span>
              {expired ? null : <Delivery invitation={invitation} />}
              <div className="admin-row__actions">
                {expired ? (
                  <>
                    <button
                      type="button"
                      className="button button--secondary"
                      aria-label={t("admin.invitations.reinviteNamed", { email: invitation.email })}
                      aria-disabled={resend.isPending}
                      onClick={() => {
                        if (!resend.isPending) resend.mutate(invitation);
                      }}
                    >
                      {t("admin.invitations.reinvite")}
                    </button>
                    <button
                      type="button"
                      className="button button--ghost"
                      aria-label={t("admin.invitations.removeNamed", { email: invitation.email })}
                      onClick={() => revoke.mutate(invitation)}
                    >
                      {t("admin.invitations.remove")}
                    </button>
                  </>
                ) : (
                  <>
                    {/* Only a link to pass on is shown again; a mailed one is sent again. */}
                    {invitation.delivery !== "none" ? null : (
                      <button
                        type="button"
                        className="button button--ghost"
                        aria-label={t("admin.invitations.copyLinkNamed", {
                          email: invitation.email,
                        })}
                        aria-disabled={copy.isPending}
                        onClick={() => {
                          if (!copy.isPending) copy.mutate(invitation);
                        }}
                      >
                        <Icon name="copy" />
                        {t("admin.invitations.copyLink")}
                      </button>
                    )}
                    <button
                      type="button"
                      className="button button--ghost"
                      aria-label={t("admin.invitations.resendNamed", { email: invitation.email })}
                      aria-disabled={resend.isPending}
                      onClick={() => {
                        if (!resend.isPending) resend.mutate(invitation);
                      }}
                    >
                      {t("admin.invitations.resend")}
                    </button>
                    <button
                      type="button"
                      className="button button--ghost"
                      aria-label={t("admin.invitations.revokeNamed", { email: invitation.email })}
                      onClick={() => {
                        revoke.reset();
                        setRevoking(invitation);
                      }}
                    >
                      {t("admin.invitations.revoke")}
                    </button>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
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
      <ConfirmDialog
        open={revoking !== null}
        title={t("admin.invitations.revokeTitle")}
        confirmLabel={t("admin.invitations.revoke")}
        busy={revoke.isPending}
        error={revoke.error === null ? null : errorText(t, revoke.error)}
        onClose={() => setRevoking(null)}
        onConfirm={() => {
          if (revoking !== null) revoke.mutate(revoking);
        }}
      >
        {t("admin.invitations.revokeText", { email: revoking?.email ?? "" })}
      </ConfirmDialog>
    </section>
  );
}

/** How the invitation's mail went: text and icon, never color alone. */
function Delivery({ invitation }: { invitation: Invitation }) {
  const { t } = useI18n();
  switch (invitation.delivery) {
    case "sent":
      return (
        <span className="invitations__delivery">
          <Icon name="check" />
          {t("admin.invitations.delivery.sent")}
        </span>
      );
    case "failed":
      return (
        <span
          className="invitations__delivery invitations__delivery--failed"
          title={invitation.deliveryDetail ?? undefined}
        >
          <Icon name="alert" />
          {t("admin.invitations.delivery.failed")}
          {invitation.deliveryDetail === null ? null : (
            <span className="invitations__detail">{invitation.deliveryDetail}</span>
          )}
        </span>
      );
    case "pending":
      return (
        <span className="invitations__delivery">
          <Icon name="clock" />
          {t("admin.invitations.delivery.pending")}
        </span>
      );
    case "none":
      return (
        <span className="invitations__delivery">
          <Icon name="link" />
          {t("admin.invitations.delivery.none")}
        </span>
      );
  }
}

/**
 * "Invite people" (frame 7B): addresses separated by comma, space or line break, a role within
 * what the caller holds, and a team if they may change teams.
 */
export function InviteDialog({
  orgId,
  onClose,
  onCreated,
}: {
  orgId: string;
  onClose: () => void;
  onCreated: (created: { items: IssuedInvitation[]; mailed: boolean }) => void;
}) {
  const { t } = useI18n();
  const access = useAdminAccess();
  const roles = useRoles(access.orgId, access.has("roles:read"));
  const mayTeam = access.has("teams:members") && access.has("teams:read");
  const teams = useQuery({
    queryKey: [...adminKeys.teams(orgId), "picker"],
    queryFn: () => listTeams(orgId, undefined, MAX_PAGE_SIZE),
    enabled: mayTeam,
  });
  const [raw, setRaw] = useState("");
  const [role, setRole] = useState("viewer");
  const [team, setTeam] = useState("");
  const [emailError, setEmailError] = useState<string | undefined>(undefined);
  const emailsRef = useRef<HTMLTextAreaElement>(null);
  const ids = { emails: useId(), role: useId(), team: useId(), hint: useId(), error: useId() };
  const emails = splitEmails(raw);
  const create = useMutation({
    mutationFn: () =>
      createInvitations(orgId, { emails, role, ...(team === "" ? {} : { teamId: team }) }),
    onSuccess: onCreated,
    onError: (error) => {
      if (isApiError(error) && error.field === "emails") {
        setEmailError(invitationErrorText(t, error));
        emailsRef.current?.focus();
      }
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (create.isPending) {
      return;
    }
    const wrong = emails.find((email) => !looksLikeEmail(email));
    if (emails.length === 0) {
      setEmailError(t("admin.invitations.emailsRequired"));
    } else if (wrong !== undefined) {
      setEmailError(t("admin.invitations.emailInvalid", { email: wrong }));
    } else if (emails.length > MAX_INVITE_EMAILS) {
      setEmailError(t("admin.invitations.tooMany", { count: MAX_INVITE_EMAILS }));
    } else {
      create.mutate();
      return;
    }
    emailsRef.current?.focus();
  }

  const formError =
    create.error === null || (isApiError(create.error) && create.error.field === "emails")
      ? null
      : invitationErrorText(t, create.error);

  return (
    <Dialog
      open
      title={t("admin.invitations.dialogTitle")}
      onClose={onClose}
      initialFocus={emailsRef}
    >
      <form className="form" noValidate onSubmit={onSubmit}>
        <div className="field">
          <label className="field__label" htmlFor={ids.emails}>
            {t("admin.invitations.emails")}
          </label>
          <textarea
            ref={emailsRef}
            id={ids.emails}
            className="input admin-textarea"
            rows={3}
            spellCheck={false}
            autoCapitalize="none"
            value={raw}
            aria-invalid={emailError === undefined ? undefined : true}
            aria-describedby={emailError === undefined ? ids.hint : `${ids.error} ${ids.hint}`}
            onChange={(event) => {
              setRaw(event.currentTarget.value);
              setEmailError(undefined);
            }}
          />
          {emailError === undefined ? null : (
            <p className="field__error" id={ids.error}>
              {emailError}
            </p>
          )}
          <p className="field__hint" id={ids.hint}>
            {t("admin.invitations.emailsHint")}
          </p>
        </div>
        <div className="invitations__pair">
          <div className="field">
            <label className="field__label" htmlFor={ids.role}>
              {t("admin.members.role")}
            </label>
            <RoleSelect
              id={ids.role}
              value={role}
              roles={roles.data}
              access={access}
              onChange={setRole}
            />
          </div>
          {mayTeam ? (
            <div className="field">
              <label className="field__label" htmlFor={ids.team}>
                {t("admin.invitations.team")}
              </label>
              <select
                id={ids.team}
                className="select"
                value={team}
                onChange={(event) => setTeam(event.currentTarget.value)}
              >
                <option value="">{t("admin.invitations.noTeam")}</option>
                {(teams.data?.items ?? []).map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
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
            {emails.length > 1
              ? t("admin.invitations.submitMany", { count: emails.length })
              : t("admin.invitations.submit")}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

/**
 * Links to pass on when no mail server is set up (frame 7C): each with its own Copy button; they
 * can be copied again later from the open invitations.
 */
export function LinksDialog({
  items,
  onClose,
}: {
  items: IssuedInvitation[];
  onClose: () => void;
}) {
  const { t, language, timeZone } = useI18n();
  const access = useAdminAccess();
  const notice = useNotice();
  const doneRef = useRef<HTMLButtonElement>(null);
  const first = items[0]?.invitation;
  return (
    <Dialog
      open
      title={t("admin.invitations.createdTitle")}
      onClose={onClose}
      initialFocus={doneRef}
      footer={
        <button ref={doneRef} type="button" className="button button--primary" onClick={onClose}>
          {t("admin.invitations.done")}
        </button>
      }
    >
      <p className="admin-dialog__text">
        {t("admin.invitations.createdText", {
          date: first === undefined ? "" : formatDateTime(first.expiresAt, language, timeZone),
        })}
      </p>
      <ul className="invitations__links">
        {items.map(({ invitation, link }) =>
          link === null ? null : (
            <li key={invitation.id} className="field">
              <LinkRow
                email={invitation.email}
                link={link}
                onCopied={() => notice.show({ message: t("admin.invitations.copied") })}
              />
            </li>
          ),
        )}
      </ul>
      <p className="field__hint">
        {t("admin.invitations.laterNote")}{" "}
        {access.isServerAdmin ? (
          <Link to="/settings/$section" params={{ section: "email" }} className="admin-link-button">
            {t("admin.invitations.setUpMail")}
          </Link>
        ) : null}
      </p>
    </Dialog>
  );
}

function LinkRow({ email, link, onCopied }: { email: string; link: string; onCopied: () => void }) {
  const { t } = useI18n();
  const id = useId();
  return (
    <>
      <label className="field__label" htmlFor={id}>
        {t("admin.invitations.linkFor", { email })}
      </label>
      <div className="invitations__link">
        <input
          id={id}
          className="input input--mono"
          readOnly
          value={link}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button
          type="button"
          className="button button--secondary"
          aria-label={t("admin.invitations.copyNamed", { email })}
          onClick={async () => {
            if (await writeClipboard(link)) onCopied();
          }}
        >
          <Icon name="copy" />
          {t("admin.invitations.copy")}
        </button>
      </div>
    </>
  );
}
