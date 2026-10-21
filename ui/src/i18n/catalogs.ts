// One catalog file per area and language, so work on different areas does not touch the same
// file. Keys are prefixed with their area (`admin.users.title`); the parity and guard tests run
// over the combined catalogs.
import deAdmin from "./de/admin.json";
import deCore from "./de/core.json";
import deDashboards from "./de/dashboards.json";
import deDatasources from "./de/datasources.json";
import deDocuments from "./de/documents.json";
import deExplore from "./de/explore.json";
import enAdmin from "./en/admin.json";
import enCore from "./en/core.json";
import enDashboards from "./en/dashboards.json";
import enDatasources from "./en/datasources.json";
import enDocuments from "./en/documents.json";
import enExplore from "./en/explore.json";

export const en = {
  ...enCore,
  ...enAdmin,
  ...enDatasources,
  ...enDashboards,
  ...enExplore,
  ...enDocuments,
};
export const de = {
  ...deCore,
  ...deAdmin,
  ...deDatasources,
  ...deDashboards,
  ...deExplore,
  ...deDocuments,
};
