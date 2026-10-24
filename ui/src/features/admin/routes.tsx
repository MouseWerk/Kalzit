import { createRoute, lazyRouteComponent, redirect } from "@tanstack/react-router";
import { appRoute } from "../../app/baseRoutes";
import { keepHash } from "../settings/keepHash";

// The admin area's pages: the administration with its sections. The user's own account and the
// settings sections moved to the settings page (features/settings); their old addresses
// redirect there. They load on first use, so people who never open them do not download them.

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
  // Organization settings live in the settings page now.
  beforeLoad: ({ location }) => {
    throw redirect({
      to: "/settings/$section",
      params: { section: "organization" },
      replace: true,
      ...keepHash(location),
    });
  },
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
  // Server settings live in the settings page now.
  beforeLoad: ({ location }) => {
    throw redirect({
      to: "/settings/$section",
      params: { section: "appearance" },
      replace: true,
      ...keepHash(location),
    });
  },
});

const serverAuditRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/server/audit",
  component: lazyRouteComponent(() => import("./server/ServerAuditPage"), "ServerAuditPage"),
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
    serverAuditRoute,
  ]),
] as const;
