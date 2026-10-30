// One catalog file per area and language, so work on different areas does not touch the same
// file. Keys are prefixed with their area (`admin.users.title`); the parity and guard tests run
// over the combined catalogs.
import deAccess from "./de/access.json";
import deAdmin from "./de/admin.json";
import deAi from "./de/ai.json";
import deAnalyses from "./de/analyses.json";
import deAnalysis from "./de/analysis.json";
// ux/dashboards: annotations, playlists, library panels and the dashboard tools.
import deAnnotations from "./de/annotations.json";
import deCore from "./de/core.json";
import deDashboards from "./de/dashboards.json";
import deDashboardTools from "./de/dashboardTools.json";
import deDatasources from "./de/datasources.json";
import deDocuments from "./de/documents.json";
import deExplore from "./de/explore.json";
import deGraph from "./de/graph.json";
import deLibraryPanels from "./de/libraryPanels.json";
import deLive from "./de/live.json";
import dePanelPlugins from "./de/panelPlugins.json";
import dePanels from "./de/panels.json";
import dePlaylists from "./de/playlists.json";
import dePlugins from "./de/plugins.json";
import deSettings from "./de/settings.json";
import deShell from "./de/shell.json";
import deSso from "./de/sso.json";
import deToolbar from "./de/toolbar.json";
import deUsage from "./de/usage.json";
import enAccess from "./en/access.json";
import enAdmin from "./en/admin.json";
import enAi from "./en/ai.json";
import enAnalyses from "./en/analyses.json";
import enAnalysis from "./en/analysis.json";
import enAnnotations from "./en/annotations.json";
import enCore from "./en/core.json";
import enDashboards from "./en/dashboards.json";
import enDashboardTools from "./en/dashboardTools.json";
import enDatasources from "./en/datasources.json";
import enDocuments from "./en/documents.json";
import enExplore from "./en/explore.json";
import enGraph from "./en/graph.json";
import enLibraryPanels from "./en/libraryPanels.json";
import enLive from "./en/live.json";
import enPanelPlugins from "./en/panelPlugins.json";
import enPanels from "./en/panels.json";
import enPlaylists from "./en/playlists.json";
import enPlugins from "./en/plugins.json";
import enSettings from "./en/settings.json";
import enShell from "./en/shell.json";
import enSso from "./en/sso.json";
import enToolbar from "./en/toolbar.json";
import enUsage from "./en/usage.json";

const enDashboardFeatures = {
  ...enAnnotations,
  ...enDashboardTools,
  ...enLibraryPanels,
  ...enPlaylists,
};
const deDashboardFeatures = {
  ...deAnnotations,
  ...deDashboardTools,
  ...deLibraryPanels,
  ...dePlaylists,
};

export const en = {
  ...enCore,
  ...enAdmin,
  ...enDatasources,
  ...enDashboards,
  ...enExplore,
  ...enDocuments,
  ...enAnalysis,
  ...enAnalyses,
  ...enPanels,
  ...enGraph,
  ...enShell,
  ...enSettings,
  ...enDashboardFeatures,
  ...enToolbar,
  ...enLive,
  ...enAccess,
  ...enAi,
  ...enPlugins,
  ...enPanelPlugins,
  ...enUsage,
  ...enSso,
};
export const de = {
  ...deCore,
  ...deAdmin,
  ...deDatasources,
  ...deDashboards,
  ...deExplore,
  ...deDocuments,
  ...deAnalysis,
  ...deAnalyses,
  ...dePanels,
  ...deGraph,
  ...deShell,
  ...deSettings,
  ...deDashboardFeatures,
  ...deToolbar,
  ...deLive,
  ...deAccess,
  ...deAi,
  ...dePlugins,
  ...dePanelPlugins,
  ...deUsage,
  ...deSso,
};
