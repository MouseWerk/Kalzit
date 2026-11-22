// One catalog file per area and language, so work on different areas does not touch the same
// file. Keys are prefixed with their area (`admin.users.title`); the parity and guard tests run
// over the combined catalogs. Each language is its own module (en.ts, de.ts) and its own chunk:
// the app loads them through i18n.ts, one at a time; this module with both is for the tests. It
// holds the areas that load with their pages too (deferred.ts), so every rule covers them.
import { de as deStart } from "./de";
import deApps from "./de/apps.json";
import deGraphStyle from "./de/graphStyle.json";
import deProvisioning from "./de/provisioning.json";
import deReports from "./de/reports.json";
import deServerAdmin from "./de/serverAdmin.json";
import deSharing from "./de/sharing.json";
import deTraces from "./de/traces.json";
import { en as enStart } from "./en";
import enApps from "./en/apps.json";
import enGraphStyle from "./en/graphStyle.json";
import enProvisioning from "./en/provisioning.json";
import enReports from "./en/reports.json";
import enServerAdmin from "./en/serverAdmin.json";
import enSharing from "./en/sharing.json";
import enTraces from "./en/traces.json";

export const de = {
  ...deStart,
  ...deSharing,
  ...deProvisioning,
  ...deReports,
  ...deTraces,
  ...deServerAdmin,
  ...deApps,
  ...deGraphStyle,
};
export const en = {
  ...enStart,
  ...enSharing,
  ...enProvisioning,
  ...enReports,
  ...enTraces,
  ...enServerAdmin,
  ...enApps,
  ...enGraphStyle,
};
