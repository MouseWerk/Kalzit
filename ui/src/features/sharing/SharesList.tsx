import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Select } from "../../components/Select";
import { ToolbarMenu } from "../../components/ToolbarMenu";
import { type MessageKey, useI18n } from "../../i18n/i18n";
import { type Share, shareOf } from "./api";
import {
  dateText,
  kindText,
  type ShownStatus,
  STATUS_TEXT,
  shareName,
  shownStatus,
  suspendedText,
} from "./model";
import { ExpiryDialog, RevokeDialog } from "./ShareDialogs";
import "../admin/admin.css";
import "./sharing.css";

type KindFilter = "all" | "link" | "snapshot";

const KINDS: readonly { value: KindFilter; label: MessageKey }[] = [
  { value: "all", label: "sharing.list.all" },
  { value: "link", label: "sharing.list.links" },
  { value: "snapshot", label: "sharing.list.snapshots" },
];

const STATUSES: readonly ShownStatus[] = [
  "active",
  "expiresSoon",
  "suspended",
  "expired",
  "revoked",
];

/**
 * Public links and snapshots as a list (board Sharing.dc.html, frames 11 and 13): what was
 * shared and from which dashboard, its kind, who made it, expiry, views and the status in words.
 * Ended ones are muted and stay for 30 days. `orgName` names the organization of each row for
 * the personal list, which spans every organization.
 */
export function SharesList({
  shares,
  showCreator,
  orgName,
  maxExpiryDays,
}: {
  shares: readonly Share[];
  showCreator: boolean;
  orgName?: (orgId: string) => string | undefined;
  maxExpiryDays: number | undefined;
}) {
  const { t, language, timeZone } = useI18n();
  const searchId = useId();
  const [now] = useState(() => Date.now());
  const [text, setText] = useState("");
  const [kind, setKind] = useState<KindFilter>("all");
  const [status, setStatus] = useState<ShownStatus | "all">("all");
  const [creator, setCreator] = useState("all");
  const [managing, setManaging] = useState<{ share: Share; what: "expiry" | "revoke" } | null>(
    null,
  );

  const creators = [
    ...new Map(
      shares.flatMap((share) => {
        const item = shareOf(share);
        return item.createdBy === null || item.createdByName === null
          ? []
          : [[item.createdBy, item.createdByName] as const];
      }),
    ),
  ].sort((a, b) => a[1].localeCompare(b[1], language));

  const needle = text.trim().toLocaleLowerCase(language);
  const rows = shares.filter((share) => {
    const item = shareOf(share);
    if (kind !== "all" && share.kind !== kind) return false;
    if (status !== "all" && shownStatus(share, now) !== status) return false;
    if (creator !== "all" && item.createdBy !== creator) return false;
    if (needle === "") return true;
    return [shareName(t, share), item.dashboardTitle ?? "", item.createdByName ?? ""].some((part) =>
      part.toLocaleLowerCase(language).includes(needle),
    );
  });
  const filtered = needle !== "" || kind !== "all" || status !== "all" || creator !== "all";
  const number = new Intl.NumberFormat(language);

  return (
    <>
      <div className="share-filters">
        <div className="share-filters__search">
          <label className="visually-hidden" htmlFor={searchId}>
            {t("sharing.list.search")}
          </label>
          <input
            id={searchId}
            type="search"
            className="input"
            placeholder={t("sharing.list.search")}
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
          />
        </div>
        <fieldset className="admin-segmented">
          <legend className="visually-hidden">{t("sharing.list.kind")}</legend>
          {KINDS.map((choice) => (
            <label key={choice.value} className="admin-segmented__option">
              <input
                type="radio"
                className="visually-hidden"
                name={`${searchId}-kind`}
                checked={kind === choice.value}
                onChange={() => setKind(choice.value)}
              />
              {t(choice.label)}
            </label>
          ))}
        </fieldset>
        <Select
          value={status}
          aria-label={t("sharing.list.status")}
          onChange={(value) => setStatus(value as ShownStatus | "all")}
        >
          <option value="all">{t("sharing.list.statusAll")}</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {t(STATUS_TEXT[value])}
            </option>
          ))}
        </Select>
        {showCreator && creators.length > 1 ? (
          <Select value={creator} aria-label={t("sharing.list.creator")} onChange={setCreator}>
            <option value="all">{t("sharing.list.creatorAll")}</option>
            {creators.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </Select>
        ) : null}
        <span className="share-filters__note">{t("sharing.list.kept")}</span>
      </div>
      <div className="admin-table-card share-table-card">
        <table className="admin-table share-table">
          <thead>
            <tr>
              <th scope="col">{t("sharing.list.name")}</th>
              <th scope="col" className="share-table__wide">
                {t("sharing.list.kindColumn")}
              </th>
              {showCreator ? (
                <th scope="col" className="share-table__wide">
                  {t("sharing.list.by")}
                </th>
              ) : null}
              <th scope="col" className="share-table__wide">
                {t("sharing.list.created")}
              </th>
              <th scope="col" className="share-table__mid">
                {t("sharing.list.expires")}
              </th>
              <th scope="col" className="share-table__num share-table__mid">
                {t("sharing.list.views")}
              </th>
              <th scope="col">{t("sharing.list.statusColumn")}</th>
              <th scope="col">
                <span className="visually-hidden">{t("sharing.list.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((share) => {
              const item = shareOf(share);
              const shown = shownStatus(share, now);
              const ended = shown === "expired" || shown === "revoked";
              const name = shareName(t, share);
              const org = orgName?.(share.orgId);
              const detail =
                shown === "suspended"
                  ? suspendedText(t, item.suspendedReason)
                  : shown === "revoked" && item.revokedAt !== null
                    ? t("sharing.list.revokedOn", {
                        date: dateText(item.revokedAt, language, timeZone),
                      })
                    : undefined;
              return (
                <tr
                  key={`${share.kind}:${item.id}`}
                  className={ended ? "admin-table__row--ended" : undefined}
                >
                  <th scope="row" className="share-table__name">
                    {share.kind === "snapshot" && !ended ? (
                      <Link
                        to="/dashboards/$dashboardId/snapshots/$snapshotId"
                        params={{ dashboardId: item.dashboardId, snapshotId: item.id }}
                        className="share-table__title"
                      >
                        {name}
                      </Link>
                    ) : (
                      <span className="share-table__title">{name}</span>
                    )}
                    <span className="share-table__sub">
                      {[
                        share.kind === "snapshot"
                          ? (item.dashboardTitle ?? t("sharing.list.hiddenDashboard"))
                          : null,
                        org,
                        detail,
                      ]
                        .filter((part) => part !== null && part !== undefined)
                        .join(" · ")}
                    </span>
                    {/* Where the card is too narrow for every column, their values stand here
                        instead (sharing.css): kind and creator first, then expiry and views. */}
                    <span className="share-table__sub share-table__fold-wide">
                      {[kindText(t, share), showCreator ? item.createdByName : null]
                        .filter((part) => part !== null)
                        .join(" · ")}
                    </span>
                    <span className="share-table__sub share-table__fold-mid">
                      {t("sharing.list.expiresOn", {
                        date: dateText(item.expiresAt, language, timeZone),
                      })}
                      {" · "}
                      {t("sharing.views", { count: number.format(item.views) })}
                    </span>
                  </th>
                  <td className="share-table__nowrap share-table__wide">{kindText(t, share)}</td>
                  {showCreator ? (
                    <td className="share-table__nowrap share-table__wide">
                      {item.createdByName ?? "–"}
                    </td>
                  ) : null}
                  <td className="share-table__date share-table__wide">
                    {dateText(item.createdAt, language, timeZone)}
                  </td>
                  <td className="share-table__date share-table__mid">
                    {dateText(item.expiresAt, language, timeZone)}
                  </td>
                  <td className="share-table__num share-table__mid">{number.format(item.views)}</td>
                  <td>
                    <span className={`share-status share-status--${shown}`}>
                      {t(STATUS_TEXT[shown])}
                    </span>
                  </td>
                  <td className="share-table__actions">
                    {ended || item.status === undefined ? null : (
                      // One menu per row: two buttons each pushed the last column out of a
                      // 1280 px window.
                      <ToolbarMenu
                        label={t("sharing.list.rowMenu", { name })}
                        icon="more"
                        entries={[
                          {
                            key: "expiry",
                            label: t("sharing.expiry.title"),
                            icon: "calendar",
                            onSelect: () => setManaging({ share, what: "expiry" }),
                          },
                          { kind: "separator", key: "sep" },
                          {
                            key: "revoke",
                            label: t("sharing.revoke.confirm"),
                            icon: "trash",
                            danger: true,
                            onSelect: () => setManaging({ share, what: "revoke" }),
                          },
                        ]}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 ? (
          <p className="share-table__empty">
            {t(filtered ? "sharing.list.noMatch" : "sharing.list.none")}
          </p>
        ) : null}
      </div>
      {managing?.what === "revoke" ? (
        <RevokeDialog share={managing.share} onClose={() => setManaging(null)} />
      ) : null}
      {managing?.what === "expiry" ? (
        <ExpiryDialog
          share={managing.share}
          maxExpiryDays={maxExpiryDays}
          onClose={() => setManaging(null)}
        />
      ) : null}
    </>
  );
}
