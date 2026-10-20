import { createRoute } from "@tanstack/react-router";
import { appRoute } from "../../app/baseRoutes";
import { AdminLayout, AdminOverview } from "./AdminLayout";
import { AccountPage } from "./account/AccountPage";
import { AuditPage } from "./org/AuditPage";
import { MembersPage } from "./org/MembersPage";
import { OrgSettingsPage } from "./org/OrgSettingsPage";
import { RoleEditorPage } from "./org/RoleEditorPage";
import { RolesPage } from "./org/RolesPage";
import { TeamPage } from "./org/TeamPage";
import { TeamsPage } from "./org/TeamsPage";
import { OrgsPage } from "./server/OrgsPage";
import { ServerAuditPage } from "./server/ServerAuditPage";
import { ServerSettingsPage } from "./server/ServerSettingsPage";
import { UsersPage } from "./server/UsersPage";

// The admin area's pages: the administration with its sections, and the user's own account
// (self service for everyone, kept in this area because it shares the access model and texts).
const adminRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/admin",
  component: AdminLayout,
});

const overviewRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/",
  component: AdminOverview,
});

const membersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/members",
  component: MembersPage,
});

const teamsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/teams",
  component: TeamsPage,
});

const teamRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/teams/$teamId",
  component: function TeamRoutePage() {
    const { teamId } = teamRoute.useParams();
    // Keyed, so moving between teams starts with fresh state.
    return <TeamPage key={teamId} teamId={teamId} />;
  },
});

const rolesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/roles",
  component: RolesPage,
});

const roleRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/roles/$roleId",
  component: function RoleRoutePage() {
    const { roleId } = roleRoute.useParams();
    return <RoleEditorPage key={roleId} roleId={roleId} />;
  },
});

const orgSettingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/settings",
  component: OrgSettingsPage,
});

const auditRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/audit",
  component: AuditPage,
});

const usersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/server/users",
  component: UsersPage,
});

const orgsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/server/organizations",
  component: OrgsPage,
});

const serverSettingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/server/settings",
  component: ServerSettingsPage,
});

const serverAuditRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/server/audit",
  component: ServerAuditPage,
});

const accountRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/account",
  component: AccountPage,
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
  accountRoute,
] as const;
