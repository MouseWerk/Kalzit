// Areas whose texts load with their pages instead of with the language: the catalogs of an area
// that only its own lazy pages show (sharing, provisioning, reports, traces, ...) stay out of the language chunk every
// page waits for. Their keys are part of `MessageKey` like all others; i18n.ts merges an area
// into the loaded catalogs when a page asks for it (`loadArea`).
import type enApps from "./en/apps.json";
import type enProvisioning from "./en/provisioning.json";
import type enReports from "./en/reports.json";
import type enServerAdmin from "./en/serverAdmin.json";
import type enSharing from "./en/sharing.json";
import type enTraces from "./en/traces.json";

export type DeferredMessages = typeof enSharing &
  typeof enProvisioning &
  typeof enReports &
  typeof enTraces &
  typeof enServerAdmin &
  typeof enApps;

export const DEFERRED_AREAS = [
  "sharing",
  "provisioning",
  "reports",
  // The trace screens: the search form, the trace panel and the forms of the trace steps.
  "traces",
  // The server sections of 0.7.5 (CORS, self-registration with the visitor's pages, backups).
  "serverAdmin",
  "apps",
] as const;
export type DeferredArea = (typeof DEFERRED_AREAS)[number];

type Messages = Record<string, string>;

const pick = (module: { default: Messages }): Messages => module.default;

/** One chunk per area and language, fetched when the area is first shown in that language. */
export const AREA_LOADERS: Record<DeferredArea, Record<"de" | "en", () => Promise<Messages>>> = {
  sharing: {
    de: () => import("./de/sharing.json").then(pick),
    en: () => import("./en/sharing.json").then(pick),
  },
  provisioning: {
    de: () => import("./de/provisioning.json").then(pick),
    en: () => import("./en/provisioning.json").then(pick),
  },
  reports: {
    de: () => import("./de/reports.json").then(pick),
    en: () => import("./en/reports.json").then(pick),
  },
  traces: {
    de: () => import("./de/traces.json").then(pick),
    en: () => import("./en/traces.json").then(pick),
  },
  serverAdmin: {
    de: () => import("./de/serverAdmin.json").then(pick),
    en: () => import("./en/serverAdmin.json").then(pick),
  },
  apps: {
    de: () => import("./de/apps.json").then(pick),
    en: () => import("./en/apps.json").then(pick),
  },
};
