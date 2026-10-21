/**
 * The data areas load their pages lazily (features/<area>/routes.tsx). Test files that navigate
 * to them load the modules once in a beforeAll, so the first navigation of a test does not wait
 * on a cold module transform and time out.
 */
export async function preloadDataPages(): Promise<void> {
  await Promise.all([
    import("../DashboardsPage"),
    import("../DashboardPage"),
    import("../TrashPage"),
    import("../VersionsPage"),
    import("../../datasources/DataSourcesPage"),
    import("../../datasources/DataSourceForm"),
    import("../../explore/ExplorePage"),
  ]);
}
