import { useI18n } from "../../i18n/i18n";
import { zoneOption } from "../../lib/timeSettings";
import type { Dashboard } from "./api";
import { BROWSER_ZONE } from "./model";
import { Dialog } from "./ui/Dialog";
import "./toolbar.css";

/** What the rail's Info shows: where the dashboard lies, its version and its time options. */
export function DashboardInfo({
  dashboard,
  folder,
  onClose,
}: {
  dashboard: Dashboard;
  /** The folder's name, when it is known and the caller may see it. */
  folder: string | undefined;
  onClose: () => void;
}) {
  const { t, language, timeZone } = useI18n();
  const model = dashboard.model;
  const saved = new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
    ...zoneOption(timeZone),
  }).format(dashboard.updatedAt);
  const zone =
    model.timeZone === undefined
      ? t("toolbar.info.zoneViewer")
      : model.timeZone === BROWSER_ZONE
        ? t("toolbar.settings.timeZoneBrowser", {
            zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          })
        : model.timeZone;
  const rows: [string, string][] = [
    [t("toolbar.info.folder"), folder ?? t("toolbar.info.noFolder")],
    [t("toolbar.info.version"), String(dashboard.version)],
    [t("toolbar.info.updated"), saved],
    [t("toolbar.info.panels"), String(model.panels.length)],
    [
      t("toolbar.info.tags"),
      (model.tags ?? []).length === 0 ? t("toolbar.info.noTags") : (model.tags ?? []).join(", "),
    ],
    [t("toolbar.info.timeZone"), zone],
  ];
  return (
    <Dialog title={t("toolbar.info.title")} onClose={onClose} size="small">
      <dl className="dash-info">
        {rows.map(([term, value]) => (
          <div key={term} className="dash-info__row">
            <dt className="dash-info__term">{term}</dt>
            <dd className="dash-info__value">{value}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
