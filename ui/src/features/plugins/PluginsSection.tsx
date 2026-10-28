import { useQuery } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { type KeyboardEvent, useId, useState } from "react";
import { Icon } from "../../components/Icon";
import { type MessageKey, useI18n } from "../../i18n/i18n";
import { LoadState } from "../admin/components/Section";
import type { Plugin, PluginList } from "./api";
import { CatalogTab } from "./CatalogTab";
import { type CatalogItem, type CatalogView, catalogKeys, getCatalog } from "./catalogApi";
import { useHostSwitch } from "./hooks";
import { InstallDialog } from "./InstallDialog";
import {
  anyWaiting,
  PluginMark,
  PluginStatusLabel,
  PublisherBadge,
  SignatureLabel,
  UnsignedBanner,
  useNow,
  usePlugins,
} from "./parts";
import { permissionText, pluginStatus } from "./status";
import { TrustTab } from "./TrustTab";
import "./plugins.css";

export const PLUGIN_TABS = ["installed", "catalog", "trust"] as const;
export type PluginTab = (typeof PLUGIN_TABS)[number];

const TAB_LABEL: Record<PluginTab, MessageKey> = {
  installed: "plugins.tab.installed",
  catalog: "plugins.tab.catalog",
  trust: "plugins.tab.trust",
};

function tabOf(hash: string): PluginTab {
  const name = decodeURIComponent(hash.replace(/^#/, ""));
  // A search result for a catalog setting (`#plugins.catalog_url`) opens the catalog.
  if (name.startsWith("plugins.catalog")) {
    return "catalog";
  }
  return (PLUGIN_TABS as readonly string[]).includes(name) ? (name as PluginTab) : "installed";
}

/** The catalog as the tab and the strip show it: the shared first page of the catalog tab. */
function useCatalogSummary() {
  return useQuery({
    queryKey: catalogKeys.view("", ""),
    queryFn: ({ signal }) => getCatalog("", "", signal),
  });
}

/** The catalog tab's count: `off`, or the number of plugins it lists. */
function catalogCount(t: (key: "plugins.tab.catalogOff") => string, view: CatalogView | undefined) {
  if (view === undefined || view.state === "off") {
    return t("plugins.tab.catalogOff");
  }
  return view.state === "ready" || view.state === "expired" ? view.counts.all : null;
}

/**
 * Verwaltung > Plugins (board docs/design/blueprint/Plugins.dc.html, frames 1, 5 and 6): the
 * installed plugins, the catalog and the trusted keys as tabs, each with its own address
 * (`#catalog`, `#trust`), and "Install from file" next to them. While unsigned plugins are
 * allowed, a band says so above everything.
 */
export function PluginsSection() {
  const { t } = useI18n();
  const plugins = usePlugins();
  const { hash } = useLocation();
  const navigate = useNavigate();
  const tabsId = useId();
  const tab = tabOf(hash);
  const [installing, setInstalling] = useState(false);
  /** A catalog entry whose install was asked for. */
  const [fromCatalog, setFromCatalog] = useState<CatalogItem | null>(null);
  const catalog = useCatalogSummary();
  /** A key id to compare when "Check key and trust" opened the trust tab from a refused package. */
  const [trustKeyId, setTrustKeyId] = useState<string | null>(null);
  const hostSwitch = useHostSwitch();

  function choose(next: PluginTab) {
    void navigate({
      to: "/settings/$section",
      params: { section: "plugins" },
      hash: next === "installed" ? "" : next,
      replace: true,
    });
  }

  function onTabKey(event: KeyboardEvent<HTMLDivElement>) {
    const index = PLUGIN_TABS.indexOf(tab);
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) {
      return;
    }
    event.preventDefault();
    const next = PLUGIN_TABS[(index + step + PLUGIN_TABS.length) % PLUGIN_TABS.length] ?? tab;
    choose(next);
    document.getElementById(`${tabsId}-${next}-tab`)?.focus();
  }

  if (plugins.data === undefined) {
    return <LoadState error={plugins.error} onRetry={() => void plugins.refetch()} />;
  }
  const list = plugins.data;
  return (
    <div className="plugins">
      <UnsignedBanner
        list={list}
        busy={hostSwitch.isPending}
        onTurnOff={() => hostSwitch.mutate({ allowUnsigned: false })}
      />
      <div className="plugins__bar">
        <div className="tabs" role="tablist" aria-label={t("plugins.tabs")} onKeyDown={onTabKey}>
          {PLUGIN_TABS.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              id={`${tabsId}-${name}-tab`}
              className="tabs__tab"
              aria-selected={tab === name}
              aria-controls={`${tabsId}-${name}`}
              tabIndex={tab === name ? 0 : -1}
              onClick={() => choose(name)}
            >
              {t(TAB_LABEL[name])}
              <span className="plugins__count">
                {name === "installed"
                  ? list.items.length
                  : name === "catalog"
                    ? catalogCount(t, catalog.data)
                    : null}
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="button button--primary"
          onClick={() => setInstalling(true)}
        >
          <Icon name="upload" />
          {t("plugins.install.open")}
        </button>
      </div>
      <div role="tabpanel" id={`${tabsId}-${tab}`} aria-labelledby={`${tabsId}-${tab}-tab`}>
        {tab === "installed" ? (
          <InstalledTab list={list} catalog={catalog.data} />
        ) : tab === "catalog" ? (
          <CatalogTab
            onInstallFile={() => setInstalling(true)}
            onInstall={setFromCatalog}
            onCheckKey={(keyId) => {
              setTrustKeyId(keyId);
              choose("trust");
            }}
          />
        ) : (
          <TrustTab list={list} compareKeyId={trustKeyId} onCompared={() => setTrustKeyId(null)} />
        )}
      </div>
      {installing || fromCatalog !== null ? (
        <InstallDialog
          key={fromCatalog === null ? "file" : `${fromCatalog.id}@${fromCatalog.version}`}
          list={list}
          catalogEntry={fromCatalog ?? undefined}
          onClose={() => {
            setInstalling(false);
            setFromCatalog(null);
          }}
          onTrustKey={(keyId) => {
            setInstalling(false);
            setFromCatalog(null);
            setTrustKeyId(keyId);
            choose("trust");
          }}
          onAllowUnsigned={() => {
            setInstalling(false);
            setFromCatalog(null);
            choose("trust");
          }}
        />
      ) : null}
    </div>
  );
}

type Filter = "all" | "problems" | "updates";

/** The status strip and the table of installed plugins (board frame 1). */
function InstalledTab({ list, catalog }: { list: PluginList; catalog: CatalogView | undefined }) {
  const { t } = useI18n();
  const now = useNow(anyWaiting(list));
  const [filter, setFilter] = useState<Filter>("all");
  const items = list.items;
  const problems = items.filter((plugin) => pluginStatus(t, plugin, now).problem);
  const updates = items.filter((plugin) => plugin.pending !== undefined);
  const runnable = items.filter((plugin) => plugin.approved && plugin.enabled);
  const running = runnable.filter((plugin) => plugin.process?.state === "running");
  const shown = filter === "problems" ? problems : filter === "updates" ? updates : items;

  return (
    <div className="plugins">
      <section className="plugins-strip" aria-label={t("plugins.strip.label")}>
        <div className="plugins-strip__cell">
          <span className="plugins-strip__label">{t("plugins.strip.installed")}</span>
          <span className="plugins-strip__value">{items.length}</span>
          <span className="plugins-strip__sub">
            {t("plugins.strip.datasources", {
              count: items.filter((plugin) => plugin.kind === "datasource").length,
            })}
          </span>
        </div>
        <div className="plugins-strip__cell">
          <span className="plugins-strip__label">{t("plugins.strip.running")}</span>
          <span className="plugins-strip__value">
            {t("plugins.strip.runningValue", { running: running.length, total: runnable.length })}
          </span>
        </div>
        <div className="plugins-strip__cell">
          <span className="plugins-strip__label">{t("plugins.strip.problems")}</span>
          <span className="plugins-strip__value">{problems.length}</span>
        </div>
        <div className="plugins-strip__cell">
          <span className="plugins-strip__label">{t("plugins.strip.updates")}</span>
          <span className="plugins-strip__value">{updates.length}</span>
          {updates[0] === undefined ? null : (
            <span className="plugins-strip__sub">
              {updates[0].name} {updates[0].pending?.version}
            </span>
          )}
        </div>
        <div className="plugins-strip__cell">
          <span className="plugins-strip__label">{t("plugins.strip.catalog")}</span>
          <span className="plugins-strip__value">
            {catalog === undefined || catalog.state === "off"
              ? t("plugins.strip.off")
              : t("plugins.strip.on")}
          </span>
          <span className="plugins-strip__sub">
            {catalog?.state === "ready"
              ? t("plugins.strip.catalogUpdates", {
                  count: catalog.items.filter((item) => item.action === "update").length,
                })
              : t("plugins.strip.fromFile")}
          </span>
        </div>
        <div className="plugins-strip__cell">
          <span className="plugins-strip__label">{t("plugins.strip.unsigned")}</span>
          <span className="plugins-strip__value">
            {list.allowUnsigned ? t("plugins.strip.allowed") : t("plugins.strip.notAllowed")}
          </span>
          {list.allowUnsigned ? null : (
            <span className="plugins-strip__sub">{t("plugins.strip.default")}</span>
          )}
        </div>
      </section>
      <div className="plugins-filters">
        {/* biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons, not a form group */}
        <div className="plugins-filters__group" role="group" aria-label={t("plugins.filter.label")}>
          {(
            [
              ["all", "plugins.filter.all", items.length],
              ["problems", "plugins.filter.problems", problems.length],
              ["updates", "plugins.filter.updates", updates.length],
            ] as const
          ).map(([value, label, count]) => (
            <button
              key={value}
              type="button"
              className="plugins-filter"
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {t(label)} <span className="plugins__count">{count}</span>
            </button>
          ))}
        </div>
        {list.platform === undefined ? null : (
          <span className="plugins-filters__platform">
            {t("plugins.platform", { platform: list.platform })}
          </span>
        )}
      </div>
      <section className="plugins-card" aria-label={t("plugins.table.label")}>
        {items.length === 0 ? (
          <div className="plugins-card__body">
            <p className="plugins-hint">{t("plugins.empty")}</p>
          </div>
        ) : shown.length === 0 ? (
          <div className="plugins-card__body">
            <p className="plugins-hint">{t("plugins.filter.none")}</p>
          </div>
        ) : (
          <div className="plugins-table-wrap">
            <table className="plugins-table">
              <thead>
                <tr>
                  <th scope="col">{t("plugins.column.plugin")}</th>
                  <th scope="col">{t("plugins.column.kind")}</th>
                  <th scope="col">{t("plugins.column.publisher")}</th>
                  <th scope="col">{t("plugins.column.version")}</th>
                  <th scope="col">{t("plugins.column.permissions")}</th>
                  <th scope="col">{t("plugins.column.status")}</th>
                  <th scope="col" className="plugins-table__actions">
                    <span className="visually-hidden">{t("plugins.column.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((plugin) => (
                  <PluginRow key={plugin.id} plugin={plugin} now={now} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="plugins-hint">{t("plugins.allOrgs")}</p>
    </div>
  );
}

function PluginRow({ plugin, now }: { plugin: Plugin; now: number }) {
  const { t } = useI18n();
  const permissions = plugin.permissions;
  return (
    <tr>
      <th scope="row">
        <span className="plugins-name">
          <PluginMark name={plugin.name} />
          <span className="plugins-name__text">
            <Link
              to="/settings/plugins/$pluginId"
              params={{ pluginId: plugin.id }}
              className="plugins-name__link"
            >
              {plugin.name}
            </Link>
            <span className="plugins-mono plugins-muted" translate="no">
              {plugin.id}
            </span>
          </span>
        </span>
      </th>
      <td>
        <span className="plugins-chip">{t(kindLabel(plugin.kind))}</span>
      </td>
      <td>
        <span className="plugins-stack">
          <PublisherBadge publisher={plugin.publisher} />
          <SignatureLabel plugin={plugin} />
        </span>
      </td>
      <td>
        <span className="plugins-stack">
          <span className="plugins-mono">{plugin.version}</span>
          {plugin.pending === undefined ? null : (
            <span className="plugins-chip plugins-chip--strong">
              {t("plugins.update.waiting", { version: plugin.pending.version })}
            </span>
          )}
        </span>
      </td>
      <td>
        {permissions.length === 0 ? (
          <span className="plugins-muted">{t("plugins.permission.none")}</span>
        ) : (
          <span className="plugins-stack">
            {permissions.map((line) => (
              <span key={JSON.stringify(line)} className="plugins-small">
                {permissionText(t, line)}
              </span>
            ))}
          </span>
        )}
        {plugin.sandboxWarning === "landlock_missing_allowed" ? (
          <span className="plugins-small plugins-muted">
            {t("plugins.sandbox.withoutLandlock")}
          </span>
        ) : null}
      </td>
      <td>
        <PluginStatusLabel plugin={plugin} now={now} />
      </td>
      <td className="plugins-table__actions">
        <Link
          to="/settings/plugins/$pluginId"
          params={{ pluginId: plugin.id }}
          className="button button--ghost button--small"
          aria-label={t("plugins.openNamed", { name: plugin.name })}
        >
          {t("plugins.open")}
        </Link>
      </td>
    </tr>
  );
}

export function kindLabel(kind: string): MessageKey {
  return kind === "panel" ? "plugins.kind.panel" : "plugins.kind.datasource";
}
