import { Icon } from "../../../components/Icon";
import { type MessageKey, useI18n } from "../../../i18n/i18n";
import { type AppPageInfo, appInitials, pageTitle } from "./api";
import "./apps.css";

const CAPABILITY_TEXT: Record<string, MessageKey> = {
  "dashboards:read": "apps.cap.dashboards",
  "analyses:read": "apps.cap.analyses",
  "analyses:run": "apps.cap.run",
  storage: "apps.cap.storage",
};

/**
 * What an app may ask Kalzit for, in words (board Settings075.dc.html, frames 8 and 9), with the
 * rule that holds for all of it: always with the rights of the person who uses the app, and
 * read-only. A capability this version of the page has no words for is shown as the manifest
 * names it, so nothing is approved unseen. `added` marks what an update asks for anew.
 */
export function CapabilityList({
  capabilities,
  added = [],
}: {
  capabilities: readonly string[];
  added?: readonly string[];
}) {
  const { t } = useI18n();
  if (capabilities.length === 0) {
    return <p className="app-caps__none">{t("apps.cap.none")}</p>;
  }
  return (
    <>
      <ul className="app-caps">
        {capabilities.map((capability) => {
          const key = CAPABILITY_TEXT[capability];
          return (
            <li key={capability} className="app-caps__item">
              <Icon name="check" />
              <span>
                {key === undefined ? <code translate="no">{capability}</code> : t(key)}
                {added.includes(capability) ? (
                  <span className="app-caps__new"> {t("apps.cap.new")}</span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="app-caps__rule">{t("apps.cap.rule")}</p>
    </>
  );
}

/**
 * What approving an app grants (frame 9): the pages it brings into the navigation, what it may
 * ask Kalzit for, and what it never gets.
 */
export function AppGrants({
  pages,
  capabilities,
  added,
  update = false,
}: {
  /** An update waits for approval: the pages are those of the version installed now. */
  update?: boolean;
  pages: readonly AppPageInfo[];
  capabilities: readonly string[];
  added: readonly string[];
}) {
  const { t, language } = useI18n();
  return (
    <div className="app-grants">
      <h3 className="app-grants__heading">{t("apps.pagesNew")}</h3>
      <p className="app-caps__rule">{pages.map((page) => pageTitle(page, language)).join(", ")}</p>
      {/* The server lists the pages of the installed version only. */}
      {update ? <p className="app-caps__rule">{t("apps.pagesPending")}</p> : null}
      <h3 className="app-grants__heading">{t("apps.caps")}</h3>
      <CapabilityList capabilities={capabilities} added={added} />
      <p className="app-caps__rule">{t("apps.never")}</p>
    </div>
  );
}

export { appInitials };
