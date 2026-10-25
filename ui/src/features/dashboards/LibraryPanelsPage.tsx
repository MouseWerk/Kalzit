import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { isApiError } from "../../api/client";
import { EmptyState } from "../../components/EmptyState";
import { FormAlert } from "../../components/FormAlert";
import { Icon } from "../../components/Icon";
import { Page } from "../../components/Page";
import { TextField } from "../../components/TextField";
import { useI18n } from "../../i18n/i18n";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { useCurrentOrg } from "../../org/useOrg";
import { foldersQuery } from "./api";
import {
  deleteLibraryPanel,
  fetchLibraryPanels,
  fetchLibraryUses,
  LIBRARY_PANELS_KEY,
  type LibraryPanel,
} from "./featuresApi";
import { ConfirmDialog } from "./ui/Dialog";
import { errorMessage } from "./ui/errors";
import "./dashboards.css";
import "./dashboardTools.css";

/** Pause in typing after which the library panel search runs. */
export const LIBRARY_SEARCH_DELAY_MS = 250;

/**
 * Library panels of the organization that the viewer may see. They are added to dashboards and
 * changed from a dashboard's edit mode; here they are found, their uses listed and unused ones
 * deleted.
 */
export function LibraryPanelsPage() {
  const { t } = useI18n();
  useDocumentTitle("libraryPanels.title");
  const org = useCurrentOrg();
  return (
    <Page title={t("libraryPanels.title")} lead={t("libraryPanels.lead")}>
      {org === undefined ? null : <LibraryList orgId={org.id} />}
    </Page>
  );
}

function LibraryList({ orgId }: { orgId: string }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  // The search asks the server once typing pauses, not for every letter.
  const [searched, setSearched] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setSearched(q), LIBRARY_SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [q]);
  const [deleting, setDeleting] = useState<LibraryPanel | null>(null);
  const folders = useQuery(foldersQuery(orgId));
  const list = useQuery({
    queryKey: [LIBRARY_PANELS_KEY, orgId, "list", searched],
    queryFn: ({ signal }) => fetchLibraryPanels(orgId, searched, signal),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteLibraryPanel(orgId, id),
    onSuccess: async () => {
      setDeleting(null);
      await queryClient.invalidateQueries({ queryKey: [LIBRARY_PANELS_KEY, orgId] });
    },
  });
  const items = list.data ?? [];
  const folderName = (id: string | null) =>
    id === null
      ? t("dashboards.folders.none")
      : (folders.data?.find((f) => f.id === id)?.name ?? id);
  return (
    <>
      <div className="browser__header">
        <Link to="/dashboards" className="back-link">
          <Icon name="back" />
          {t("dashboards.backToList")}
        </Link>
        <div className="browser__search">
          <TextField
            label={t("libraryPanels.search")}
            type="search"
            value={q}
            onValueChange={setQ}
            autoComplete="off"
          />
        </div>
      </div>
      {list.isError ? <FormAlert>{errorMessage(t, list.error)}</FormAlert> : null}
      {!list.isPending && items.length === 0 ? (
        <EmptyState
          icon="dashboards"
          title={t("libraryPanels.empty")}
          actions={
            searched === "" ? (
              <Link to="/dashboards" className="button button--secondary">
                {t("libraryPanels.openDashboards")}
              </Link>
            ) : undefined
          }
        >
          {t("libraryPanels.emptyText")}
        </EmptyState>
      ) : null}
      <ul className="tool-cards">
        {items.map((panel) => (
          <li key={panel.id} className="tool-card">
            <div className="tool-card__main">
              <h2 className="tool-card__title">{panel.name}</h2>
              <p className="field__hint">
                {t("libraryPanels.where", { folder: folderName(panel.folderId) })}
                {" · "}
                {t("libraryPanels.uses", { count: panel.uses })}
              </p>
              <Uses orgId={orgId} panel={panel} />
            </div>
            {panel.access.delete ? (
              <div className="tool-card__actions">
                <button
                  type="button"
                  className="button button--ghost button--small"
                  disabled={panel.uses > 0}
                  title={panel.uses > 0 ? t("libraryPanels.inUse") : undefined}
                  onClick={() => setDeleting(panel)}
                  aria-label={t("libraryPanels.deleteNamed", { name: panel.name })}
                >
                  {t("libraryPanels.delete")}
                </button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
      {deleting === null ? null : (
        <ConfirmDialog
          title={t("libraryPanels.deleteTitle")}
          confirmLabel={t("libraryPanels.delete")}
          onCancel={() => setDeleting(null)}
          onConfirm={() => remove.mutate(deleting.id)}
          busy={remove.isPending}
          error={
            remove.isError
              ? isApiError(remove.error, "conflict")
                ? t("libraryPanels.inUse")
                : errorMessage(t, remove.error)
              : undefined
          }
        >
          {t("libraryPanels.deleteText", { name: deleting.name })}
        </ConfirmDialog>
      )}
    </>
  );
}

/** The dashboards showing a library panel, read when opened. */
function Uses({ orgId, panel }: { orgId: string; panel: LibraryPanel }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const uses = useQuery({
    queryKey: [LIBRARY_PANELS_KEY, orgId, "uses", panel.id],
    queryFn: ({ signal }) => fetchLibraryUses(orgId, panel.id, signal),
    enabled: open,
  });
  if (panel.uses === 0) {
    return null;
  }
  return (
    <details className="tool-uses" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{t("libraryPanels.showUses")}</summary>
      <ul className="tool-list">
        {(uses.data?.items ?? []).map((d) => (
          <li key={d.id}>
            <Link to="/dashboards/$dashboardId" params={{ dashboardId: d.id }}>
              {d.title}
            </Link>
          </li>
        ))}
      </ul>
    </details>
  );
}
