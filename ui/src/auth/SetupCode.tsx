import { type KeyboardEvent, type ReactNode, useId, useRef, useState } from "react";
import type { SetupCodeHint } from "../api/auth";
import { Icon, type IconName } from "../components/Icon";
import { type MessageKey, useI18n } from "../i18n/i18n";
import "./auth.css";

/**
 * The default places of the setup code, per system. Only the defaults are shown: before anyone
 * signs in, the page never names this server's real paths.
 */
export const CODE_PATHS = {
  windows: "C:\\ProgramData\\Kalzit\\data\\setup-token.txt",
  linux: "/var/lib/kalzit/setup-token.txt",
} as const;
export const DOCKER_COMMAND = "docker exec kalzit kalzit setup-code";
export const COMPOSE_COMMAND = "docker compose exec kalzit kalzit setup-code";
export const JOURNAL_COMMAND = "journalctl -u kalzit";
export const LOG_LINE = `INFO first start: open Kalzit in the browser and enter the setup code from ${CODE_PATHS.linux}`;
const FIXED_VARIABLE = "KALZIT_SETUP_TOKEN";

type Way = "file" | "log" | "docker" | "fixed";
const WAYS: readonly { way: Way; icon: IconName; label: MessageKey; short: MessageKey }[] = [
  {
    way: "file",
    icon: "file",
    label: "access.setup.where.file",
    short: "access.setup.where.file",
  },
  {
    way: "log",
    icon: "log",
    label: "access.setup.where.log",
    short: "access.setup.where.logShort",
  },
  {
    way: "docker",
    icon: "terminal",
    label: "access.setup.where.docker",
    short: "access.setup.where.docker",
  },
  {
    way: "fixed",
    icon: "code",
    label: "access.setup.where.fixed",
    short: "access.setup.where.fixedShort",
  },
];

/**
 * "Where do I find the code?": one tab per way of installing, the one that fits how this server
 * runs chosen first (the server's hint: container, fixed code, else the file). Tabs follow the
 * tab pattern: arrow keys, Home and End move between them.
 */
export function CodeWhere({ hint }: { hint: SetupCodeHint | undefined }) {
  const { t } = useI18n();
  const id = useId();
  const [way, setWay] = useState<Way>(hint ?? "file");
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const index = WAYS.findIndex((candidate) => candidate.way === way);
    let next = index;
    if (event.key === "ArrowRight") {
      next = (index + 1) % WAYS.length;
    } else if (event.key === "ArrowLeft") {
      next = (index - 1 + WAYS.length) % WAYS.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = WAYS.length - 1;
    } else {
      return;
    }
    event.preventDefault();
    const target = WAYS[next];
    if (target !== undefined) {
      setWay(target.way);
      tabs.current[next]?.focus();
    }
  }

  let body: ReactNode;
  if (way === "file") {
    body = (
      <>
        <p className="code-where__text">{t("access.setup.where.fileText")}</p>
        <CopyWell os="Windows" text={CODE_PATHS.windows} />
        <CopyWell os="Linux" text={CODE_PATHS.linux} />
        <p className="field__hint">{t("access.setup.where.fileDefaults")}</p>
      </>
    );
  } else if (way === "log") {
    body = (
      <>
        <p className="code-where__text">{t("access.setup.where.logText")}</p>
        <div className="code-well code-well--wrap">
          <span className="code-well__text">{LOG_LINE}</span>
        </div>
        <p className="field__hint">
          {fill(t("access.setup.where.logHint", { command: "\u0000" }), JOURNAL_COMMAND)}
        </p>
      </>
    );
  } else if (way === "docker") {
    body = (
      <>
        <p className="code-where__text">{t("access.setup.where.dockerText")}</p>
        <CopyWell text={DOCKER_COMMAND} />
        <p className="field__hint">
          {fill(t("access.setup.where.dockerCompose", { command: "\u0000" }), COMPOSE_COMMAND)}
        </p>
      </>
    );
  } else {
    body = (
      <p className="code-where__text">
        {fill(t("access.setup.where.fixedText", { variable: "\u0000" }), FIXED_VARIABLE)}
      </p>
    );
  }

  return (
    <section className="code-where" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="access__subhead">
        {t("access.setup.where.title")}
      </h2>
      <div className="code-where__tabs" role="tablist" onKeyDown={onKeyDown} tabIndex={-1}>
        {WAYS.map((candidate, index) => (
          <button
            key={candidate.way}
            ref={(element) => {
              tabs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={`${id}-${candidate.way}`}
            aria-selected={candidate.way === way}
            aria-controls={`${id}-panel`}
            tabIndex={candidate.way === way ? 0 : -1}
            className="code-where__tab"
            onClick={() => setWay(candidate.way)}
          >
            <Icon name={candidate.icon} />
            <span className="code-where__label">{t(candidate.label)}</span>
            <span className="code-where__short" aria-hidden="true">
              {t(candidate.short)}
            </span>
          </button>
        ))}
      </div>
      <div
        className="code-where__panel"
        role="tabpanel"
        id={`${id}-panel`}
        aria-labelledby={`${id}-${way}`}
      >
        {body}
      </div>
    </section>
  );
}

/** A translated text with one placeholder (marked by a NUL) shown as code. */
function fill(text: string, code: string): ReactNode {
  const [before = "", after = ""] = text.split("\u0000");
  return (
    <>
      {before}
      <code className="access__code">{code}</code>
      {after}
    </>
  );
}

/** A path or command in a well, cut with an ellipsis when narrow, copied whole. */
function CopyWell({ text, os }: { text: string; os?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Without clipboard access (an insecure origin) the text can still be selected by hand.
      setCopied(false);
    }
  }
  return (
    <div className="code-well">
      {os === undefined ? null : <span className="code-well__os">{os}</span>}
      <span className="code-well__text" title={text}>
        {text}
      </span>
      <button
        type="button"
        className="button button--ghost button--small code-well__copy"
        aria-label={t("access.copyLabel", { text })}
        onClick={() => void copy()}
      >
        <Icon name={copied ? "check" : "copy"} />
        <span className="code-well__copy-text" aria-live="polite">
          {copied ? t("access.copied") : t("access.copy")}
        </span>
      </button>
    </div>
  );
}
