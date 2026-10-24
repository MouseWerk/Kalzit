import { createRoute, lazyRouteComponent } from "@tanstack/react-router";
import { appRoute } from "../../app/baseRoutes";

// The admin area's pages: the administration with its sections, and the user's own account
// (self service for everyone, kept in this area because it shares the access model and texts).
// They load on first use, so people who never open them do not download them.

const adminRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admin",
  component: lazyRouteComponent(() => import("./AdminLayout"), "AdminLayout"),
});

const overviewRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/",
  component: lazyRouteComponent(() => import("./AdminLayout"), "AdminOverview"),
});

const membersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/members",
  component: lazyRouteComponent(() => import("./org/MembersPage"), "MembersPage"),
});

const teamsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/teams",
  component: lazyRouteComponent(() => import("./org/TeamsPage"), "TeamsPage"),
});

const teamRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/teams/$teamId",
  component: lazyRouteComponent(() => import("./org/TeamPage"), "TeamRoutePage"),
});

const rolesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/roles",
  component: lazyRouteComponent(() => import("./org/RolesPage"), "RolesPage"),
});

const roleRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/roles/$roleId",
  component: lazyRouteComponent(() => import("./org/RoleEditorPage"), "RoleRoutePage"),
});

const orgSettingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/settings",
  component: lazyRouteComponent(() => import("./org/OrgSettingsPage"), "OrgSettingsPage"),
});

const auditRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/audit",
  component: lazyRouteComponent(() => import("./org/AuditPage"), "AuditPage"),
});

const usersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/server/users",
  component: lazyRouteComponent(() => import("./server/UsersPage"), "UsersPage"),
});

const orgsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/server/organizations",
  component: lazyRouteComponent(() => import("./server/OrgsPage"), "OrgsPage"),
});

const serverSettingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/server/settings",
  component: lazyRouteComponent(() => import("./server/ServerSettingsPage"), "ServerSettingsPage"),
});

// The settings navigation links here (`/admin/server/updates`).
const updatesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/server/updates",
  component: lazyRouteComponent(() => import("./server/UpdatesPage"), "UpdatesPage"),
});

const serverAuditRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/server/audit",
  component: lazyRouteComponent(() => import("./server/ServerAuditPage"), "ServerAuditPage"),
});

const accountRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/account",
  component: lazyRouteComponent(() => import("./account/AccountPage"), "AccountPage"),
});

export const adminRoutes = [
  adminRoute.addChildren([
    overviewRoute,
    membersRoute,
    teamsRoute,
    teamRoute,
    rolesRoute,
    roleRoute,
    orgSettingsRoute,
    auditRoute,
    usersRoute,
    orgsRoute,
    serverSettingsRoute,
    updatesRoute,
    serverAuditRoute,
  ]),
  accountRoute,
] as const;
