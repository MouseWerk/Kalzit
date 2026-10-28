import { type RefObject, useEffect, useId, useRef, useState } from "react";
import { Icon } from "../../../components/Icon";
import { useI18n } from "../../../i18n/i18n";
import { usePanelHost } from "../../../panels/host";
import { useStyleVars } from "../../../panels/styleVars";
import type { PanelSeries } from "../../../panels/types";
import { useElementSize } from "../../../panels/useElementSize";
import { useThemeVersion } from "../../../panels/useThemeVersion";
import { Dialog } from "../../dashboards/ui/Dialog";
import { frameUrl, type PanelPluginInfo } from "./api";
import { panelConsole } from "./log";
import { checkOptions } from "./options";
import {
  MAX_EVENTS_PER_SECOND,
  MAX_HEIGHT,
  MAX_LOGS_PER_SECOND,
  message,
  type PanelEvent,
  parseEvent,
  RateLimit,
} from "./protocol";
import { panelTheme } from "./theme";
import "../../../panels/panels.css";
import "./panelPlugins.css";

/** How long a panel has to say `ready` after its frame loaded. */
export const READY_TIMEOUT_MS = 10_000;

type Failure = "timeout" | "navigated";

interface FrameProps {
  info: PanelPluginInfo;
  options: Record<string, unknown>;
  series: readonly PanelSeries[];
  timeRange: { from: number; to: number };
  title: string;
}

/**
 * A panel of a panel plugin: its bundle in `<iframe sandbox="allow-scripts">` (an opaque origin,
 * no network, no access to Kalzit's page, cookies or APIs), spoken to only through the panel
 * message API. Messages are accepted only from this frame's window with the opaque origin
 * `"null"`, checked against the API's schema and rate limited; everything else is dropped with a
 * line in the browser console. A frame that does not answer in time or navigates away shows an
 * error in the panel and can be started again.
 */
export function PluginFrame(props: FrameProps) {
  const host = usePanelHost();
  const [attempt, setAttempt] = useState(0);
  const [failure, setFailure] = useState<Failure | null>(null);
  if (host.orgId === undefined) {
    return null;
  }
  const src = frameUrl(host.orgId, props.info, host.dashboardId);
  if (failure !== null) {
    return (
      <FrameError
        failure={failure}
        onRetry={() => {
          setFailure(null);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }
  // A new address or another attempt is a new frame with a fresh exchange.
  return <FrameHost key={`${src}#${attempt}`} src={src} {...props} onFailure={setFailure} />;
}

function FrameError({ failure, onRetry }: { failure: Failure; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="panel-error plugin-frame__error" role="alert">
      <Icon name="alert" />
      <span>
        {failure === "timeout"
          ? t("panelPlugins.error.timeout", { seconds: READY_TIMEOUT_MS / 1000 })
          : t("panelPlugins.error.navigated")}
      </span>
      <button type="button" className="button button--secondary button--small" onClick={onRetry}>
        {t("panelPlugins.error.retry")}
      </button>
    </div>
  );
}

/** The payload of a series: its result in its shape, or its error. */
function payload(s: PanelSeries): unknown {
  if (s.result === undefined) {
    return `${s.error?.code ?? ""}\u0000${s.error?.message ?? ""}`;
  }
  switch (s.result.shape) {
    case "frame":
      return s.result.frame;
    case "documents":
      return s.result.documents;
    default:
      return s.result.graph;
  }
}

/** Whether two lists hold the same results (the same objects), so nothing new is sent. */
export function sameSeries(a: readonly PanelSeries[], b: readonly PanelSeries[]): boolean {
  return (
    a.length === b.length &&
    a.every((s, i) => {
      const other = b[i];
      return other !== undefined && s.refId === other.refId && payload(s) === payload(other);
    })
  );
}

/** Into the frame. Its origin is opaque, so no target origin can name it: `"*"`. */
function postTo(frame: RefObject<HTMLIFrameElement | null>, data: unknown): void {
  frame.current?.contentWindow?.postMessage(data, "*");
}

/** What the exchange reads when an event arrives: the latest props, not those of its start. */
interface Latest extends FrameProps {
  size: { width: number; height: number };
  language: string;
  timeZone: string;
  editOptions: ((options: Record<string, unknown>) => void) | undefined;
}

function FrameHost({
  src,
  onFailure,
  ...props
}: FrameProps & { src: string; onFailure: (failure: Failure) => void }) {
  const { t, language, timeZone } = useI18n();
  const host = usePanelHost();
  const wrapper = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const size = useElementSize(wrapper);
  const themeVersion = useThemeVersion();
  const [ready, setReady] = useState(false);
  const [requested, setRequested] = useState<number | null>(null);
  const [link, setLink] = useState<{ url: string; title?: string } | null>(null);
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const latest = useRef<Latest | null>(null);
  useEffect(() => {
    latest.current = { ...props, size, language, timeZone: zone, editOptions: host.editOptions };
  });

  const height = Math.min(requested ?? size.height, MAX_HEIGHT);
  useStyleVars(wrapper, { "--plugin-frame-height": `${height}px` });

  // The exchange: events only from this frame's window, checked and rate limited.
  useEffect(() => {
    const id = props.info.id;
    const events = new RateLimit(MAX_EVENTS_PER_SECOND);
    const logs = new RateLimit(MAX_LOGS_PER_SECOND);
    const note = (text: string) => panelConsole(id, "warn", text);
    let started = false;
    const timer = window.setTimeout(() => {
      if (!started) {
        note(`did not say ready within ${READY_TIMEOUT_MS / 1000} s`);
        onFailure("timeout");
      }
    }, READY_TIMEOUT_MS);
    const post = (data: unknown) => postTo(frame, data);
    const act = (event: PanelEvent) => {
      const now = latest.current;
      if (now === null) {
        return;
      }
      switch (event.type) {
        case "ready":
          started = true;
          window.clearTimeout(timer);
          post(
            message("init", {
              options: now.options,
              size: now.size,
              theme: panelTheme(),
              locale: now.language,
              timeZone: now.timeZone,
              title: now.title,
              mode: now.editOptions === undefined ? "view" : "edit",
            }),
          );
          setReady(true);
          return;
        case "resize":
          setRequested(event.height);
          return;
        case "setOptions": {
          if (now.editOptions === undefined) {
            note("dropped setOptions: the panel is not being edited");
            return;
          }
          const refused = checkOptions(now.info.options, event.options);
          if (refused !== null) {
            note(`dropped setOptions (${refused.code}): ${refused.message}`);
            return;
          }
          now.editOptions(event.options);
          return;
        }
        case "link":
          setLink(
            event.title === undefined ? { url: event.url } : { url: event.url, title: event.title },
          );
          return;
        case "log":
          if (logs.take()) {
            panelConsole(id, event.level, event.text);
          }
          return;
        default:
          // click, select, range and setVariable are events of the API that this host does not
          // act on: a panel may ask for a size, its options while edited, a link and its log.
          panelConsole(id, "debug", `${event.type} is not acted on`);
      }
    };
    const onMessage = (event: MessageEvent) => {
      // Only this frame speaks for this panel; its origin is opaque, so it must be "null".
      if (frame.current === null || event.source !== frame.current.contentWindow) {
        return;
      }
      if (event.origin !== "null") {
        note(`dropped a message from origin ${event.origin}`);
        return;
      }
      if (!events.take()) {
        return;
      }
      const parsed = parseEvent(event.data);
      if (!parsed.ok) {
        note(`dropped an event (${parsed.code}): ${parsed.message}`);
        return;
      }
      act(parsed.event);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };
  }, [props.info.id, onFailure]);

  // After `init`: what changed since, each in its own message.
  const revision = useRef(0);
  const { options } = props;
  const { from, to } = props.timeRange;
  // The results are built anew with every drawing; only other results are sent.
  const stable = useRef(props.series);
  if (!sameSeries(stable.current, props.series)) {
    stable.current = props.series;
  }
  const series = stable.current;
  useEffect(() => {
    if (ready) {
      revision.current += 1;
      postTo(
        frame,
        message("data", { series, timeRange: { from, to }, revision: revision.current }),
      );
    }
  }, [ready, series, from, to]);
  const optionsKey = JSON.stringify(options);
  const sentOptions = useRef(optionsKey);
  useEffect(() => {
    if (ready && sentOptions.current !== optionsKey) {
      sentOptions.current = optionsKey;
      postTo(frame, message("options", { options: JSON.parse(optionsKey) as unknown }));
    }
  }, [ready, optionsKey]);
  const sentSize = useRef(`${size.width}x${size.height}`);
  useEffect(() => {
    const key = `${size.width}x${size.height}`;
    if (ready && sentSize.current !== key) {
      sentSize.current = key;
      postTo(frame, message("size", { width: size.width, height: size.height }));
    }
  }, [ready, size.width, size.height]);
  const sentTheme = useRef(themeVersion);
  useEffect(() => {
    if (ready && sentTheme.current !== themeVersion) {
      sentTheme.current = themeVersion;
      postTo(frame, message("theme", { ...panelTheme() }));
    }
  }, [ready, themeVersion]);

  // The frame's own document loads once; a second load means it navigated away from the bundle,
  // where it could carry data out in the address. The panel is stopped.
  const loads = useRef(0);
  const name = props.title.trim() === "" ? props.info.name : props.title;
  return (
    <div className="plugin-frame" ref={wrapper}>
      <iframe
        ref={frame}
        className="plugin-frame__iframe"
        src={src}
        title={t("panelPlugins.frameTitle", { name })}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        onLoad={() => {
          loads.current += 1;
          if (loads.current > 1) {
            panelConsole(props.info.id, "warn", "navigated away from its bundle and was stopped");
            onFailure("navigated");
          }
        }}
      />
      {link === null ? null : (
        <LinkDialog
          plugin={props.info.name}
          link={link}
          onClose={() => setLink(null)}
          onOpen={() => {
            setLink(null);
            openLink(link.url);
          }}
        />
      )}
    </div>
  );
}

/** A path opens in Kalzit; an address in a new tab, without a referrer or a handle back. */
export function openLink(url: string): void {
  if (url.startsWith("/")) {
    window.location.assign(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

function LinkDialog({
  plugin,
  link,
  onClose,
  onOpen,
}: {
  plugin: string;
  link: { url: string; title?: string };
  onClose: () => void;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const textId = useId();
  return (
    <Dialog
      title={t("panelPlugins.link.title")}
      onClose={onClose}
      describedBy={textId}
      actions={
        <>
          <button
            type="button"
            className="button button--secondary"
            onClick={onClose}
            data-autofocus
          >
            {t("panelPlugins.link.cancel")}
          </button>
          <button type="button" className="button button--primary" onClick={onOpen}>
            {t("panelPlugins.link.open")}
          </button>
        </>
      }
    >
      <p id={textId}>
        {link.url.startsWith("/")
          ? t("panelPlugins.link.inside", { plugin })
          : t("panelPlugins.link.outside", { plugin })}
      </p>
      {link.title === undefined ? null : <p className="plugin-link__title">{link.title}</p>}
      <p className="plugin-link__url">{link.url}</p>
    </Dialog>
  );
}
