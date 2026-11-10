// The English catalog: one file per area (see catalogs.ts). Its own module, so the bundle keeps
// each language in a chunk of its own and the page loads only the one it shows (i18n.ts).
import enAccess from "./en/access.json";
import enAdmin from "./en/admin.json";
import enAi from "./en/ai.json";
import enAlerting from "./en/alerting.json";
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
import enHelp from "./en/help.json";
import enLibraryPanels from "./en/libraryPanels.json";
import enLive from "./en/live.json";
import enPanelPlugins from "./en/panelPlugins.json";
import enPanels from "./en/panels.json";
import enPlaylists from "./en/playlists.json";
import enPlugins from "./en/plugins.json";
import enSecurity from "./en/security.json";
import enSettings from "./en/settings.json";
import enShell from "./en/shell.json";
import enSso from "./en/sso.json";
import enToolbar from "./en/toolbar.json";
import enUsage from "./en/usage.json";

// ux/dashboards: annotations, playlists, library panels and the dashboard tools.
const enDashboardFeatures = {
  ...enAnnotations,
  ...enDashboardTools,
  ...enLibraryPanels,
  ...enPlaylists,
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
  ...enAlerting,
  ...enPlugins,
  ...enPanelPlugins,
  ...enSecurity,
  ...enUsage,
  ...enSso,
  ...enHelp,
};
