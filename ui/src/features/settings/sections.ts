import type { SettingKey } from "../../api/generated/shapes";
import type { MessageKey } from "../../i18n/i18n";
import type { OrgPermissions } from "../../org/useOrg";

/**
 * The sections of the settings page, in navigation order, and the rows each holds. A registry
 * setting the server adds belongs in one section here (a test checks every key is placed).
 */

export type SettingsGroup = "server" | "org" | "personal";

export type SectionKind =
  | "settings"
  /** The network rows, then the ACME certificates (`AcmeSection`). */
  | "network"
  | "appearance"
  | "planned"
  /** The mail server (`MailSection`, docs/design/blueprint/Identity.dc.html frame 6). */
  | "mail"
  | "ai"
  | "aiOrg"
  | "plugins"
  | "pluginsOrg"
  | "updates"
  | "profile"
  /** The account's sign-in and second factor (features/security). */
  | "accountSecurity"
  /** The server's second factor policy, and later the sign-in providers. */
  | "signin"
  | "shortcuts"
  | "transfer"
  | "about";

export interface SettingsAccess {
  permissions: OrgPermissions;
  /** The organization the user works in, if any. */
  orgId: string | undefined;
}

export interface SectionDef {
  id: string;
  group: SettingsGroup | "footer";
  kind: SectionKind;
  label: MessageKey;
  lead: MessageKey;
  /** Words people may search for, in the catalog of each language. */
  keywords: MessageKey;
  /** Registry rows, in display order. */
  keys?: readonly SettingKey[];
  /** For `planned` sections: the text that says what comes. */
  planned?: MessageKey;
  visible: (access: SettingsAccess) => boolean;
}

const serverAdmin = (access: SettingsAccess) => access.permissions.isServerAdmin;

/**
 * The sign-in settings, changed only through `PUT /admin/sign-in/local` and
 * `PUT /admin/sign-in/unmapped` (docs/api/sso.md), so the page that changes them checks that
 * nobody is locked out. Listed as plain strings: the generated registry keys follow the server.
 */
const SIGN_IN_KEYS: readonly string[] = [
  "signin.local_password",
  "signin.password_form",
  "signin.break_glass_user",
  "signin.unmapped",
  "signin.default_org",
  "signin.default_role",
];

/** Extra rows of the appearance section that are not one registry setting. */
export const LOGO_ROW = "appearance.logo";
export const SIGN_IN_ROW = "signin.page";

/** Rows of the appearance section, in the order of the design: theme, accent, logo and name, ... */
export const APPEARANCE_ROWS = [
  "appearance.default_theme",
  "appearance.accent",
  LOGO_ROW,
  "appearance.product_name",
  "appearance.density",
  "appearance.font_size",
  "appearance.default_language",
  SIGN_IN_ROW,
] as const;

export const SECTIONS: readonly SectionDef[] = [
  {
    id: "appearance",
    group: "server",
    kind: "appearance",
    label: "settings.section.appearance.label",
    lead: "settings.section.appearance.lead",
    keywords: "settings.section.appearance.keywords",
    keys: [
      "appearance.default_theme",
      "appearance.accent",
      "appearance.product_name",
      "appearance.density",
      "appearance.font_size",
      "appearance.default_language",
      "signin.welcome",
      "signin.notice",
    ],
    visible: serverAdmin,
  },
  {
    id: "general",
    group: "server",
    kind: "settings",
    label: "settings.section.general.label",
    lead: "settings.section.general.lead",
    keywords: "settings.section.general.keywords",
    keys: [
      "appearance.start_page",
      "appearance.time_zone",
      "appearance.week_start",
      "log.level",
      "log.format",
    ],
    visible: serverAdmin,
  },
  {
    id: "network",
    group: "server",
    kind: "network",
    label: "settings.section.network.label",
    lead: "settings.section.network.lead",
    keywords: "settings.section.network.keywords",
    keys: [
      "server.public_url",
      "server.http_addr",
      "server.https_addr",
      "server.redirect_http_to_https",
      "tls.cert_file",
      "tls.min_version",
      "tls.reload_interval_secs",
      "security.trusted_proxies",
    ],
    visible: serverAdmin,
  },
  {
    id: "security",
    group: "server",
    kind: "settings",
    label: "settings.section.security.label",
    lead: "settings.section.security.lead",
    keywords: "settings.section.security.keywords",
    keys: [
      "sessions.lifetime_hours",
      "sessions.idle_timeout_hours",
      "security.hsts",
      "security.hsts_max_age_secs",
      "security.login_max_failures",
      "security.login_window_secs",
      "security.setup_max_failures",
      "security.setup_window_secs",
    ],
    visible: serverAdmin,
  },
  {
    // The board docs/design/blueprint/Identity.dc.html, frames 5A to 5G: providers, group
    // mapping, the local sign-in and the second factor's policy on the server.
    id: "signin",
    group: "server",
    kind: "signin",
    label: "settings.section.signin.label",
    lead: "settings.section.signin.lead",
    keywords: "settings.section.signin.keywords",
    keys: [
      ...SIGN_IN_KEYS,
      "security.two_factor_required",
      "security.two_factor_methods",
    ] as readonly SettingKey[],
    visible: serverAdmin,
  },
  {
    id: "email",
    group: "server",
    kind: "mail",
    label: "settings.section.email.label",
    lead: "settings.section.email.lead",
    keywords: "settings.section.email.keywords",
    visible: serverAdmin,
  },
  {
    id: "datasources",
    group: "server",
    kind: "settings",
    label: "settings.section.datasources.label",
    lead: "settings.section.datasources.lead",
    keywords: "settings.section.datasources.keywords",
    keys: [
      "datasources.allowed_targets",
      "datasources.sqlite_dirs",
      "datasources.file_dirs",
      "datasources.query_timeout_secs",
      "datasources.max_rows",
      "datasources.max_response_bytes",
      "datasources.max_parallel_queries",
      "datasources.max_inflight_bytes",
      "datasources.cache_enabled",
      "datasources.cache_max_bytes",
    ],
    visible: serverAdmin,
  },
  {
    // The board docs/design/blueprint/Plugins.dc.html: tabs for the installed plugins, the
    // catalog and the trusted keys; each plugin has its own page (`/settings/plugins/<id>`).
    id: "plugins",
    group: "server",
    kind: "plugins",
    label: "settings.section.plugins.label",
    lead: "settings.section.plugins.lead",
    keywords: "settings.section.plugins.keywords",
    // The catalog's settings live in its tab (`#catalog`).
    keys: ["plugins.catalog_enabled", "plugins.catalog_url", "plugins.catalog_refresh_hours"],
    visible: serverAdmin,
  },
  {
    // The page follows the board docs/design/blueprint/AI.dc.html, frames 1 to 4 and 7. The
    // organization's AI keys belong to "AI of the organization" (frame 5).
    id: "ai",
    group: "server",
    kind: "ai",
    label: "settings.section.ai.label",
    lead: "settings.section.ai.lead",
    keywords: "settings.section.ai.keywords",
    keys: [
      "ai.enabled",
      "ai.allow_org_providers",
      "ai.user_requests_per_day",
      "ai.user_tokens_per_day",
      "ai.org_tokens_per_month",
      "ai.max_rows_to_model",
      "ai.max_tool_calls",
      "ai.provider_explain",
      "ai.provider_summarize",
      "ai.provider_chat",
      "ai.max_concurrent",
      "ai.max_concurrent_per_org",
      "ai.max_concurrent_per_user",
      "ai.request_timeout_secs",
      "ai.chat_retention_days",
      "ai.notice_text",
    ],
    visible: serverAdmin,
  },
  {
    id: "storage",
    group: "server",
    kind: "settings",
    label: "settings.section.storage.label",
    lead: "settings.section.storage.lead",
    keywords: "settings.section.storage.keywords",
    keys: [
      "audit.retention_days",
      "dashboards.version_retention",
      "usage.enabled",
      "usage.retention_days",
    ],
    visible: serverAdmin,
  },
  {
    id: "updates",
    group: "server",
    kind: "updates",
    label: "settings.section.updates.label",
    lead: "settings.section.updates.lead",
    keywords: "settings.section.updates.keywords",
    keys: [
      "updates.channel",
      "updates.check_daily",
      "updates.window",
      "updates.keep_versions",
      "updates.health_timeout_secs",
    ],
    visible: serverAdmin,
  },
  {
    id: "organization",
    group: "org",
    kind: "settings",
    label: "settings.section.organization.labelPlain",
    lead: "settings.section.organization.lead",
    keywords: "settings.section.organization.keywords",
    keys: [
      "appearance.accent",
      "appearance.density",
      "appearance.font_size",
      "appearance.start_page",
      "appearance.time_zone",
      "appearance.week_start",
      "dashboards.default_time_range",
      "dashboards.new_in_team_space",
      // Organizations may only be stricter than the server: inherit, or off for their members.
      "signin.local_password" as string as SettingKey,
      "security.two_factor_required",
    ],
    visible: (access) => access.orgId !== undefined && access.permissions.has("settings:read"),
  },
  {
    id: "org-ai",
    group: "org",
    kind: "aiOrg",
    label: "settings.section.orgAi.label",
    lead: "settings.section.orgAi.lead",
    keywords: "settings.section.orgAi.keywords",
    keys: [
      "ai.org_enabled",
      "ai.user_requests_per_day",
      "ai.user_tokens_per_day",
      "ai.org_tokens_per_month",
      "ai.chat_retention_days",
    ],
    visible: (access) => access.orgId !== undefined && access.permissions.has("settings:read"),
  },
  {
    id: "org-plugins",
    group: "org",
    kind: "pluginsOrg",
    label: "settings.section.orgPlugins.label",
    lead: "settings.section.orgPlugins.lead",
    keywords: "settings.section.orgPlugins.keywords",
    visible: (access) => access.orgId !== undefined && access.permissions.has("plugins:configure"),
  },
  {
    id: "profile",
    group: "personal",
    kind: "profile",
    label: "settings.section.profile.label",
    lead: "settings.section.profile.lead",
    keywords: "settings.section.profile.keywords",
    visible: () => true,
  },
  {
    // Frame 4A of the board docs/design/blueprint/Identity.dc.html.
    id: "account-security",
    group: "personal",
    kind: "accountSecurity",
    label: "settings.section.accountSecurity.label",
    lead: "settings.section.accountSecurity.lead",
    keywords: "settings.section.accountSecurity.keywords",
    visible: () => true,
  },
  {
    id: "shortcuts",
    group: "personal",
    kind: "shortcuts",
    label: "settings.section.shortcuts.label",
    lead: "settings.section.shortcuts.lead",
    keywords: "settings.section.shortcuts.keywords",
    visible: () => true,
  },
  {
    id: "transfer",
    group: "footer",
    kind: "transfer",
    label: "settings.section.transfer.label",
    lead: "settings.section.transfer.lead",
    keywords: "settings.section.transfer.keywords",
    visible: (access) =>
      access.permissions.isServerAdmin ||
      (access.orgId !== undefined && access.permissions.has("settings:write")),
  },
  {
    id: "about",
    group: "footer",
    kind: "about",
    label: "settings.section.about.label",
    lead: "settings.section.about.lead",
    keywords: "settings.section.about.keywords",
    visible: () => true,
  },
];

export function findSection(id: string): SectionDef | undefined {
  return SECTIONS.find((section) => section.id === id);
}

/**
 * The update settings that have their one place on the Updates page (board Updates.dc.html, the
 * status strip): the section links there instead of a second set of controls, and a search for
 * one of them opens that page at its cell (`/admin/server/updates#updates.channel`).
 */
export const UPDATES_PAGE_KEYS: readonly string[] = [
  "updates.channel",
  "updates.check_daily",
  "updates.window",
];

/** The section a row lives in: its id and the row's element id. */
export function rowId(section: SectionDef, key: string): string {
  if (section.kind === "appearance" && (key === "signin.welcome" || key === "signin.notice")) {
    return SIGN_IN_ROW;
  }
  return section.group === "org" ? `org.${key}` : key;
}
