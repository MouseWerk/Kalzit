import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { kindMonogram } from "../datasources/kindMarks";
import { listPlugins, type Plugin, type PluginList, pluginKeys } from "./api";
import { groupedKeyId, pluginStatus } from "./status";
import "../datasources/datasources.css";
import "./plugins.css";

/** The installed plugins and the host switches, shared by every plugin page. */
export function usePlugins() {
  return useQuery({ queryKey: pluginKeys.list, queryFn: ({ signal }) => listPlugins(signal) });
}

/**
 * A table that scrolls sideways when the card is narrower than its columns. The scroll box is a
 * region of its own ("Trusted keys, table"), and while its table is wider than it, it is in the
 * tab order, so keyboard users can scroll it too (WCAG 2.1.1).
 */
export function TableScroll({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useI18n();
  const ref = useRef<HTMLElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const box = ref.current;
    if (box === null || typeof ResizeObserver === "undefined") {
      return;
    }
    const check = () => setOverflows(box.scrollWidth > box.clientWidth + 1);
    const observer = new ResizeObserver(check);
    observer.observe(box);
    for (const child of box.children) {
      observer.observe(child);
    }
    check();
    return () => observer.disconnect();
  }, []);
  return (
    <section
      ref={ref}
      className="plugins-table-wrap"
      aria-label={t("plugins.table.scrollLabel", { title })}
      tabIndex={overflows ? 0 : undefined}
    >
      {children}
    </section>
  );
}

/** The current time, ticking every `every` milliseconds while `active`. */
export function useNow(active: boolean, every = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) {
      return;
    }
    const timer = window.setInterval(() => setNow(Date.now()), every);
    return () => window.clearInterval(timer);
  }, [active, every]);
  return now;
}

/** Whether any plugin waits for its next start, so its countdown ticks. */
export function anyWaiting(list: PluginList | undefined): boolean {
  return (list?.items ?? []).some((plugin) => plugin.process?.state === "waiting");
}

/** The plugin's letters in a quiet tile. Decorative: its name always stands next to it. */
export function PluginMark({ name, large = false }: { name: string; large?: boolean }) {
  return (
    <span className={large ? "plugin-mark plugin-mark--large" : "plugin-mark"} aria-hidden="true">
      {kindMonogram(name)}
    </span>
  );
}

/** Who signed the plugin, with its own symbol and word; red only for a key no longer trusted. */
export function SignatureLabel({
  plugin,
}: {
  plugin: Pick<Plugin, "signer" | "keyId" | "trusted">;
}) {
  const { t } = useI18n();
  if (plugin.signer === "unsigned") {
    return (
      <span className="plugins-signature" data-state="unsigned">
        <Icon name="alert" />
        <span>{t("plugins.signature.unsigned")}</span>
      </span>
    );
  }
  const broken = !plugin.trusted;
  return (
    <span className="plugins-signature" data-state={broken ? "broken" : "signed"}>
      <Icon name={broken ? "alert" : "shieldCheck"} />
      <span>
        {broken
          ? t("plugins.signature.untrusted")
          : plugin.signer === "kalzit"
            ? t("plugins.signature.kalzit")
            : t("plugins.signature.signed")}
      </span>
      {plugin.keyId === undefined ? null : (
        <span className="plugins-mono plugins-muted" translate="no">
          {groupedKeyId(plugin.keyId)}
        </span>
      )}
    </span>
  );
}

/** The status as a dot and a word, with why or when it starts again on a second line. */
export function PluginStatusLabel({ plugin, now }: { plugin: Plugin; now: number }) {
  const { t } = useI18n();
  const status = pluginStatus(t, plugin, now);
  return (
    <span className="plugins-stack">
      <span className="ds-status" data-status={status.tone}>
        <span className="ds-status__dot" aria-hidden="true" />
        <span>{t(status.label)}</span>
      </span>
      {status.detail === undefined ? null : (
        <span className="plugins-muted plugins-small">{status.detail}</span>
      )}
    </span>
  );
}

/** The publisher as the manifest names it: a neutral badge, not a verified identity. */
export function PublisherBadge({ publisher }: { publisher: string | undefined }) {
  const { t } = useI18n();
  return (
    <span className="plugins-chip">
      {publisher === undefined || publisher === "" ? t("plugins.publisher.unknown") : publisher}
    </span>
  );
}

/** While unsigned plugins are allowed: a band on every plugin page, with the way to turn it off. */
export function UnsignedBanner({
  list,
  onTurnOff,
  busy,
}: {
  list: PluginList;
  onTurnOff: () => void;
  busy: boolean;
}) {
  const { t } = useI18n();
  if (!list.allowUnsigned) {
    return null;
  }
  const unsigned = list.items.filter((plugin) => plugin.signer === "unsigned").length;
  return (
    <p className="plugins-banner" role="status">
      <Icon name="alert" />
      <span className="plugins-banner__text">
        <strong>{t("plugins.banner.title")}</strong>{" "}
        {t("plugins.banner.count", { count: unsigned })}
      </span>
      <button
        type="button"
        className="button button--secondary button--small"
        aria-disabled={busy}
        onClick={() => {
          if (!busy) onTurnOff();
        }}
      >
        {t("plugins.banner.turnOff")}
      </button>
    </p>
  );
}
