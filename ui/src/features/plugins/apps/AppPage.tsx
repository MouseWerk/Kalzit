import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useId, useRef, useState } from "react";
import { EmptyState } from "../../../components/EmptyState";
import { Icon } from "../../../components/Icon";
import { Skeleton } from "../../../components/Skeleton";
import { useI18n } from "../../../i18n/i18n";
import { useCurrentOrg } from "../../../org/useOrg";
import { usePublishCrumbTitle } from "../../../shell/crumbTitle";
import { APPS_KEY, type AppInfo, appFrameUrl, appsQuery, pageTitle } from "./api";
import { appInitials, CapabilityList } from "./parts";
import {
  APP_API,
  type AppError,
  AppRefusal,
  answerAppRequest,
  parseAppMessage,
  requestBudget,
} from "./protocol";
import "./apps.css";

/** How long a page may take to say it listens before it is shown as not answering. */
export const APP_READY_MS = 10_000;
/** Requests of one page Kalzit answers at a time; more are refused, not queued. */
const MAX_IN_FLIGHT = 32;

/**
 * A page of an app (board Settings075.dc.html, frames 10 and 11). Kalzit draws the bar above it
 * (the app, its page, its publisher and what it may do); below, the page runs in a sandboxed
 * frame without network and reaches Kalzit only through the app message API, with the rights of
 * the person signed in.
 */
export function AppPage() {
  const { t, language } = useI18n();
  const { appId, pageId } = useParams({ from: "/_app/apps/$appId/$pageId" });
  const org = useCurrentOrg();
  // Read again now and then, and when the window comes back: an app blocked for the
  // organization, or one whose capabilities changed, must not go on with what it had.
  const apps = useQuery({
    ...appsQuery(org?.id ?? ""),
    enabled: org !== undefined,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const app = apps.data?.find((candidate) => candidate.id === appId);
  const page = app?.pages.find((candidate) => candidate.id === pageId);
  usePublishCrumbTitle(app?.name);
  if (org === undefined || apps.isPending) {
    return <Skeleton lines={4} />;
  }
  if (app === undefined || page === undefined) {
    // Not installed, blocked for the organization, or the role is below the one it asks for.
    return (
      <EmptyState icon="lock" title={t("apps.unavailable")}>
        {t("datasources.reason.plugin.app_unavailable")}
      </EmptyState>
    );
  }
  return (
    <AppHost
      key={`${org.id}:${app.id}:${page.id}:${app.version}`}
      orgId={org.id}
      app={app}
      pageId={page.id}
      title={pageTitle(page, language)}
    />
  );
}

function AppHost({
  orgId,
  app,
  pageId,
  title,
}: {
  orgId: string;
  app: AppInfo;
  pageId: string;
  title: string;
}) {
  const { t, language } = useI18n();
  const aboutId = useId();
  const frame = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "silent">("loading");
  const [attempt, setAttempt] = useState(0);
  const [about, setAbout] = useState(false);
  const inFlight = useRef(0);
  const queryClient = useQueryClient();

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt loads the frame anew
  useEffect(() => {
    let listening = true;
    const budget = requestBudget();
    const timer = window.setTimeout(() => {
      setState((current) => (current === "loading" ? "silent" : current));
    }, APP_READY_MS);
    const reply = (replyTo: string | number, body: Record<string, unknown>) => {
      // The frame's origin is opaque, so no target origin can name it: "*".
      frame.current?.contentWindow?.postMessage(
        { kalzit: "app", api: APP_API, replyTo, ...body },
        "*",
      );
    };
    const onMessage = (event: MessageEvent) => {
      // Only this frame speaks for this app; its origin is opaque, so it must be "null".
      if (frame.current === null || event.source !== frame.current.contentWindow) return;
      if (event.origin !== "null") return;
      const message = parseAppMessage(event.data);
      if (message === null) return;
      if (message.kind === "ready") {
        window.clearTimeout(timer);
        setState("ready");
        return;
      }
      const { id } = message.request;
      if (!budget.take()) {
        reply(id, { error: { code: "rate_limited", message: "too many requests" } });
        return;
      }
      if (inFlight.current >= MAX_IN_FLIGHT) {
        reply(id, { error: { code: "busy", message: "too many requests at once" } });
        return;
      }
      inFlight.current += 1;
      answerAppRequest(orgId, app, message.request)
        .then(
          (result) => {
            if (listening) reply(id, { result });
          },
          (error: unknown) => {
            const refused: AppError =
              error instanceof AppRefusal
                ? error.error
                : { code: "internal", message: "the request failed" };
            // Blocked or taken away meanwhile: the list is read again, and the page goes.
            if (refused.reason === "plugin.app_unavailable") {
              void queryClient.invalidateQueries({ queryKey: [APPS_KEY, orgId] });
            }
            if (listening) reply(id, { error: refused });
          },
        )
        .finally(() => {
          inFlight.current -= 1;
        });
    };
    window.addEventListener("message", onMessage);
    return () => {
      listening = false;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };
  }, [orgId, app, attempt]);

  return (
    <div className="app-host">
      <header className="app-bar">
        <span className="app-mark" aria-hidden="true">
          {appInitials(app.name)}
        </span>
        <div className="app-bar__names">
          <h1 className="app-bar__title">
            {app.name}
            {app.pages.length > 1 ? <span className="app-bar__page"> / {title}</span> : null}
          </h1>
          <p className="app-bar__by">
            {app.publisher === undefined
              ? t("plugins.kind.app")
              : t("apps.by", { publisher: app.publisher })}
          </p>
        </div>
        {app.pages.length > 1 ? (
          <nav className="tabs app-bar__pages" aria-label={t("apps.pages")}>
            {app.pages.map((page) => (
              <Link
                key={page.id}
                to="/apps/$appId/$pageId"
                params={{ appId: app.id, pageId: page.id }}
                className="tabs__tab"
                aria-current={page.id === pageId ? "page" : undefined}
              >
                {pageTitle(page, language)}
              </Link>
            ))}
          </nav>
        ) : null}
        <button
          type="button"
          className="button button--ghost button--small"
          aria-expanded={about}
          aria-controls={aboutId}
          onClick={() => setAbout(!about)}
        >
          <Icon name="info" />
          {t("apps.about")}
        </button>
      </header>
      {about ? (
        <section id={aboutId} className="app-about" aria-label={t("apps.about")}>
          {app.description === undefined ? null : <p>{app.description}</p>}
          <CapabilityList capabilities={app.capabilities} />
          <p className="app-about__note">{t("apps.never")}</p>
        </section>
      ) : (
        <span id={aboutId} hidden />
      )}
      {state === "silent" ? (
        <div className="notice app-host__notice" role="alert">
          <Icon name="alert" />
          <div>
            <p>
              <strong>{t("apps.silent")}</strong> {t("apps.silentText")}
            </p>
            <button
              type="button"
              className="button button--secondary button--small notice__action"
              onClick={() => {
                setState("loading");
                setAttempt((count) => count + 1);
              }}
            >
              {t("common.retry")}
            </button>
          </div>
        </div>
      ) : null}
      <iframe
        key={attempt}
        ref={frame}
        className="app-frame"
        title={`${app.name}: ${title}`}
        src={appFrameUrl(orgId, app.id, pageId)}
        sandbox="allow-scripts"
        referrerPolicy="no-referrer"
        aria-busy={state === "loading"}
      />
    </div>
  );
}
