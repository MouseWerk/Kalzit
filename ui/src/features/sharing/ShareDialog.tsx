import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import type { TimeRange } from "../../api/generated/shapes";
import { Icon } from "../../components/Icon";
import { Select } from "../../components/Select";
import { type MessageKey, useI18n } from "../../i18n/i18n";
import { withBase } from "../../lib/basePath";
import { showErrorToast, showToast } from "../../lib/toasts";
import { useOrgPermissions } from "../../org/useOrg";
import { VARIABLE_PARAM } from "../dashboards/links";
import { type VariableValue, valueList, valueText } from "../dashboards/model";
import { rangeLabel } from "../dashboards/rangeLabel";
import { isRelative, type TextRange, toStoredAbsolute } from "../dashboards/timeRange";
import { Dialog } from "../dashboards/ui/Dialog";
import {
  createPublicLink,
  createSnapshot,
  SHARING_KEY,
  type Share,
  shareOf,
  sharesQuery,
} from "./api";
import {
  isPublicOff,
  type PublicBlock,
  type Refusals,
  refusedMaxDays,
  type SharingLimits,
  sharingErrorText,
  useExpiryChoice,
  useSharingLimits,
} from "./limits";
import {
  afterText,
  bytesText,
  DAY_MS,
  DEFAULT_WINDOW_MS,
  dateText,
  durationText,
  expiryAt,
  fixedRangeText,
  publicUrl,
  STATUS_TEXT,
  shownStatus,
  suspendedText,
  WINDOW_CHOICES,
} from "./model";
import { ExpiryDialog, RevokeDialog } from "./ShareDialogs";
import "../admin/admin.css";
import "./sharing.css";

export interface SharedVariable {
  name: string;
  label: string;
  value: VariableValue | undefined;
}

export interface ShareDialogProps {
  orgId: string;
  dashboard: { id: string; title: string };
  /** The range on screen, as text and resolved. */
  textRange: TextRange;
  range: TimeRange;
  /** The dashboard's variables with the values on screen; constants are left out. */
  variables: readonly SharedVariable[];
  panels: readonly { id: string; title: string }[];
  onClose: () => void;
}

const TABS = ["org", "public", "snapshot"] as const;
type Tab = (typeof TABS)[number];

const TAB_LABEL: Record<Tab, MessageKey> = {
  org: "sharing.tab.org",
  public: "sharing.tab.public",
  snapshot: "sharing.tab.snapshot",
};

/** Copies the text; false when the browser does not allow the clipboard. */
async function tryCopy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

async function copyText(text: string, done: string, failed: string): Promise<void> {
  if (await tryCopy(text)) {
    showToast({ message: done });
  } else {
    showErrorToast(failed);
  }
}

/**
 * "Teilen" on a dashboard (board Sharing.dc.html, frames 1 to 5): the address for people in the
 * organization, a public link that runs the stored queries with its creator's rights, and a
 * snapshot of the results as they are now.
 */
export function ShareDialog(props: ShareDialogProps) {
  const { orgId, dashboard, onClose } = props;
  const { t } = useI18n();
  const tabsId = useId();
  const permissions = useOrgPermissions();
  const [tab, setTab] = useState<Tab>("org");
  // What the server's refusals said (a switch is off, the longest expiry); kept for all forms.
  const [refusals, setRefusals] = useState<Refusals>({});
  const limits = useSharingLimits(orgId, refusals);
  const onRefused = (error: unknown) => {
    const maxDays = refusedMaxDays(error);
    if (isPublicOff(error)) setRefusals((current) => ({ ...current, publicOff: true }));
    if (maxDays !== undefined) setRefusals((current) => ({ ...current, maxDays }));
  };
  // Revoked right here: a link or snapshot just made is not shown as made any more.
  const [revoked, setRevoked] = useState<readonly string[]>([]);
  const shares = useQuery(sharesQuery(orgId, { dashboardId: dashboard.id }));
  const [now] = useState(() => Date.now());
  const open = (shares.data ?? []).filter((share) => {
    const status = shownStatus(share, now);
    return status !== "revoked" && status !== "expired";
  });
  const links = open.filter((share) => share.kind === "link");
  const snapshots = open.filter((share) => share.kind === "snapshot");
  const counts: Record<Tab, number | null> = {
    org: null,
    public: links.length === 0 ? null : links.length,
    snapshot: snapshots.length === 0 ? null : snapshots.length,
  };
  const [managing, setManaging] = useState<{ share: Share; what: "expiry" | "revoke" } | null>(
    null,
  );

  function onTabKey(event: KeyboardEvent<HTMLDivElement>) {
    const index = TABS.indexOf(tab);
    const next =
      event.key === "ArrowRight"
        ? TABS[(index + 1) % TABS.length]
        : event.key === "ArrowLeft"
          ? TABS[(index + TABS.length - 1) % TABS.length]
          : event.key === "Home"
            ? TABS[0]
            : event.key === "End"
              ? TABS.at(-1)
              : undefined;
    if (next !== undefined) {
      event.preventDefault();
      setTab(next);
      document.getElementById(`${tabsId}-${next}-tab`)?.focus();
    }
  }

  const manage = (share: Share, what: "expiry" | "revoke") => setManaging({ share, what });

  return (
    <>
      <Dialog title={t("sharing.dialog.title", { name: dashboard.title })} onClose={onClose}>
        <div className="share">
          <div
            className="tabs share__tabs"
            role="tablist"
            aria-label={t("sharing.dialog.tabs")}
            onKeyDown={onTabKey}
          >
            {TABS.map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                id={`${tabsId}-${name}-tab`}
                className="tabs__tab"
                aria-selected={tab === name}
                aria-controls={`${tabsId}-${name}`}
                tabIndex={tab === name ? 0 : -1}
                onClick={() => setTab(name)}
              >
                {t(TAB_LABEL[name])}
                {counts[name] === null ? null : (
                  // The space keeps name and count apart for screen readers ("Snapshot 2").
                  <>
                    {" "}
                    <span className="tabs__count">{counts[name]}</span>
                  </>
                )}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id={`${tabsId}-${tab}`}
            aria-labelledby={`${tabsId}-${tab}-tab`}
            className="share__panel"
          >
            {tab === "org" ? (
              <OrgLinkTab {...props} links={links.length} snapshots={snapshots.length} />
            ) : tab === "public" ? (
              <PublicLinkTab
                {...props}
                limits={limits}
                existing={links}
                canSeeAll={permissions.has("org:write")}
                revoked={revoked}
                onRefused={onRefused}
                onManage={manage}
              />
            ) : (
              <SnapshotTab
                {...props}
                limits={limits}
                existing={snapshots}
                canInternal={permissions.has("dashboards:share")}
                revoked={revoked}
                onRefused={onRefused}
                onManage={manage}
              />
            )}
          </div>
        </div>
      </Dialog>
      {managing?.what === "revoke" ? (
        <RevokeDialog
          share={managing.share}
          onRevoked={() => setRevoked((current) => [...current, shareOf(managing.share).id])}
          onClose={() => setManaging(null)}
        />
      ) : null}
      {managing?.what === "expiry" ? (
        <ExpiryDialog
          share={managing.share}
          maxExpiryDays={limits.maxExpiryDays}
          onClose={() => setManaging(null)}
        />
      ) : null}
    </>
  );
}

/**
 * The button that takes the focus once what was just made is revoked: the buttons of the
 * "created" view are gone then, and without this the focus would fall to the page behind the
 * dialog. Runs after the question has closed and tried to hand the focus back.
 */
function useFocusAfterRevoke(revoked: boolean) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (revoked) ref.current?.focus();
  }, [revoked]);
  return ref;
}

function Footer({ note, children }: { note?: ReactNode; children: ReactNode }) {
  return (
    <div className="share__footer">
      <span className="share__footer-note">{note}</span>
      <div className="share__footer-actions">{children}</div>
    </div>
  );
}

/** One setting of the dialog: its name and what it means on the left, the control on the right. */
function Row({
  title,
  text,
  labelId,
  children,
}: {
  title: string;
  text?: ReactNode;
  labelId?: string;
  children?: ReactNode;
}) {
  return (
    <div className="share-row">
      <div className="share-row__text">
        <span className="share-row__title" id={labelId}>
          {title}
        </span>
        {text === undefined ? null : <span className="share-row__hint">{text}</span>}
      </div>
      {children === undefined ? null : <div className="share-row__control">{children}</div>}
    </div>
  );
}

function Address({ label, url, onCopy }: { label: string; url: string; onCopy: () => void }) {
  const { t } = useI18n();
  const id = useId();
  return (
    <div className="share-address">
      <label className="share-address__label" htmlFor={id}>
        {label}
      </label>
      <div className="share-address__line">
        <input
          id={id}
          className="input input--mono share-address__url"
          readOnly
          value={url}
          onFocus={(event) => event.currentTarget.select()}
        />
        <button type="button" className="button button--secondary" onClick={onCopy}>
          <Icon name="copy" />
          {t("sharing.copy")}
        </button>
      </div>
    </div>
  );
}

/** The fixed values as quiet chips; each reads as "Region: Nord". */
function ValueChips({ variables }: { variables: readonly SharedVariable[] }) {
  return (
    <ul className="share-chips">
      {variables.map((variable) => (
        <li key={variable.name} className="share-chip">
          <span className="share-chip__name">{variable.label}</span>
          <span>{valueText(variable.value)}</span>
        </li>
      ))}
    </ul>
  );
}

function OrgLinkTab({
  dashboard,
  textRange,
  range,
  variables,
  panels,
  links,
  snapshots,
  onClose,
}: ShareDialogProps & { links: number; snapshots: number }) {
  const { t, language, timeZone } = useI18n();
  const ids = useId();
  const [withRange, setWithRange] = useState(true);
  const relative = isRelative(textRange.from) || isRelative(textRange.to);
  const [fixed, setFixed] = useState(!relative);
  const [withValues, setWithValues] = useState(variables.length > 0);
  const [onlyPanel, setOnlyPanel] = useState(false);
  const [panelId, setPanelId] = useState(panels[0]?.id ?? "");

  const url = new URL(withBase(`/dashboards/${dashboard.id}`), window.location.origin);
  if (withRange) {
    url.searchParams.set("from", fixed ? toStoredAbsolute(range.from) : textRange.from);
    url.searchParams.set("to", fixed ? toStoredAbsolute(range.to) : textRange.to);
  }
  if (withValues) {
    for (const variable of variables) {
      for (const value of valueList(variable.value)) {
        url.searchParams.append(`${VARIABLE_PARAM}${variable.name}`, value);
      }
    }
  }
  if (onlyPanel && panelId !== "") {
    url.searchParams.set("viewPanel", panelId);
  }
  const label = rangeLabel(t, language, textRange, timeZone);
  const summary =
    links === 0 && snapshots === 0
      ? undefined
      : t("sharing.org.summary", {
          links: t(links === 1 ? "sharing.count.link" : "sharing.count.links", { count: links }),
          snapshots: t(snapshots === 1 ? "sharing.count.snapshot" : "sharing.count.snapshots", {
            count: snapshots,
          }),
        });

  return (
    <>
      <Address
        label={t("sharing.org.link")}
        url={url.href}
        onCopy={() =>
          void copyText(url.href, t("toolbar.share.linkCopied"), t("toolbar.share.linkFailed"))
        }
      />
      <div className="share-rows">
        <Row
          title={t("sharing.org.range")}
          labelId={`${ids}-range`}
          text={
            fixed
              ? t("sharing.org.rangeFixed", {
                  range: fixedRangeText(range, language, timeZone),
                })
              : t("sharing.org.rangeRelative", { range: label })
          }
        >
          {relative && withRange ? (
            <fieldset className="admin-segmented share-segmented">
              <legend className="visually-hidden">{t("sharing.org.rangeKind")}</legend>
              <label className="admin-segmented__option">
                <input
                  type="radio"
                  className="visually-hidden"
                  name={`${ids}-kind`}
                  checked={!fixed}
                  onChange={() => setFixed(false)}
                />
                {t("sharing.org.relative")}
              </label>
              <label className="admin-segmented__option">
                <input
                  type="radio"
                  className="visually-hidden"
                  name={`${ids}-kind`}
                  checked={fixed}
                  onChange={() => setFixed(true)}
                />
                {t("sharing.org.fixed")}
              </label>
            </fieldset>
          ) : null}
          <input
            type="checkbox"
            className="settings-switch"
            role="switch"
            aria-labelledby={`${ids}-range`}
            checked={withRange}
            aria-checked={withRange}
            onChange={(event) => setWithRange(event.currentTarget.checked)}
          />
        </Row>
        {variables.length === 0 ? null : (
          <Row
            title={t("sharing.org.values")}
            labelId={`${ids}-values`}
            text={t("sharing.org.valuesText", {
              values: variables
                .map((variable) => `${variable.label} = ${valueText(variable.value)}`)
                .join(", "),
            })}
          >
            <input
              type="checkbox"
              className="settings-switch"
              role="switch"
              aria-labelledby={`${ids}-values`}
              checked={withValues}
              aria-checked={withValues}
              onChange={(event) => setWithValues(event.currentTarget.checked)}
            />
          </Row>
        )}
        {panels.length === 0 ? null : (
          <Row
            title={t("sharing.org.panel")}
            labelId={`${ids}-panel`}
            text={t("sharing.org.panelText")}
          >
            {onlyPanel ? (
              <Select value={panelId} aria-label={t("sharing.org.panelPick")} onChange={setPanelId}>
                {panels.map((panel) => (
                  <option key={panel.id} value={panel.id}>
                    {panel.title}
                  </option>
                ))}
              </Select>
            ) : null}
            <input
              type="checkbox"
              className="settings-switch"
              role="switch"
              aria-labelledby={`${ids}-panel`}
              checked={onlyPanel}
              aria-checked={onlyPanel}
              onChange={(event) => setOnlyPanel(event.currentTarget.checked)}
            />
          </Row>
        )}
      </div>
      <p className="share-note">
        <Icon name="lock" />
        <span>{t("sharing.org.note")}</span>
      </p>
      <Footer note={summary}>
        <button type="button" className="button button--secondary" onClick={onClose}>
          {t("sharing.done")}
        </button>
      </Footer>
    </>
  );
}

const BLOCK_TEXT: Record<PublicBlock, MessageKey> = {
  server: "sharing.block.server",
  org: "sharing.block.org",
  off: "sharing.block.off",
  permission: "sharing.block.permission",
};

/** Why nothing public can be made here, in plain words, above the locked form. */
function BlockNotice({ block }: { block: PublicBlock }) {
  const { t } = useI18n();
  return (
    <p className="share-block" role="note">
      <Icon name="lock" />
      <span>{t(BLOCK_TEXT[block])}</span>
    </p>
  );
}

function ExpiryRow({
  days,
  choices,
  onDays,
  limits,
  now,
  disabled,
}: {
  days: number;
  choices: readonly number[];
  onDays: (days: number) => void;
  limits: SharingLimits;
  now: number;
  disabled: boolean;
}) {
  const { t, language, timeZone } = useI18n();
  const date = dateText(now + days * DAY_MS, language, timeZone);
  return (
    <Row
      title={t("sharing.expires")}
      text={
        disabled
          ? undefined
          : limits.maxExpiryDays === undefined
            ? // The longest expiry is the server's to say; no limit is named before it did.
              t("sharing.expiresHintPlain", { date })
            : t("sharing.expiresHint", {
                date,
                max: durationText(t, limits.maxExpiryDays * DAY_MS),
              })
      }
    >
      <Select
        value={days}
        aria-label={t("sharing.expires")}
        disabled={disabled}
        onChange={(value) => onDays(Number(value))}
      >
        {choices.map((choice) => (
          <option key={choice} value={choice}>
            {afterText(t, choice)}
          </option>
        ))}
      </Select>
    </Row>
  );
}

/** The links and snapshots already on this dashboard, with their state and what can be done. */
function ExistingList({
  title,
  shares,
  now,
  onManage,
}: {
  title: string;
  shares: readonly Share[];
  now: number;
  onManage: (share: Share, what: "expiry" | "revoke") => void;
}) {
  const { t, language, timeZone } = useI18n();
  if (shares.length === 0) {
    return null;
  }
  return (
    <section className="share-existing" aria-label={title}>
      <h3 className="share-existing__title">{title}</h3>
      <ul className="share-existing__list">
        {shares.map((share) => {
          const item = shareOf(share);
          const status = shownStatus(share, now);
          return (
            <li key={item.id} className="share-existing__item">
              <div className="share-existing__main">
                <span className="share-existing__name">
                  {share.kind === "snapshot" ? (
                    <Link
                      to="/dashboards/$dashboardId/snapshots/$snapshotId"
                      params={{ dashboardId: item.dashboardId, snapshotId: item.id }}
                    >
                      {share.snapshot.title}
                    </Link>
                  ) : (
                    t("sharing.existing.linkFrom", {
                      date: dateText(item.createdAt, language, timeZone),
                    })
                  )}
                </span>
                <span className="share-existing__meta">
                  {[
                    item.createdByName,
                    share.kind === "snapshot"
                      ? t(share.snapshot.public ? "sharing.scope.public" : "sharing.scope.org")
                      : null,
                    t("sharing.expiresOn", {
                      date: dateText(item.expiresAt, language, timeZone),
                    }),
                    t("sharing.views", { count: item.views }),
                    status === "active"
                      ? null
                      : status === "suspended"
                        ? `${t(STATUS_TEXT[status])}: ${suspendedText(t, item.suspendedReason)}`
                        : t(STATUS_TEXT[status]),
                  ]
                    .filter((part) => part !== null && part !== "")
                    .join(" · ")}
                </span>
              </div>
              {item.status === undefined ? null : (
                <div className="share-existing__actions">
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    onClick={() => onManage(share, "expiry")}
                  >
                    {t("sharing.expiry.title")}
                  </button>
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    onClick={() => onManage(share, "revoke")}
                  >
                    {t("sharing.revoke.confirm")}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

interface PublicTabProps extends ShareDialogProps {
  limits: SharingLimits;
  existing: readonly Share[];
  /** Ids revoked in this dialog. */
  revoked: readonly string[];
  /** A refusal of the server, for what it says about switches and limits. */
  onRefused: (error: unknown) => void;
  onManage: (share: Share, what: "expiry" | "revoke") => void;
}

function PublicLinkTab({
  orgId,
  dashboard,
  textRange,
  variables,
  limits,
  existing,
  canSeeAll,
  revoked,
  onRefused,
  onManage,
  onClose,
}: PublicTabProps & { canSeeAll: boolean }) {
  const { t, language, timeZone } = useI18n();
  const queryClient = useQueryClient();
  const [now] = useState(() => Date.now());
  const { days, choices, setDays } = useExpiryChoice(limits);
  const [windowMs, setWindowMs] = useState(DEFAULT_WINDOW_MS);
  const [made, setCreated] = useState<{ share: Share; url: string; copied: boolean } | null>(null);
  // Revoked since: the form is back, as if nothing had been made.
  const created = made !== null && revoked.includes(shareOf(made.share).id) ? null : made;
  const createRef = useFocusAfterRevoke(made !== null && created === null);
  const blocked = limits.block !== undefined;
  const windowText = durationText(t, windowMs, true);

  const create = useMutation({
    mutationFn: () =>
      createPublicLink(orgId, dashboard.id, {
        expiresAt: expiryAt(days, limits.maxExpiryDays),
        maxWindowMs: windowMs,
        // A fixed range on screen cannot start a live link; the dashboard's own range does then.
        ...(isRelative(textRange.from) && isRelative(textRange.to) ? { timeRange: textRange } : {}),
        variables: Object.fromEntries(
          variables.flatMap((variable) =>
            variable.value === undefined ? [] : [[variable.name, variable.value]],
          ),
        ),
      }),
    onSuccess: async ({ link, token }) => {
      const url = publicUrl("link", token);
      // Created either way; whether it is on the clipboard too depends on the browser.
      const copied = await tryCopy(url);
      setCreated({ share: { kind: "link", orgId, link }, url, copied });
      showToast({
        message: t(copied ? "sharing.public.createdCopied" : "sharing.public.created"),
      });
      await queryClient.invalidateQueries({ queryKey: [SHARING_KEY] });
    },
    onError: onRefused,
  });

  const createdId = created === null ? undefined : shareOf(created.share).id;
  const others = existing.filter((share) => shareOf(share).id !== createdId);
  const all = canSeeAll ? (
    <Link to="/admin/shares" className="share__all">
      {t("sharing.public.all")}
    </Link>
  ) : undefined;

  if (created !== null) {
    // The list's copy once it arrived: its expiry follows a change made right here.
    const link = existing.find((share) => shareOf(share).id === createdId) ?? created.share;
    const item = shareOf(link);
    return (
      <>
        <p className="share-success" role="status">
          <Icon name="check" />
          <span>
            {t(created.copied ? "sharing.public.createdCopied" : "sharing.public.created")}
          </span>
        </p>
        <Address
          label={t("sharing.public.address")}
          url={created.url}
          onCopy={() =>
            void copyText(created.url, t("sharing.copied"), t("toolbar.share.linkFailed"))
          }
        />
        <p className="share-once">{t("sharing.public.once")}</p>
        <ul className="share-facts">
          <li>{t("sharing.expiresOn", { date: dateText(item.expiresAt, language, timeZone) })}</li>
          <li>
            {t("sharing.public.window", {
              window: durationText(t, link.kind === "link" ? link.link.maxWindowMs : windowMs),
            })}
          </li>
          <li>{t("sharing.views", { count: item.views })}</li>
        </ul>
        {variables.length === 0 ? null : <ValueChips variables={variables} />}
        <div className="share__inline-actions">
          <button
            type="button"
            className="button button--secondary"
            onClick={() => onManage(link, "expiry")}
          >
            {t("sharing.expiry.title")}
          </button>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => onManage(link, "revoke")}
          >
            {t("sharing.revoke.confirm")}
          </button>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              create.reset();
              setCreated(null);
            }}
          >
            {t("sharing.public.another")}
          </button>
        </div>
        <ExistingList
          title={t("sharing.public.others")}
          shares={others}
          now={now}
          onManage={onManage}
        />
        <Footer note={all}>
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("sharing.done")}
          </button>
        </Footer>
      </>
    );
  }

  return (
    <>
      {limits.block === undefined ? (
        <p className="share-lead">{t("sharing.public.lead")}</p>
      ) : (
        <BlockNotice block={limits.block} />
      )}
      <div className="share-rows" inert={blocked} aria-disabled={blocked || undefined}>
        <ExpiryRow
          days={days}
          choices={choices}
          onDays={setDays}
          limits={limits}
          now={now}
          disabled={blocked}
        />
        <Row
          title={t("sharing.public.maxWindow")}
          text={blocked ? undefined : t("sharing.public.maxWindowHint", { window: windowText })}
        >
          <Select
            value={windowMs}
            aria-label={t("sharing.public.maxWindow")}
            disabled={blocked}
            onChange={(value) => setWindowMs(Number(value))}
          >
            {WINDOW_CHOICES.filter(
              (choice) =>
                limits.maxExpiryDays === undefined || choice <= limits.maxExpiryDays * DAY_MS,
            ).map((choice) => (
              <option key={choice} value={choice}>
                {durationText(t, choice)}
              </option>
            ))}
          </Select>
        </Row>
        <Row title={t("sharing.public.startsWith")}>
          <span className="share-value">
            {isRelative(textRange.from) && isRelative(textRange.to)
              ? rangeLabel(t, language, textRange, timeZone)
              : t("sharing.public.startsWithOwn")}
          </span>
        </Row>
        {variables.length === 0 ? null : (
          <Row title={t("sharing.public.values")} text={t("sharing.public.valuesHint")}>
            <ValueChips variables={variables} />
          </Row>
        )}
      </div>
      {blocked ? null : (
        <dl className="share-rules">
          <div>
            <dt>{t("sharing.public.can")}</dt>
            <dd>{t("sharing.public.canText")}</dd>
          </div>
          <div>
            <dt>{t("sharing.public.cannot")}</dt>
            <dd>{t("sharing.public.cannotText")}</dd>
          </div>
        </dl>
      )}
      {create.isError && !isPublicOff(create.error) ? (
        <p className="notice notice--danger" role="alert">
          {sharingErrorText(t, create.error, language)}
        </p>
      ) : null}
      <ExistingList
        title={t("sharing.public.existing")}
        shares={existing}
        now={now}
        onManage={onManage}
      />
      <Footer note={blocked ? all : (all ?? t("sharing.audited"))}>
        <button type="button" className="button button--secondary" onClick={onClose}>
          {t("dashboards.dialog.cancel")}
        </button>
        <button
          ref={createRef}
          type="button"
          className="button button--primary"
          disabled={blocked || create.isPending}
          onClick={() => create.mutate()}
        >
          {t("sharing.public.create")}
        </button>
      </Footer>
    </>
  );
}

function SnapshotTab({
  orgId,
  dashboard,
  textRange,
  range,
  variables,
  panels,
  limits,
  existing,
  canInternal,
  revoked,
  onRefused,
  onManage,
  onClose,
}: PublicTabProps & { canInternal: boolean }) {
  const { t, language, timeZone } = useI18n();
  const ids = useId();
  const queryClient = useQueryClient();
  const [now] = useState(() => Date.now());
  const [title, setTitle] = useState(() =>
    t("sharing.snapshot.defaultName", {
      name: dashboard.title,
      date: dateText(now, language, timeZone),
    }),
  );
  const { days, choices, setDays } = useExpiryChoice(limits);
  const publicBlocked = limits.block !== undefined;
  // Without the right to share inside the organization only a public snapshot is left.
  const [isPublic, setIsPublic] = useState(!canInternal && !publicBlocked);
  const [made, setCreated] = useState<{ share: Share; url: string | null } | null>(null);
  // Revoked since: the form is back, as if nothing had been made.
  const created = made !== null && revoked.includes(shareOf(made.share).id) ? null : made;
  const createRef = useFocusAfterRevoke(made !== null && created === null);
  const blocked = isPublic ? publicBlocked : !canInternal;

  const create = useMutation({
    mutationFn: () =>
      createSnapshot(orgId, dashboard.id, {
        title: title.trim() === "" ? dashboard.title : title.trim(),
        timeRange: range,
        variables: Object.fromEntries(
          variables.flatMap((variable) =>
            variable.value === undefined ? [] : [[variable.name, variable.value]],
          ),
        ),
        expiresAt: expiryAt(days, limits.maxExpiryDays),
        public: isPublic,
      }),
    onSuccess: async ({ snapshot, token }) => {
      const url = token === undefined ? null : publicUrl("snapshot", token);
      setCreated({ share: { kind: "snapshot", orgId, snapshot }, url });
      await queryClient.invalidateQueries({ queryKey: [SHARING_KEY] });
      showToast({
        message: t("sharing.snapshot.created", { size: bytesText(snapshot.sizeBytes, language) }),
      });
    },
    onError: onRefused,
  });

  if (created !== null && created.share.kind === "snapshot") {
    const snapshot = created.share.snapshot;
    const internal = new URL(
      withBase(`/dashboards/${snapshot.dashboardId}/snapshots/${snapshot.id}`),
      window.location.origin,
    ).href;
    return (
      <>
        <p className="share-success" role="status">
          <Icon name="check" />
          <span>
            {t("sharing.snapshot.created", { size: bytesText(snapshot.sizeBytes, language) })}
          </span>
        </p>
        <Address
          label={t(snapshot.public ? "sharing.snapshot.publicAddress" : "sharing.snapshot.address")}
          url={created.url ?? internal}
          onCopy={() =>
            void copyText(
              created.url ?? internal,
              t("sharing.copied"),
              t("toolbar.share.linkFailed"),
            )
          }
        />
        {snapshot.public ? <p className="share-once">{t("sharing.public.once")}</p> : null}
        <ul className="share-facts">
          <li>{fixedRangeText(snapshot.timeRange, language, timeZone)}</li>
          <li>
            {t("sharing.expiresOn", { date: dateText(snapshot.expiresAt, language, timeZone) })}
          </li>
          <li>
            {limits.snapshotMaxBytes === undefined
              ? bytesText(snapshot.sizeBytes, language)
              : t("sharing.snapshot.sizeOf", {
                  size: bytesText(snapshot.sizeBytes, language),
                  max: bytesText(limits.snapshotMaxBytes, language),
                })}
          </li>
        </ul>
        <div className="share__inline-actions">
          <Link
            to="/dashboards/$dashboardId/snapshots/$snapshotId"
            params={{ dashboardId: snapshot.dashboardId, snapshotId: snapshot.id }}
            className="button button--secondary"
          >
            {t("sharing.snapshot.open")}
          </Link>
          <button
            type="button"
            className="button button--ghost"
            onClick={() => {
              create.reset();
              setCreated(null);
            }}
          >
            {t("sharing.snapshot.another")}
          </button>
        </div>
        <ExistingList
          title={t("sharing.snapshot.others")}
          shares={existing.filter((share) => shareOf(share).id !== snapshot.id)}
          now={now}
          onManage={onManage}
        />
        <Footer>
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("sharing.done")}
          </button>
        </Footer>
      </>
    );
  }

  return (
    <>
      <div className="share-rows">
        <div className="share-row share-row--field">
          <label className="share-row__title" htmlFor={`${ids}-name`}>
            {t("sharing.snapshot.name")}
          </label>
          <input
            id={`${ids}-name`}
            className="input"
            value={title}
            maxLength={200}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
        </div>
        <ExpiryRow
          days={days}
          choices={choices}
          onDays={setDays}
          limits={limits}
          now={now}
          disabled={false}
        />
        <Row
          title={t("sharing.snapshot.who")}
          text={
            publicBlocked
              ? t(BLOCK_TEXT[limits.block ?? "off"])
              : t("sharing.snapshot.whoText", { name: dashboard.title })
          }
        >
          <fieldset className="admin-segmented share-segmented">
            <legend className="visually-hidden">{t("sharing.snapshot.who")}</legend>
            <label className="admin-segmented__option">
              <input
                type="radio"
                className="visually-hidden"
                name={`${ids}-who`}
                checked={!isPublic}
                disabled={!canInternal}
                onChange={() => setIsPublic(false)}
              />
              {t("sharing.scope.org")}
            </label>
            <label className="admin-segmented__option" aria-disabled={publicBlocked || undefined}>
              <input
                type="radio"
                className="visually-hidden"
                name={`${ids}-who`}
                checked={isPublic}
                disabled={publicBlocked}
                onChange={() => setIsPublic(true)}
              />
              {t("sharing.scope.public")}
            </label>
          </fieldset>
        </Row>
        <Row
          title={t("sharing.snapshot.range")}
          text={
            isRelative(textRange.from) || isRelative(textRange.to)
              ? t("sharing.snapshot.rangeFrom", {
                  range: rangeLabel(t, language, textRange, timeZone),
                })
              : undefined
          }
        >
          <span className="share-value">{fixedRangeText(range, language, timeZone)}</span>
        </Row>
        {variables.length === 0 ? null : (
          <Row title={t("sharing.public.values")}>
            <ValueChips variables={variables} />
          </Row>
        )}
      </div>
      <p className="share-note">
        <Icon name="info" />
        <span>
          {t("sharing.snapshot.note")}
          {limits.snapshotMaxBytes === undefined
            ? null
            : ` ${t("sharing.snapshot.noteMax", { max: bytesText(limits.snapshotMaxBytes, language) })}`}
        </span>
      </p>
      {!canInternal && !isPublic ? (
        <p className="share-block" role="note">
          <Icon name="lock" />
          <span>{t("sharing.snapshot.needsShare")}</span>
        </p>
      ) : null}
      {create.isError && !isPublicOff(create.error) ? (
        <p className="notice notice--danger" role="alert">
          {sharingErrorText(t, create.error, language)}
        </p>
      ) : null}
      <ExistingList
        title={t("sharing.snapshot.existing")}
        shares={existing}
        now={now}
        onManage={onManage}
      />
      <Footer
        note={`${t(panels.length === 1 ? "sharing.snapshot.panel" : "sharing.snapshot.panels", {
          count: panels.length,
        })} · ${t("sharing.audited")}`}
      >
        <button type="button" className="button button--secondary" onClick={onClose}>
          {t("dashboards.dialog.cancel")}
        </button>
        <button
          ref={createRef}
          type="button"
          className="button button--primary"
          disabled={blocked || create.isPending}
          aria-busy={create.isPending || undefined}
          onClick={() => create.mutate()}
        >
          {create.isPending ? t("sharing.snapshot.creating") : t("sharing.snapshot.create")}
        </button>
      </Footer>
    </>
  );
}
