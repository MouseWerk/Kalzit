import { useQueries, useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { FigureTile, FigureTiles } from "../../components/FigureTile";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { LoadState, Section } from "../admin/components/Section";
import { allowedWhen, useAdminAccess } from "../admin/sections";
import { type Share, shareOf, sharesQuery } from "./api";
import { useSharingLimits } from "./limits";
import { bytesText, shareName, shownStatus, suspendedText } from "./model";
import { SharesList } from "./SharesList";
import "./sharing.css";

/**
 * "Verwaltung > Freigaben" (board Sharing.dc.html, frames 11 and 12): every public link and
 * snapshot of the organization, for its admins. Links inside the organization are plain
 * addresses behind sign-in and are not listed.
 */
export function SharesPage() {
  const { t, language } = useI18n();
  const access = useAdminAccess();
  const orgId = access.orgId ?? "";
  // The server lists everyone's only for `org:write`; others have "Meine Freigaben".
  const allowed = access.has("org:write");
  const shares = useQuery({ ...sharesQuery(orgId), enabled: orgId !== "" && allowed });
  const limits = useSharingLimits(orgId);
  const [now] = useState(() => Date.now());
  const list = shares.data ?? [];
  const live = list.filter((share) => shownStatus(share, now) === "active");
  const soon = list.filter((share) => shownStatus(share, now) === "expiresSoon");
  const suspended = list.filter((share) => shownStatus(share, now) === "suspended");
  const active = [...live, ...soon];
  const activeLinks = active.filter((share) => share.kind === "link").length;
  const stored = list.reduce(
    (sum, share) =>
      share.kind === "snapshot" && share.snapshot.revokedAt === null
        ? sum + share.snapshot.sizeBytes
        : sum,
    0,
  );
  const firstSoon = soon[0];
  const firstSuspended = suspended[0];

  return (
    <Section
      title="admin.shares.title"
      lead="admin.shares.lead"
      allowed={allowedWhen(access, allowed)}
    >
      {shares.data === undefined ? (
        <LoadState error={shares.error} onRetry={() => void shares.refetch()} />
      ) : list.length === 0 ? (
        <EmptyState icon="share" title={t("sharing.empty.title")}>
          {t("sharing.empty.text")}
        </EmptyState>
      ) : (
        <>
          <FigureTiles className="share-stats" narrow>
            <FigureTile
              label={t("sharing.stats.active")}
              value={active.length}
              note={t("sharing.stats.activeNote", {
                links: activeLinks,
                snapshots: active.length - activeLinks,
              })}
            />
            <FigureTile
              label={t("sharing.stats.soon")}
              value={soon.length}
              note={firstSoon === undefined ? t("sharing.stats.none") : shareName(t, firstSoon)}
            />
            <FigureTile
              label={t("sharing.stats.suspended")}
              value={suspended.length}
              note={
                firstSuspended === undefined
                  ? t("sharing.stats.none")
                  : suspendedText(t, shareOf(firstSuspended).suspendedReason)
              }
            />
            <FigureTile
              label={t("sharing.stats.stored")}
              value={bytesText(stored, language)}
              note={t("sharing.stats.storedNote")}
            />
          </FigureTiles>
          <SharesList shares={list} showCreator maxExpiryDays={limits.maxExpiryDays} />
          <p className="share-footnote">{t("sharing.list.footnote")}</p>
        </>
      )}
    </Section>
  );
}

const appRoute = getRouteApi("/_app");

/**
 * "Konto > Meine Freigaben" (board frame 13): what the signed-in person shared, in all of their
 * organizations, with the reason when a link is suspended.
 */
export function MySharesSection() {
  const { t } = useI18n();
  const { me } = appRoute.useRouteContext();
  const results = useQueries({
    queries: me.orgs.map((org) => sharesQuery(org.id, { mine: true })),
  });
  // The first organization's limits serve the expiry dialog; the server checks its own.
  const limits = useSharingLimits(me.orgs[0]?.id ?? "");
  const [now] = useState(() => Date.now());
  const loading = results.some((result) => result.data === undefined && !result.isError);
  const failed = results.find((result) => result.isError);
  const shares: Share[] = results
    .flatMap((result) => result.data ?? [])
    .sort((a, b) => shareOf(b).createdAt - shareOf(a).createdAt);
  const suspended = shares.filter((share) => shownStatus(share, now) === "suspended");
  const orgNames = new Map(me.orgs.map((org) => [org.id, org.name]));

  if (loading) {
    return <LoadState error={null} onRetry={() => undefined} />;
  }
  if (failed !== undefined && shares.length === 0) {
    return (
      <LoadState
        error={failed.error}
        onRetry={() => {
          for (const result of results) void result.refetch();
        }}
      />
    );
  }
  if (shares.length === 0) {
    return (
      <div className="share-mine">
        <EmptyState icon="share" title={t("sharing.mine.emptyTitle")}>
          {t("sharing.mine.emptyText")}
        </EmptyState>
        <p className="share-tip">{t("sharing.mine.tip")}</p>
      </div>
    );
  }
  const firstSuspended = suspended[0];
  return (
    <div className="share-mine">
      {firstSuspended === undefined ? null : (
        <p className="share-block" role="status">
          <Icon name="info" />
          <span>
            {t(suspended.length === 1 ? "sharing.mine.suspendedOne" : "sharing.mine.suspended", {
              count: suspended.length,
              name: shareName(t, firstSuspended),
              reason: suspendedText(t, shareOf(firstSuspended).suspendedReason),
            })}
          </span>
        </p>
      )}
      <SharesList
        shares={shares}
        showCreator={false}
        maxExpiryDays={limits.maxExpiryDays}
        {...(me.orgs.length > 1 ? { orgName: (id: string) => orgNames.get(id) } : {})}
      />
      <p className="share-footnote">{t("sharing.mine.footnote", { name: me.name })}</p>
    </div>
  );
}
