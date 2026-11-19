import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { isComposingKey } from "../../lib/ime";
import { useOrgPermissions } from "../../org/useOrg";
import { listMembers, MAX_PAGE_SIZE } from "../admin/api";
import { REPORTS_KEY, type ReportsStatus } from "./api";
import { type DraftRecipient, initials, looksLikeEmail } from "./model";
import "../alerting/alerting.css";
import "./reports.css";

/** Every member of the organization, for the picker; read page by page. */
async function allMembers(orgId: string, signal: AbortSignal) {
  const all: { userId: string; name: string; email: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await listMembers(orgId, cursor, MAX_PAGE_SIZE, signal);
    all.push(...page.items.map(({ userId, name, email }) => ({ userId, name, email })));
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return all;
}

/**
 * The recipients of a report (board Reports.dc.html, frames 2 and 3): members and outside
 * addresses as chips with a remove button each, and one field that takes a person's name or an
 * address. The server decides who may receive the report; its refusal shows here, at the chip it
 * names.
 */
export function RecipientsField({
  id,
  orgId,
  recipients,
  onChange,
  error,
  errorIndex,
  status,
  disabled,
}: {
  id: string;
  orgId: string;
  recipients: readonly DraftRecipient[];
  onChange: (recipients: DraftRecipient[]) => void;
  /** The field's error: the browser's own check or the server's refusal. */
  error: string | undefined;
  /** The recipient the server's refusal names. */
  errorIndex: number | undefined;
  status: ReportsStatus | undefined;
  disabled: boolean;
}) {
  const { t } = useI18n();
  const permissions = useOrgPermissions();
  const canList = permissions.has("users:read");
  const members = useQuery({
    queryKey: [REPORTS_KEY, orgId, "members"],
    queryFn: ({ signal }) => allMembers(orgId, signal),
    enabled: canList && orgId !== "" && !disabled,
    staleTime: 60_000,
  });
  const [text, setText] = useState("");
  const [own, setOwn] = useState<string | undefined>(undefined);
  const chosen = new Set(recipients.map((recipient) => recipient.userId ?? recipient.email));
  const open = (members.data ?? []).filter((member) => !chosen.has(member.userId));
  const shownError = own ?? error;

  function add(recipient: DraftRecipient) {
    onChange([...recipients, recipient]);
    setText("");
    setOwn(undefined);
  }

  function memberFor(value: string) {
    const needle = value.trim().toLowerCase();
    return open.find(
      (member) => member.email.toLowerCase() === needle || member.name.toLowerCase() === needle,
    );
  }

  function submit() {
    const value = text.trim();
    if (value === "") return;
    const member = memberFor(value);
    if (member !== undefined) {
      add(member);
    } else if (chosen.has(value.toLowerCase())) {
      setOwn(t("reports.reason.recipient_duplicate"));
    } else if (!looksLikeEmail(value)) {
      setOwn(t("reports.reason.recipient_email_invalid"));
    } else if (status !== undefined && !status.allowExternalRecipients) {
      setOwn(t("reports.reason.external_not_allowed"));
    } else {
      add({ email: value.toLowerCase() });
    }
  }

  return (
    <div className="report-recipients">
      {recipients.length === 0 ? null : (
        <ul className="report-chips" aria-label={t("reports.col.recipients")}>
          {recipients.map((recipient, index) => {
            const name = recipient.name ?? recipient.email;
            return (
              <li
                key={recipient.userId ?? recipient.email}
                className={
                  index === errorIndex ? "report-chip report-chip--refused" : "report-chip"
                }
              >
                <span className="report-chip__mark" aria-hidden="true">
                  {recipient.userId === undefined ? "@" : initials(name)}
                </span>
                <span className="report-chip__name" title={recipient.email}>
                  {name}
                </span>
                {index === errorIndex ? (
                  <span className="visually-hidden">{t("reports.recipients.refused")}</span>
                ) : null}
                <button
                  type="button"
                  className="alert-chip__remove"
                  aria-label={t("reports.recipients.remove", { name })}
                  onClick={() => {
                    onChange(recipients.filter((_, i) => i !== index));
                    setOwn(undefined);
                  }}
                >
                  <Icon name="close" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="report-recipients__add">
        <label className="visually-hidden" htmlFor={id}>
          {t("reports.recipients.add")}
        </label>
        <input
          id={id}
          className="input"
          list={`${id}-members`}
          value={text}
          placeholder={t("reports.recipients.add")}
          autoComplete="off"
          aria-invalid={shownError === undefined ? undefined : true}
          aria-describedby={shownError === undefined ? undefined : `${id}-error`}
          onChange={(event) => {
            const value = event.target.value;
            setOwn(undefined);
            // Picked from the list: a member's whole address arrives at once.
            const member = open.find((item) => item.email === value);
            if (member !== undefined && value.length - text.length > 1) {
              add(member);
            } else {
              setText(value);
            }
          }}
          onKeyDown={(event) => {
            if (isComposingKey(event)) return;
            if (event.key === "Enter") {
              event.preventDefault();
              submit();
            }
          }}
        />
        <datalist id={`${id}-members`}>
          {open.map((member) => (
            <option key={member.userId} value={member.email}>
              {member.name}
            </option>
          ))}
        </datalist>
        <button type="button" className="button button--secondary" onClick={submit}>
          {t("reports.recipients.addButton")}
        </button>
      </div>
      {shownError === undefined ? null : (
        <p className="field__error" id={`${id}-error`} role="alert">
          <Icon name="alert" />
          <span>{shownError}</span>
        </p>
      )}
    </div>
  );
}
