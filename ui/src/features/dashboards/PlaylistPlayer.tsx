import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { useI18n } from "../../i18n/i18n";
import { useCurrentOrg } from "../../org/useOrg";
import { DashboardScreen, type DisplayState } from "./DashboardPage";
import { fetchPlayOrder, PLAYLISTS_KEY } from "./featuresApi";
import { errorMessage } from "./ui/errors";
import "./dashboards.css";
import "./dashboardTools.css";

const playRoute = getRouteApi("/_app/dashboards/playlists/$playlistId/play");

/**
 * Plays a playlist: each dashboard in TV mode for the playlist's interval, then the next, round
 * and round. Pause, back and forward are in the bar; Escape or Stop ends it. Only dashboards the
 * viewer may read are in the order the server answers.
 */
export function PlaylistPlayer() {
  const { t } = useI18n();
  const org = useCurrentOrg();
  const { playlistId } = playRoute.useParams();
  const navigate = useNavigate();
  const order = useQuery({
    queryKey: [PLAYLISTS_KEY, org?.id, playlistId, "play"],
    queryFn: ({ signal }) => fetchPlayOrder(org?.id ?? "", playlistId, signal),
    enabled: org !== undefined,
  });
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [viewPanel, setViewPanel] = useState<string | undefined>();
  const items = order.data?.items ?? [];
  const interval = order.data?.intervalSeconds ?? 60;

  // biome-ignore lint/correctness/useExhaustiveDependencies: a step by hand restarts the interval
  useEffect(() => {
    if (paused || items.length < 2) {
      return;
    }
    const timer = window.setTimeout(() => {
      setViewPanel(undefined);
      setIndex((i) => (i + 1) % items.length);
    }, interval * 1000);
    return () => window.clearTimeout(timer);
  }, [paused, items.length, interval, index]);

  if (org === undefined) {
    return null;
  }
  if (order.isPending) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  if (order.isError || items.length === 0) {
    return (
      <EmptyState
        icon="dashboards"
        title={order.isError ? t("playlists.loadFailed") : t("playlists.nothingToPlay")}
        actions={
          <Link to="/dashboards/playlists" className="button button--secondary">
            {t("playlists.back")}
          </Link>
        }
      >
        {order.isError ? errorMessage(t, order.error) : t("playlists.nothingToPlayText")}
      </EmptyState>
    );
  }
  const current = items[index % items.length] ?? items[0];
  if (current === undefined) {
    return null;
  }
  const step = (by: number) => {
    setViewPanel(undefined);
    setIndex((i) => (i + by + items.length) % items.length);
  };
  const stop = () => void navigate({ to: "/dashboards/playlists" });
  const display: DisplayState = { mode: "tv", viewPanel };
  return (
    <DashboardScreen
      key={current.id}
      orgId={org.id}
      dashboardId={current.id}
      display={display}
      onDisplay={(patch) => {
        if ("viewPanel" in patch) setViewPanel(patch.viewPanel);
        // Leaving TV mode ends the playlist.
        if (patch.mode === "normal") stop();
      }}
      controls={
        <fieldset className="player">
          <legend className="visually-hidden">{t("playlists.controls")}</legend>
          <span className="player__position" aria-live="polite">
            {t("playlists.position", { n: (index % items.length) + 1, count: items.length })}
          </span>
          <button type="button" className="button button--secondary" onClick={() => step(-1)}>
            {t("playlists.previous")}
          </button>
          <button
            type="button"
            className="button button--secondary"
            aria-pressed={paused}
            onClick={() => setPaused((p) => !p)}
          >
            {paused ? t("playlists.resume") : t("playlists.pause")}
          </button>
          <button type="button" className="button button--secondary" onClick={() => step(1)}>
            {t("playlists.next")}
          </button>
          <button type="button" className="button button--secondary" onClick={stop}>
            {t("playlists.stop")}
          </button>
        </fieldset>
      }
    />
  );
}
