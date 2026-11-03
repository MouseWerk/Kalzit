// The German catalog: one file per area (see catalogs.ts). Its own module, so the bundle keeps
// each language in a chunk of its own and the page loads only the one it shows (i18n.ts).
import deAccess from "./de/access.json";
import deAdmin from "./de/admin.json";
import deAi from "./de/ai.json";
import deAnalyses from "./de/analyses.json";
import deAnalysis from "./de/analysis.json";
import deAnnotations from "./de/annotations.json";
import deCore from "./de/core.json";
import deDashboards from "./de/dashboards.json";
import deDashboardTools from "./de/dashboardTools.json";
import deDatasources from "./de/datasources.json";
import deDocuments from "./de/documents.json";
import deExplore from "./de/explore.json";
import deGraph from "./de/graph.json";
import deHelp from "./de/help.json";
import deLibraryPanels from "./de/libraryPanels.json";
import deLive from "./de/live.json";
import dePanelPlugins from "./de/panelPlugins.json";
import dePanels from "./de/panels.json";
import dePlaylists from "./de/playlists.json";
import dePlugins from "./de/plugins.json";
import deSecurity from "./de/security.json";
import deSettings from "./de/settings.json";
import deShell from "./de/shell.json";
import deSso from "./de/sso.json";
import deToolbar from "./de/toolbar.json";
import deUsage from "./de/usage.json";

// ux/dashboards: annotations, playlists, library panels and the dashboard tools.
const deDashboardFeatures = {
  ...deAnnotations,
  ...deDashboardTools,
  ...deLibraryPanels,
  ...dePlaylists,
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
  ...deSecurity,
  ...deUsage,
  ...deSso,
  ...deHelp,
};
