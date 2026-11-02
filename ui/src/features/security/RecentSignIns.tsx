import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useI18n } from "../../i18n/i18n";
import { Dialog } from "../admin/components/Dialog";
import { usePagedList } from "../admin/components/lists";
import { LoadState } from "../admin/components/Section";
import { deviceOf, fetchMySignIns, fetchUserSignIns, type SignIn, signInKeys } from "./signIns";
import "./security.css";

/** How many sign-ins the account page shows beside its cards. */
const ACCOUNT_LIMIT = 5;
/** Sign-ins per page in an admin's list. */
const ADMIN_PAGE = 20;
const DAY_MS = 24 * 3600 * 1000;

type Translate = ReturnType<typeof useI18n>["t"];

/** "Today, 08:12", "Yesterday, 19:40", "21 Oct, 07:58", or with the year when it is another. */
function useWhen(): (ms: number) => string {
  const { t, language, timeZone } = useI18n();
  const zone = timeZone === null ? {} : { timeZone };
  const time = new Intl.DateTimeFormat(language, { timeStyle: "short", ...zone });
  const day = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...zone,
  });
  const thisYear = new Intl.DateTimeFormat(language, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    ...zone,
  });
  const otherYear = new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
    ...zone,
  });
  return (ms: number) => {
    const now = Date.now();
    const at = day.format(ms);
    if (at === day.format(now)) {
      return t("security.signIns.today", { time: time.format(ms) });
    }
    if (at === day.format(now - DAY_MS)) {
      return t("security.signIns.yesterday", { time: time.format(ms) });
    }
    return at.slice(0, 4) === day.format(now).slice(0, 4)
      ? thisYear.format(ms)
      : otherYear.format(ms);
  };
}

function methodText(t: Translate, signIn: SignIn): string | null {
  switch (signIn.method) {
    case null:
      return null;
    case "password":
    case "break_glass":
      return t("security.signIns.method.password");
    case "oidc":
      return signIn.providerName ?? t("security.signIns.method.oidc");
    case "saml":
      return signIn.providerName ?? t("security.signIns.method.saml");
    case "ldap":
      return signIn.providerName ?? t("security.signIns.method.ldap");
    case "provider":
      return signIn.providerName ?? signIn.provider ?? t("security.signIns.method.provider");
  }
}

function factorText(t: Translate, factor: SignIn["secondFactor"]): string | null {
  switch (factor) {
    case "passkey":
      return t("security.signIns.factor.passkey");
    case "totp":
      return t("security.signIns.factor.totp");
    case "recovery":
      return t("security.signIns.factor.recovery");
    case "provider":
      return t("security.signIns.factor.provider");
    default:
      return null;
  }
}

function reasonText(t: Translate, reason: string | null): string {
  switch (reason) {
    case "credentials":
      return t("security.signIns.reason.credentials");
    case "disabled":
    case "sso.account_disabled":
      return t("security.signIns.reason.disabled");
    case "password_off":
      return t("security.signIns.reason.passwordOff");
    case "second_factor":
      return t("security.signIns.reason.secondFactor");
    case "sso.unmapped":
      return t("security.signIns.reason.unmapped");
    default:
      return t("security.signIns.reason.provider");
  }
}

function deviceText(t: Translate, userAgent: string | null): string | null {
  if (userAgent === null) {
    return null;
  }
  const { browser, system } = deviceOf(userAgent);
  const name = browser ?? t("security.signIns.unknownBrowser");
  if (system === "phone") {
    return t("security.signIns.devicePhone", { browser: name });
  }
  if (system === "tablet") {
    return t("security.signIns.deviceTablet", { browser: name });
  }
  return system === null ? name : t("security.signIns.device", { browser: name, system });
}

/** The lines of one sign-in: what and when, then from where (frame 4A). */
export function signInLines(
  t: Translate,
  when: (ms: number) => string,
  signIn: SignIn,
): { title: string; detail: string } {
  const how = [methodText(t, signIn), factorText(t, signIn.secondFactor)]
    .filter((part): part is string => part !== null)
    .join(" + ");
  const title = how === "" ? when(signIn.at) : `${when(signIn.at)} · ${how}`;
  const where =
    signIn.method === "break_glass"
      ? [t("security.signIns.breakGlass"), "/anmelden/lokal", signIn.address]
      : [deviceText(t, signIn.userAgent), signIn.address];
  const parts = signIn.result === "refused" ? [reasonText(t, signIn.reason), ...where] : where;
  return {
    title,
    detail: parts.filter((part): part is string => part !== null && part !== "").join(" · "),
  };
}

/** A list of sign-ins; the one of this session and refused ones carry a quiet chip. */
export function SignInList({ items, label }: { items: SignIn[]; label: string }) {
  const { t } = useI18n();
  const when = useWhen();
  if (items.length === 0) {
    return <p className="security-row__meta">{t("security.signIns.empty")}</p>;
  }
  return (
    <ul className="sign-ins" aria-label={label}>
      {items.map((signIn) => {
        const lines = signInLines(t, when, signIn);
        return (
          <li key={signIn.id} className="sign-ins__item">
            <span className="sign-ins__text">
              <span className="sign-ins__title">{lines.title}</span>
              {lines.detail === "" ? null : (
                <span className="sign-ins__detail">{lines.detail}</span>
              )}
            </span>
            {signIn.current ? (
              <span className="sign-ins__chip">{t("security.signIns.thisSession")}</span>
            ) : signIn.result === "refused" ? (
              <span className="sign-ins__chip">{t("security.signIns.refused")}</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** Beside the cards of Account > Sign-in and security (frame 4A). */
export function RecentSignIns() {
  const { t } = useI18n();
  const list = useQuery({
    queryKey: signInKeys.mine,
    queryFn: () => fetchMySignIns(ACCOUNT_LIMIT),
  });
  return (
    <aside className="security-card sign-ins-card" aria-labelledby="recent-sign-ins-title">
      <h3 id="recent-sign-ins-title" className="sign-ins-card__title">
        {t("security.signIns.title")}
      </h3>
      {list.data === undefined ? (
        <LoadState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <SignInList items={list.data.items} label={t("security.signIns.title")} />
      )}
      <Link
        to="/settings/$section"
        params={{ section: "profile" }}
        hash="sessions"
        className="sign-ins-card__link"
      >
        {t("security.signIns.allSessions")}
      </Link>
    </aside>
  );
}

/** A person's sign-ins for a server admin, from the user list. */
export function UserSignInsDialog({
  user,
  onClose,
}: {
  user: { id: string; name: string };
  onClose: () => void;
}) {
  const { t } = useI18n();
  const list = usePagedList(signInKeys.user(user.id), (cursor) =>
    fetchUserSignIns(user.id, ADMIN_PAGE, cursor),
  );
  return (
    <Dialog
      open
      wide
      title={t("security.signIns.adminTitle", { name: user.name })}
      onClose={onClose}
      footer={
        <button type="button" className="button button--secondary" onClick={onClose}>
          {t("security.dialog.close")}
        </button>
      }
    >
      <p className="admin-dialog__text">{t("security.signIns.adminLead")}</p>
      {list.items === undefined ? (
        <LoadState error={list.query.error} onRetry={() => void list.query.refetch()} />
      ) : (
        <SignInList
          items={list.items}
          label={t("security.signIns.adminTitle", { name: user.name })}
        />
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
    </Dialog>
  );
}
