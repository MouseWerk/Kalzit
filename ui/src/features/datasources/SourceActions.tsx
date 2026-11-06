import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useId, useState } from "react";
import { Icon } from "../../components/Icon";
import { Select } from "../../components/Select";
import { ToolbarMenu, type ToolbarMenuEntry } from "../../components/ToolbarMenu";
import { useI18n } from "../../i18n/i18n";
import { showErrorToast, showToast } from "../../lib/toasts";
import { useOrgPermissions } from "../../org/useOrg";
import {
  addGrant,
  adminKeys,
  type GrantLevel,
  levelsFor,
  listTeams,
  MAX_PAGE_SIZE,
} from "../admin/api";
import { LEVEL_TEXT } from "../admin/catalog";
import { Dialog } from "../admin/components/Dialog";
import { usePagedList } from "../admin/components/lists";
import { PagedSelect } from "../admin/components/PagedSelect";
import { downloadJson } from "../dashboards/exportImport";
import { errorMessage } from "../dashboards/ui/errors";
import { openWithSource } from "../explore/lastSource";
import {
  bulkDatasources,
  DATASOURCES_KEY,
  type DatasourceAccess,
  type DatasourceSummary,
  fetchDatasource,
} from "./api";
import { forgetHealth } from "./sourceStatus";
import "./datasources.css";

/** Moves sources to the trash (or back) and offers Undo; one request for any number. */
export function useTrash(orgId: string) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: [DATASOURCES_KEY, orgId] });
  return async (sources: readonly DatasourceSummary[]) => {
    const ids = sources.map((source) => source.id);
    const first = sources[0];
    if (first === undefined) {
      return false;
    }
    try {
      await bulkDatasources(orgId, "delete", ids);
    } catch (error) {
      showErrorToast(errorMessage(t, error));
      return false;
    }
    for (const id of ids) {
      forgetHealth(queryClient, orgId, id);
    }
    await refresh();
    showToast({
      message:
        sources.length === 1
          ? t("datasources.bulk.trashedOne", { name: first.name })
          : t("datasources.bulk.trashed", { count: sources.length }),
      undo: () => {
        bulkDatasources(orgId, "restore", ids)
          .then(async () => {
            await refresh();
            showToast({ message: t("datasources.bulk.restored", { count: sources.length }) });
          })
          .catch((error: unknown) => showErrorToast(errorMessage(t, error)));
      },
    });
    return true;
  };
}

/** The row's menu, as on the board: Explore, test, edit, share, duplicate, trash. */
export function RowMenu({
  source,
  access,
  onTest,
  onShare,
  onTrash,
}: {
  source: DatasourceSummary;
  access: DatasourceAccess;
  onTest: () => void;
  onShare: () => void;
  onTrash: () => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const permissions = useOrgPermissions();
  const entries: ToolbarMenuEntry[] = [];
  if (access.query) {
    entries.push(
      {
        key: "explore",
        label: t("datasources.menu.explore"),
        icon: "explore",
        onSelect: () => {
          openWithSource(source.id);
          void navigate({ to: "/explore" });
        },
      },
      { key: "test", label: t("datasources.menu.test"), icon: "refresh", onSelect: onTest },
    );
  }
  if (access.write) {
    entries.push({
      key: "edit",
      label: t("datasources.menu.edit"),
      icon: "edit",
      onSelect: () =>
        void navigate({ to: "/data-sources/$datasourceId", params: { datasourceId: source.id } }),
    });
  }
  if (access.permissions) {
    entries.push({
      key: "share",
      label: t("datasources.menu.share"),
      icon: "share",
      onSelect: onShare,
    });
  }
  // A copy is a new source: it takes the org-wide right to add one.
  if (permissions.has("datasources:write") && access.read) {
    entries.push({
      key: "duplicate",
      label: t("datasources.menu.duplicate"),
      icon: "copy",
      onSelect: () =>
        void navigate({ to: "/data-sources/new", search: { kind: source.kind, from: source.id } }),
    });
  }
  if (access.write) {
    entries.push(
      { kind: "separator", key: "separator" },
      {
        key: "trash",
        label: t("datasources.menu.trash"),
        icon: "trash",
        danger: true,
        onSelect: onTrash,
      },
    );
  }
  if (entries.length === 0) {
    return null;
  }
  return (
    <ToolbarMenu
      label={t("datasources.menu.label", { name: source.name })}
      icon="more"
      entries={entries}
    />
  );
}

/** The settings of the chosen sources as a file, without secrets (the server never sends them). */
export async function exportSources(orgId: string, sources: readonly DatasourceSummary[]) {
  const full = await Promise.all(sources.map((source) => fetchDatasource(orgId, source.id)));
  downloadJson(
    "datasources",
    full.map((source) => ({ name: source.name, kind: source.kind, settings: source.settings })),
  );
}

/**
 * The bar over the list while sources are selected: how many, and what may be done with all of
 * them. An action shows only when the caller may do it on every selected source.
 */
export function BulkBar({
  orgId,
  selected,
  total,
  accessOf,
  testing,
  onTest,
  onClear,
}: {
  orgId: string;
  selected: readonly DatasourceSummary[];
  total: number;
  accessOf: (source: DatasourceSummary) => DatasourceAccess;
  testing: boolean;
  onTest: () => void;
  onClear: () => void;
}) {
  const { t } = useI18n();
  const trash = useTrash(orgId);
  const [sharing, setSharing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const all = (allowed: (access: DatasourceAccess) => boolean) =>
    selected.every((source) => allowed(accessOf(source)));
  return (
    <section className="ds-bulk" aria-label={t("datasources.bulk.label")}>
      <span className="ds-bulk__count" role="status">
        {t("datasources.bulk.selected", { count: selected.length, total })}
      </span>
      <span className="ds-bulk__actions">
        {all((access) => access.query) ? (
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={onTest}
            disabled={testing}
          >
            <Icon name="refresh" />
            {testing ? t("datasources.health.testing") : t("datasources.bulk.test")}
          </button>
        ) : null}
        {all((access) => access.permissions) ? (
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => setSharing(true)}
          >
            <Icon name="share" />
            {t("datasources.bulk.share")}
          </button>
        ) : null}
        {all((access) => access.read) ? (
          <button
            type="button"
            className="button button--ghost button--small"
            disabled={exporting}
            onClick={() => {
              setExporting(true);
              exportSources(orgId, selected)
                .catch((error: unknown) => showErrorToast(errorMessage(t, error)))
                .finally(() => setExporting(false));
            }}
          >
            <Icon name="download" />
            {t("datasources.bulk.export")}
          </button>
        ) : null}
        {all((access) => access.write) ? (
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => {
              void trash(selected).then((done) => {
                if (done) {
                  onClear();
                }
              });
            }}
          >
            <Icon name="trash" />
            {t("datasources.bulk.trash")}
          </button>
        ) : null}
        <button type="button" className="button button--ghost button--small" onClick={onClear}>
          {t("datasources.bulk.clear")}
        </button>
      </span>
      {sharing ? (
        <ShareDialog orgId={orgId} sources={selected} onClose={() => setSharing(false)} />
      ) : null}
    </section>
  );
}

/** Gives one team a level on every chosen source; each grant is checked and audited on its own. */
function ShareDialog({
  orgId,
  sources,
  onClose,
}: {
  orgId: string;
  sources: readonly DatasourceSummary[];
  onClose: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const ids = { team: useId(), level: useId() };
  const levels = levelsFor("datasource");
  const [team, setTeam] = useState("");
  const [level, setLevel] = useState<GrantLevel>("query");
  const [busy, setBusy] = useState(false);
  const teams = usePagedList([...adminKeys.teams(orgId), "picker"], (cursor) =>
    listTeams(orgId, cursor, MAX_PAGE_SIZE),
  );
  const options = teams.items?.map((item) => ({ id: item.id, label: item.name }));
  const chosen = options?.find((option) => option.id === team) ?? options?.[0];

  async function share() {
    if (chosen === undefined || busy) {
      return;
    }
    setBusy(true);
    let failed = 0;
    for (const source of sources) {
      try {
        await addGrant(orgId, {
          subjectType: "team",
          subjectId: chosen.id,
          resourceType: "datasource",
          resourceId: source.id,
          level,
        });
      } catch {
        failed += 1;
      }
    }
    await queryClient.invalidateQueries({ queryKey: [DATASOURCES_KEY, orgId] });
    await queryClient.invalidateQueries({ queryKey: [...adminKeys.org(orgId), "grants"] });
    setBusy(false);
    if (failed > 0) {
      showErrorToast(t("datasources.bulk.shareFailed", { count: failed }));
    } else {
      showToast({
        message: t("datasources.bulk.shared", { team: chosen.label, count: sources.length }),
      });
    }
    onClose();
  }

  return (
    <Dialog
      open
      title={t("datasources.bulk.shareTitle", { count: sources.length })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("admin.common.cancel")}
          </button>
          <button
            type="button"
            className="button button--primary"
            aria-disabled={busy || chosen === undefined}
            onClick={() => void share()}
          >
            {t("datasources.bulk.shareConfirm")}
          </button>
        </>
      }
    >
      <div className="ds-share">
        <div className="field">
          <label className="field__label" htmlFor={ids.team}>
            {t("datasources.bulk.shareTeam")}
          </label>
          <PagedSelect
            id={ids.team}
            value={chosen?.id ?? ""}
            onChange={setTeam}
            options={options}
            error={teams.query.error}
            onRetry={() => void teams.query.refetch()}
            hasMore={teams.hasMore}
            onMore={teams.loadMore}
            loadingMore={teams.loadingMore}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor={ids.level}>
            {t("datasources.bulk.shareLevel")}
          </label>
          <Select
            id={ids.level}
            value={level}
            onChange={(next) => {
              const found = levels.find((candidate) => candidate === next);
              if (found !== undefined) {
                setLevel(found);
              }
            }}
          >
            {levels.map((candidate) => (
              <option key={candidate} value={candidate}>
                {t(LEVEL_TEXT[candidate])}
              </option>
            ))}
          </Select>
        </div>
      </div>
    </Dialog>
  );
}
