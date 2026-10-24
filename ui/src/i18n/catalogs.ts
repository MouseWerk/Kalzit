// One catalog file per area and language, so work on different areas does not touch the same
// file. Keys are prefixed with their area (`admin.users.title`); the parity and guard tests run
// over the combined catalogs.
import deAdmin from "./de/admin.json";
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
import dePanels from "./de/panels.json";
import dePlaylists from "./de/playlists.json";
import deShell from "./de/shell.json";
import deToolbar from "./de/toolbar.json";
import enAdmin from "./en/admin.json";
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
import enPanels from "./en/panels.json";
import enPlaylists from "./en/playlists.json";
import enShell from "./en/shell.json";
import enToolbar from "./en/toolbar.json";

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
  ...enPanels,
  ...enGraph,
  ...enShell,
  ...enDashboardFeatures,
  ...enToolbar,
};
export const de = {
  ...deCore,
  ...deAdmin,
  ...deDatasources,
  ...deDashboards,
  ...deExplore,
  ...deDocuments,
  ...deAnalysis,
  ...dePanels,
  ...deGraph,
  ...deShell,
  ...deDashboardFeatures,
  ...deToolbar,
};
