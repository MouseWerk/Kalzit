import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, type ReactNode, useDeferredValue, useId, useState } from "react";
import { Icon } from "../../components/Icon";
import { type MessageKey, type Translate, useI18n } from "../../i18n/i18n";
import { showToast } from "../../lib/toasts";
import { updateServerSetting } from "../admin/api";
import { Dialog } from "../admin/components/Dialog";
import { errorMessage } from "../dashboards/ui/errors";
import { errorReason } from "../datasources/reasons";
import {
  CATALOG_SETTING_KEYS,
  type CatalogItem,
  type CatalogView,
  catalogKeys,
  getCatalog,
  refreshCatalog,
} from "./catalogApi";
import { PluginMark } from "./parts";
import { groupedKeyId, pluginReasonText } from "./status";
import "./catalog.css";
import "./plugins.css";

type Category = "" | "datasource" | "panel";

const CATEGORIES: readonly [Category, MessageKey][] = [
  ["", "plugins.catalog.category.all"],
  ["datasource", "plugins.catalog.category.datasource"],
  ["panel", "plugins.catalog.category.panel"],
];

/** How often the catalog may be loaded again, in hours. */
const REFRESH_CHOICES = [1, 6, 12, 24, 72, 168] as const;

/** The text of a catalog failure from its reason, else the server's words. */
function failureText(
  t: Translate,
  failure: { reason: string; message: string; params?: Record<string, string> },
) {
  return pluginReasonText(t, {
    reason: failure.reason,
    params: failure.params,
    fallback: failure.message,
  });
}

/**
 * Katalog (board docs/design/blueprint/Plugins.dc.html, frames 5A and 5B). Off by default, with
 * what it would do; on, the signed list with search and categories, and Install or Update per
 * entry, which open the same check as a file. Its address and refresh interval are server
 * settings (changed here at once, with undo); while it is off, Kalzit connects nowhere for it.
 */
export function CatalogTab({
  onInstallFile,
  onInstall,
  onCheckKey,
}: {
  onInstallFile: () => void;
  onInstall: (item: CatalogItem) => void;
  onCheckKey: (keyId: string) => void;
}) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<Category>("");
  const deferred = useDeferredValue(search);
  const catalog = useQuery({
    queryKey: catalogKeys.view(deferred, category),
    queryFn: ({ signal }) => getCatalog(deferred, category, signal),
    placeholderData: (previous) => previous,
  });
  const queryClient = useQueryClient();
  const refresh = useMutation({
    mutationFn: (acceptKeyChange: boolean) => refreshCatalog(acceptKeyChange),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: catalogKeys.all }),
    onSuccess: () => showToast({ message: t("plugins.catalog.refreshed") }),
    onError: (error) => showToast({ message: errorMessage(t, error), error: true }),
  });

  if (catalog.data === undefined) {
    if (catalog.error !== null) {
      return (
        <p className="plugins-note plugins-note--danger" role="alert">
          <Icon name="alert" />
          <span>{errorMessage(t, catalog.error)}</span>
        </p>
      );
    }
    return <p className="plugins-hint">{t("plugins.catalog.loading")}</p>;
  }
  const view = catalog.data;
  const busy = refresh.isPending;
  const refreshButton = (
    <button
      type="button"
      className="button button--secondary button--small"
      aria-disabled={busy}
      onClick={() => {
        if (!busy) refresh.mutate(false);
      }}
    >
      <Icon name="refresh" />
      {busy ? t("plugins.catalog.refreshing") : t("plugins.catalog.refresh")}
    </button>
  );

  return (
    <div className="plugins">
      {view.state === "off" ? (
        <OffCard
          view={view}
          onInstallFile={onInstallFile}
          onTurnedOn={() => refresh.mutate(false)}
        />
      ) : null}
      {view.state === "unconfigured" ? (
        <p className="plugins-note plugins-note--warning">
          <Icon name="alert" />
          <span>
            <strong>{t("plugins.catalog.unconfigured")}</strong>{" "}
            {t("plugins.catalog.unconfiguredText")}
          </span>
          <TurnOffButton view={view} />
        </p>
      ) : null}
      {view.state === "not_loaded" || view.state === "unreachable" ? (
        <section className="plugins-card" aria-label={t("plugins.catalog.statusLabel")}>
          <div className="plugins-card__body">
            {view.lastError === undefined ? (
              <p className="plugins-hint">{t("plugins.catalog.notLoaded")}</p>
            ) : (
              <p className="plugins-note plugins-note--danger" role="alert">
                <Icon name="alert" />
                <span>
                  <strong>{t("plugins.catalog.unreachable")}</strong>{" "}
                  {failureText(t, view.lastError)}
                </span>
              </p>
            )}
            <div className="catalog-actions">
              {refreshButton}
              <TurnOffButton view={view} />
            </div>
          </div>
        </section>
      ) : null}
      {view.state === "ready" || view.state === "expired" || view.state === "untrusted" ? (
        <Browse
          view={view}
          search={search}
          onSearch={setSearch}
          category={category}
          onCategory={setCategory}
          refreshButton={refreshButton}
          onAcceptKey={() => refresh.mutate(true)}
          onInstall={onInstall}
          onCheckKey={onCheckKey}
        />
      ) : null}
      {view.state === "off" ? null : (
        <SettingsCard view={view} onChanged={(urlChanged) => urlChanged && refresh.mutate(false)} />
      )}
    </div>
  );
}

/** Turns the catalog off at once, with Undo; while it is off Kalzit connects nowhere for it. */
function TurnOffButton({ view }: { view: CatalogView }) {
  const { t } = useI18n();
  const change = useSettingChange();
  return (
    <button
      type="button"
      className="button button--ghost button--small"
      disabled={!view.settings.enabled.editable}
      onClick={() =>
        change.mutate({
          key: "enabled",
          value: false,
          version: view.settings.enabled.version,
          undoValue: true,
        })
      }
    >
      {t("plugins.catalog.turnOff")}
    </button>
  );
}

/** Board frame 5A: what the catalog is, its switch, and that files always work. */
function OffCard({
  view,
  onInstallFile,
  onTurnedOn,
}: {
  view: CatalogView;
  onInstallFile: () => void;
  onTurnedOn: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const change = useSettingChange();
  const enabled = view.settings.enabled;
  return (
    <>
      <section className="plugins-card catalog-off" aria-labelledby={titleId}>
        <div className="plugins-card__body catalog-off__body">
          <span className="catalog-off__icon" aria-hidden="true">
            <Icon name="library" />
          </span>
          <h3 className="plugin-switch__title" id={titleId}>
            {t("plugins.catalog.title")}
          </h3>
          <p className="plugins-hint catalog-off__lead">{t("plugins.catalog.lead")}</p>
          <label className="catalog-switch">
            <input
              type="checkbox"
              role="switch"
              checked={false}
              aria-checked={false}
              disabled={!enabled.editable}
              onChange={() =>
                change.mutate(
                  { key: "enabled", value: true, version: enabled.version, undoValue: false },
                  {
                    onSuccess: () => {
                      if (view.settings.url.value !== "") onTurnedOn();
                    },
                  },
                )
              }
            />
            <span>{t("plugins.catalog.use")}</span>
          </label>
          {enabled.editable ? null : <p className="plugins-hint">{t("plugins.catalog.locked")}</p>}
          <p className="plugins-hint">{t("plugins.catalog.fileAlways")}</p>
          <div>
            <button type="button" className="button button--secondary" onClick={onInstallFile}>
              <Icon name="upload" />
              {t("plugins.install.open")}
            </button>
          </div>
        </div>
      </section>
      <SettingsCard view={view} onChanged={() => undefined} />
    </>
  );
}

interface Change {
  key: keyof typeof CATALOG_SETTING_KEYS;
  value: unknown;
  version: number;
  /** The value Undo goes back to. */
  undoValue: unknown;
}

/** Changes one catalog setting at once, with Undo in the toast. */
function useSettingChange() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: ({ key, value, version }: Change) =>
      updateServerSetting(CATALOG_SETTING_KEYS[key], value, version),
    onSuccess: (setting, change) => {
      void queryClient.invalidateQueries({ queryKey: catalogKeys.all });
      const message: MessageKey =
        change.key === "enabled"
          ? change.value === true
            ? "plugins.catalog.saved.on"
            : "plugins.catalog.saved.off"
          : change.key === "url"
            ? "plugins.catalog.saved.url"
            : "plugins.catalog.saved.interval";
      showToast({
        message: t(message),
        undo: () =>
          mutation.mutate({
            key: change.key,
            value: change.undoValue,
            version: setting.version,
            undoValue: change.value,
          }),
      });
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: catalogKeys.all });
      showToast({ message: errorMessage(t, error), error: true });
    },
  });
  return mutation;
}

/** The catalog's address and refresh interval (board frame 5A, second card). */
function SettingsCard({
  view,
  onChanged,
}: {
  view: CatalogView;
  /** After a change; `true` when the address changed while the catalog is on. */
  onChanged: (urlChanged: boolean) => void;
}) {
  const { t } = useI18n();
  const urlId = useId();
  const hoursId = useId();
  const change = useSettingChange();
  const { url, refreshHours } = view.settings;
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? url.value;
  const urlError = change.error !== null && change.variables?.key === "url" ? change.error : null;

  function saveUrl(event?: FormEvent) {
    event?.preventDefault();
    const value = shown.trim();
    if (value === url.value) {
      setDraft(null);
      return;
    }
    change.mutate(
      { key: "url", value, version: url.version, undoValue: url.value },
      {
        onSuccess: () => {
          setDraft(null);
          onChanged(view.state !== "off" && value !== "");
        },
      },
    );
  }

  return (
    <section className="plugins-card" aria-label={t("plugins.catalog.settings")}>
      <form className="plugins-card__body" onSubmit={saveUrl}>
        <div className="catalog-setting">
          <div className="catalog-setting__text">
            <label className="plugin-switch__title" htmlFor={urlId}>
              {t("plugins.catalog.url")}
            </label>
            <p className="plugins-hint">{t("plugins.catalog.urlText")}</p>
          </div>
          <div className="catalog-setting__control">
            <input
              id={urlId}
              className="input input--mono"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://"
              value={shown}
              readOnly={!url.editable}
              aria-invalid={urlError !== null}
              aria-describedby={urlError === null ? undefined : `${urlId}-error`}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onBlur={() => saveUrl()}
            />
            {urlError === null ? null : (
              <p className="field__error" id={`${urlId}-error`} role="alert">
                {errorReason(urlError) === undefined
                  ? t("plugins.catalog.urlInvalid")
                  : errorMessage(t, urlError)}
              </p>
            )}
          </div>
        </div>
        <div className="catalog-setting">
          <div className="catalog-setting__text">
            <label className="plugin-switch__title" htmlFor={hoursId}>
              {t("plugins.catalog.interval")}
            </label>
            <p className="plugins-hint">{t("plugins.catalog.intervalText")}</p>
          </div>
          <div className="catalog-setting__control">
            <select
              id={hoursId}
              className="select"
              value={refreshHours.value}
              disabled={!refreshHours.editable}
              onChange={(event) =>
                change.mutate(
                  {
                    key: "refreshHours",
                    value: Number(event.currentTarget.value),
                    version: refreshHours.version,
                    undoValue: refreshHours.value,
                  },
                  { onSuccess: () => onChanged(false) },
                )
              }
            >
              {(REFRESH_CHOICES as readonly number[]).includes(refreshHours.value) ? null : (
                <option value={refreshHours.value}>
                  {t("plugins.catalog.hours", { count: refreshHours.value })}
                </option>
              )}
              {REFRESH_CHOICES.map((hours) => (
                <option key={hours} value={hours}>
                  {t("plugins.catalog.hours", { count: hours })}
                </option>
              ))}
            </select>
          </div>
        </div>
        {url.editable && refreshHours.editable ? null : (
          <p className="plugins-hint">{t("plugins.catalog.locked")}</p>
        )}
      </form>
    </section>
  );
}

/** Board frame 5B: the signed list, its state, categories, search and the entries. */
function Browse({
  view,
  search,
  onSearch,
  category,
  onCategory,
  refreshButton,
  onAcceptKey,
  onInstall,
  onCheckKey,
}: {
  view: CatalogView;
  search: string;
  onSearch: (value: string) => void;
  category: Category;
  onCategory: (value: Category) => void;
  refreshButton: ReactNode;
  /** Takes the list although another key signed it than before. */
  onAcceptKey: () => void;
  onInstall: (item: CatalogItem) => void;
  onCheckKey: (keyId: string) => void;
}) {
  const { t, language } = useI18n();
  const [trustedOnly, setTrustedOnly] = useState(false);
  const [details, setDetails] = useState<CatalogItem | null>(null);
  const time = new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" });
  // Past its expiry or signed by a key trusted no more: nothing can be installed from it.
  const expired = view.state === "expired" || view.state === "untrusted";
  const items = trustedOnly ? view.items.filter((item) => item.keyName !== undefined) : view.items;
  const withdrawn = view.revoked.filter((r) => r.installedVersion !== undefined);
  const index = view.index;
  return (
    <>
      <div className="catalog-status" role="status">
        <Icon name="shieldCheck" />
        <span>
          {t("plugins.catalog.signedBy", {
            signer: index?.signer ?? t("plugins.catalog.signerUnknown"),
            time: time.format(view.checkedAt ?? index?.fetchedAt ?? 0),
          })}
        </span>
        <span className="catalog-status__sep" aria-hidden="true">
          |
        </span>
        <span>{t("plugins.catalog.count", { count: view.counts.all })}</span>
        <span className="catalog-status__sep" aria-hidden="true">
          |
        </span>
        <span className="plugins-mono" translate="no">
          {index?.host}
        </span>
        <span className="catalog-status__spacer" />
        {refreshButton}
        <TurnOffButton view={view} />
      </div>
      {view.state === "untrusted" ? (
        <p className="plugins-note plugins-note--danger" role="alert">
          <Icon name="alert" />
          <span>
            <strong>{t("plugins.catalog.untrusted")}</strong> {t("plugins.catalog.untrustedText")}
          </span>
        </p>
      ) : null}
      {view.state === "expired" && index !== undefined ? (
        <p className="plugins-note plugins-note--danger" role="alert">
          <Icon name="alert" />
          <span>
            <strong>{t("plugins.catalog.expired")}</strong>{" "}
            {t("plugins.catalog.expiredText", { time: time.format(index.expiresAt) })}
          </span>
        </p>
      ) : null}
      {!expired && view.lastError !== undefined ? (
        <p className="plugins-note plugins-note--warning">
          <Icon name="alert" />
          <span>
            <strong>{t("plugins.catalog.lastFailed")}</strong> {failureText(t, view.lastError)}{" "}
            {t("plugins.catalog.keptList", { time: time.format(index?.fetchedAt ?? 0) })}
          </span>
          {view.lastError.reason === "catalog.key_changed" ? (
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={onAcceptKey}
            >
              {t("plugins.catalog.acceptKey")}
            </button>
          ) : null}
        </p>
      ) : null}
      {withdrawn.length === 0 ? null : (
        <div className="plugins-note plugins-note--danger" role="alert">
          <Icon name="alert" />
          <div className="plugins-stack">
            <strong>{t("plugins.catalog.withdrawnInstalled")}</strong>
            {withdrawn.map((r) => (
              <span key={`${r.id}-${r.versions}`}>
                <span className="plugins-mono" translate="no">
                  {r.id} {r.installedVersion}
                </span>{" "}
                {r.reason}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="catalog-browse">
        <nav className="catalog-nav" aria-label={t("plugins.catalog.categories")}>
          {CATEGORIES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              className="plugins-filter catalog-nav__item"
              aria-pressed={category === value}
              onClick={() => onCategory(value)}
            >
              <span>{t(label)}</span>
              <span className="plugins__count">
                {value === ""
                  ? view.counts.all
                  : value === "datasource"
                    ? view.counts.datasource
                    : view.counts.panel}
              </span>
            </button>
          ))}
          <label className="plugin-check catalog-nav__trusted">
            <input
              type="checkbox"
              checked={trustedOnly}
              onChange={(event) => setTrustedOnly(event.currentTarget.checked)}
            />
            <span>{t("plugins.catalog.trustedOnly")}</span>
          </label>
        </nav>
        <div className="catalog-results">
          <label className="catalog-search">
            <Icon name="search" />
            <input
              type="search"
              className="catalog-search__input"
              placeholder={t("plugins.catalog.searchPlaceholder")}
              aria-label={t("plugins.catalog.search")}
              value={search}
              onChange={(event) => onSearch(event.currentTarget.value)}
            />
            <span className="plugins-muted plugins-small">
              {t("plugins.catalog.results", { count: items.length })}
            </span>
          </label>
          {items.length === 0 ? (
            <p className="plugins-hint">{t("plugins.catalog.none")}</p>
          ) : (
            <div className="catalog-grid">
              {items.map((item) => (
                <CatalogCard
                  key={item.id}
                  item={item}
                  expired={expired}
                  onInstall={() => onInstall(item)}
                  onCheckKey={() => onCheckKey(item.keyId)}
                  onDetails={() => setDetails(item)}
                />
              ))}
            </div>
          )}
          <p className="plugins-hint">{t("plugins.catalog.installHint")}</p>
        </div>
      </div>
      {details === null ? null : (
        <DetailsDialog
          item={details}
          expired={expired}
          onClose={() => setDetails(null)}
          onInstall={() => {
            setDetails(null);
            onInstall(details);
          }}
          onCheckKey={() => {
            setDetails(null);
            onCheckKey(details.keyId);
          }}
        />
      )}
    </>
  );
}

function kindText(t: Translate, item: CatalogItem): string {
  return t(item.kind === "panel" ? "plugins.kind.panel" : "plugins.kind.datasource");
}

/** The publisher and its key: who signs the package, and whether this server trusts the key. */
function KeyChip({ item }: { item: CatalogItem }) {
  const { t } = useI18n();
  const trusted = item.keyName !== undefined;
  return (
    <span className="plugins-chip catalog-key" data-trusted={trusted}>
      <Icon name={trusted ? "shieldCheck" : "alert"} />
      {trusted
        ? item.keyName
        : t("plugins.catalog.untrustedKey", {
            publisher: item.publisher ?? t("plugins.publisher.unknown"),
          })}
      {/* The catalog's publisher text is unverified: only a quiet second label. */}
      {trusted && item.publisher !== undefined && item.publisher !== item.keyName ? (
        <span className="plugins-muted">
          {t("plugins.catalog.says", { publisher: item.publisher })}
        </span>
      ) : null}
    </span>
  );
}

/** Marks kind and targets that only the catalog states (no verified package of it is here). */
function FromCatalog({ item }: { item: CatalogItem }) {
  const { t } = useI18n();
  return item.detailsFrom === "catalog" ? (
    <span className="plugins-muted plugins-small">{t("plugins.catalog.fromCatalog")}</span>
  ) : null;
}

function Targets({ item }: { item: CatalogItem }) {
  const { t } = useI18n();
  if (item.network.length === 0) {
    return (
      <>
        <span className="plugins-chip">
          {item.kind === "panel"
            ? t("plugins.catalog.displayOnly")
            : t("plugins.catalog.noNetwork")}
        </span>
        <FromCatalog item={item} />
      </>
    );
  }
  return (
    <>
      {item.network.map((target) => (
        <span key={target} className="plugins-chip plugins-mono" translate="no">
          <Icon name="network" />
          {target}
        </span>
      ))}
      <FromCatalog item={item} />
    </>
  );
}

/** What can be done with an entry here: install, update, or why not. */
function Action({
  item,
  expired,
  onInstall,
  onCheckKey,
}: {
  item: CatalogItem;
  expired: boolean;
  onInstall: () => void;
  onCheckKey: () => void;
}) {
  const { t } = useI18n();
  switch (item.action) {
    case "revoked":
      return (
        <span className="catalog-card__state" data-state="revoked">
          <Icon name="alert" />
          {t("plugins.catalog.revoked")}
        </span>
      );
    case "untrusted":
      return (
        <button
          type="button"
          className="button button--secondary button--small"
          onClick={onCheckKey}
        >
          <Icon name="shieldCheck" />
          {t("plugins.catalog.checkKey")}
        </button>
      );
    case "installed":
      return (
        <span className="catalog-card__state">
          <Icon name="check" />
          {t("plugins.catalog.installed")}
        </span>
      );
    case "pending":
      return (
        <span className="catalog-card__state">
          <Icon name="clock" />
          {t("plugins.catalog.pending", { version: item.version })}
        </span>
      );
    case "update":
      return (
        <>
          <span className="plugins-muted plugins-small">
            {t("plugins.catalog.installedVersion", { version: item.installedVersion ?? "" })}
          </span>
          <button
            type="button"
            className="button button--primary button--small"
            disabled={expired}
            onClick={onInstall}
          >
            {t("plugins.catalog.update", { version: item.version })}
          </button>
        </>
      );
    case "publisher_change":
      // Not a routine update: a secondary action that leads to the confirmation.
      return (
        <>
          <span className="plugins-muted plugins-small">
            {t("plugins.catalog.installedUnsigned", { version: item.installedVersion ?? "" })}
          </span>
          <button
            type="button"
            className="button button--secondary button--small"
            disabled={expired}
            onClick={onInstall}
          >
            <Icon name="alert" />
            {t("plugins.catalog.publisherChange", { version: item.version })}
          </button>
        </>
      );
    default:
      return (
        <button
          type="button"
          className="button button--primary button--small"
          disabled={expired}
          aria-label={t("plugins.catalog.installNamed", { name: item.name })}
          onClick={onInstall}
        >
          {t("plugins.catalog.install")}
        </button>
      );
  }
}

function CatalogCard({
  item,
  expired,
  onInstall,
  onCheckKey,
  onDetails,
}: {
  item: CatalogItem;
  expired: boolean;
  onInstall: () => void;
  onCheckKey: () => void;
  onDetails: () => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  return (
    <article className="catalog-card" aria-labelledby={titleId}>
      <div className="plugins-name">
        <PluginMark name={item.name} large />
        <span className="plugins-name__text">
          <h3 className="catalog-card__title" id={titleId}>
            {item.name}
          </h3>
          <span className="plugins-muted plugins-small">
            {kindText(t, item)} · <span className="plugins-mono">{item.version}</span>
          </span>
        </span>
      </div>
      {item.description === undefined ? null : <p className="plugins-hint">{item.description}</p>}
      <div className="plugins-chips">
        <KeyChip item={item} />
        <Targets item={item} />
      </div>
      {item.installedRevoked !== undefined && item.action !== "revoked" ? (
        <p className="plugins-small catalog-card__revoked">
          {t("plugins.catalog.installedRevoked", { reason: item.installedRevoked })}
        </p>
      ) : null}
      <div className="catalog-card__actions">
        <Action item={item} expired={expired} onInstall={onInstall} onCheckKey={onCheckKey} />
        <span className="catalog-card__spacer" />
        <button
          type="button"
          className="button button--ghost button--small"
          aria-label={t("plugins.catalog.detailsNamed", { name: item.name })}
          onClick={onDetails}
        >
          {t("plugins.catalog.details")}
        </button>
      </div>
    </article>
  );
}

/** One entry in full: publisher key, version, permissions and network targets, the package. */
function DetailsDialog({
  item,
  expired,
  onClose,
  onInstall,
  onCheckKey,
}: {
  item: CatalogItem;
  expired: boolean;
  onClose: () => void;
  onInstall: () => void;
  onCheckKey: () => void;
}) {
  const { t, language } = useI18n();
  const size = new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(
    item.size / 1_000_000,
  );
  return (
    <Dialog
      open
      wide
      title={t("plugins.catalog.detailsTitle", { name: item.name, version: item.version })}
      onClose={onClose}
      footer={
        <div className="plugin-dialog__footer">
          <span className="plugin-dialog__spacer" />
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("plugins.install.close")}
          </button>
          {item.action === "install" || item.action === "update" ? (
            <button
              type="button"
              className="button button--primary"
              disabled={expired}
              onClick={onInstall}
            >
              {item.action === "update"
                ? t("plugins.catalog.update", { version: item.version })
                : t("plugins.catalog.install")}
            </button>
          ) : null}
          {item.action === "publisher_change" ? (
            <button
              type="button"
              className="button button--secondary"
              disabled={expired}
              onClick={onInstall}
            >
              {t("plugins.catalog.publisherChange", { version: item.version })}
            </button>
          ) : null}
          {item.action === "untrusted" ? (
            <button type="button" className="button button--primary" onClick={onCheckKey}>
              {t("plugins.catalog.checkKey")}
            </button>
          ) : null}
        </div>
      }
    >
      <div className="plugin-dialog">
        {item.description === undefined ? null : <p className="plugins-hint">{item.description}</p>}
        {item.action === "publisher_change" ? (
          <p className="plugins-note plugins-note--danger">
            <Icon name="alert" />
            <span>{t("plugins.catalog.publisherChangeNote")}</span>
          </p>
        ) : null}
        {item.revoked === undefined ? null : (
          <p className="plugins-note plugins-note--danger" role="alert">
            <Icon name="alert" />
            <span>
              <strong>{t("plugins.catalog.revoked")}</strong> {item.revoked}
            </span>
          </p>
        )}
        <dl className="plugin-defs">
          <dt>{t("plugins.catalog.field.publisher")}</dt>
          <dd>{item.publisher ?? t("plugins.publisher.unknown")}</dd>
          <dt>{t("plugins.catalog.field.key")}</dt>
          <dd>
            <span className="plugins-mono" translate="no">
              {groupedKeyId(item.keyId)}
            </span>{" "}
            <span className="plugins-muted">
              {item.keyName === undefined
                ? t("plugins.catalog.keyNotTrusted")
                : t("plugins.catalog.keyTrusted", { name: item.keyName })}
            </span>
          </dd>
          <dt>{t("plugins.catalog.field.version")}</dt>
          <dd>
            <span className="plugins-mono">{item.version}</span>
            {item.installedVersion === undefined ? null : (
              <span className="plugins-muted">
                {" "}
                {t("plugins.catalog.installedVersion", { version: item.installedVersion })}
              </span>
            )}
          </dd>
          <dt>{t("plugins.catalog.field.kind")}</dt>
          <dd>
            {kindText(t, item)} <FromCatalog item={item} />
          </dd>
          <dt>{t("plugins.catalog.field.network")}</dt>
          <dd>
            <span className="plugins-chips">
              <Targets item={item} />
            </span>
          </dd>
          <dt>{t("plugins.catalog.field.package")}</dt>
          <dd>{t("plugins.catalog.packageFrom", { size, host: item.urlHost })}</dd>
          <dt>{t("plugins.catalog.field.sha256")}</dt>
          <dd className="plugins-mono" translate="no">
            {item.sha256}
          </dd>
        </dl>
        <p className="plugins-hint">{t("plugins.catalog.detailsHint")}</p>
      </div>
    </Dialog>
  );
}
