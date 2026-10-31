import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { isApiError } from "../../api/client";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { EmptyState } from "../../components/EmptyState";
import { FormAlert } from "../../components/FormAlert";
import { Icon } from "../../components/Icon";
import { Page } from "../../components/Page";
import { TextField } from "../../components/TextField";
import { useI18n } from "../../i18n/i18n";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import { fetchDashboards } from "./api";
import {
  createPlaylist,
  deletePlaylist,
  fetchPlaylists,
  PLAYLISTS_KEY,
  type Playlist,
  type PlaylistItem,
  savePlaylist,
} from "./featuresApi";
import { ConfirmDialog, Dialog } from "./ui/Dialog";
import { errorMessage } from "./ui/errors";
import "./dashboards.css";
import "./dashboardTools.css";

/** Interval choices in seconds; a wall screen rarely needs less than half a minute. */
const INTERVALS = [10, 30, 60, 120, 300, 600, 1800, 3600];

/** Playlists: dashboards shown one after another, for wall screens. */
export function PlaylistsPage() {
  const { t } = useI18n();
  useDocumentTitle("playlists.title");
  const org = useCurrentOrg();
  return (
    <Page title={t("playlists.title")} lead={t("playlists.lead")}>
      <Breadcrumbs
        crumbs={[
          { label: t("dashboards.title"), link: { to: "/dashboards", search: {} } },
          { label: t("playlists.title") },
        ]}
      />
      {org === undefined ? null : <PlaylistList orgId={org.id} />}
    </Page>
  );
}

function intervalLabel(t: ReturnType<typeof useI18n>["t"], seconds: number): string {
  return seconds < 60
    ? t("playlists.seconds", { n: seconds })
    : t("playlists.minutes", { n: Math.round(seconds / 60) });
}

function PlaylistList({ orgId }: { orgId: string }) {
  const { t } = useI18n();
  const permissions = useOrgPermissions();
  const queryClient = useQueryClient();
  const canWrite = permissions.has("dashboards:write");
  const [editing, setEditing] = useState<Playlist | "new" | null>(null);
  const [deleting, setDeleting] = useState<Playlist | null>(null);
  const list = useQuery({
    queryKey: [PLAYLISTS_KEY, orgId],
    queryFn: ({ signal }) => fetchPlaylists(orgId, signal),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deletePlaylist(orgId, id),
    onSuccess: async () => {
      setDeleting(null);
      await queryClient.invalidateQueries({ queryKey: [PLAYLISTS_KEY, orgId] });
    },
  });
  const items = list.data ?? [];
  return (
    <>
      <div className="browser__header">
        <Link to="/dashboards" className="back-link">
          <Icon name="back" />
          {t("dashboards.backToList")}
        </Link>
        {canWrite ? (
          <button
            type="button"
            className="button button--primary"
            onClick={() => setEditing("new")}
          >
            {t("playlists.new")}
          </button>
        ) : null}
      </div>
      {list.isError ? <FormAlert>{errorMessage(t, list.error)}</FormAlert> : null}
      {list.isPending ? <p className="loading">{t("common.loading")}</p> : null}
      {!list.isPending && items.length === 0 ? (
        <EmptyState
          icon="dashboards"
          title={t("playlists.empty")}
          actions={
            canWrite ? (
              <button
                type="button"
                className="button button--secondary"
                onClick={() => setEditing("new")}
              >
                <Icon name="plus" />
                {t("playlists.createFirst")}
              </button>
            ) : undefined
          }
        >
          {canWrite ? t("playlists.emptyText") : t("playlists.emptyTextViewer")}
        </EmptyState>
      ) : null}
      {items.length === 0 ? null : (
        <ul className="tool-cards">
          {items.map((playlist) => (
            <li key={playlist.id} className="tool-card">
              <div className="tool-card__main">
                <h2 className="tool-card__title">{playlist.name}</h2>
                <p className="field__hint">
                  {t("playlists.summary", {
                    count: playlist.items.length,
                    interval: intervalLabel(t, playlist.intervalSeconds),
                  })}
                </p>
              </div>
              <div className="tool-card__actions">
                <Link
                  to="/dashboards/playlists/$playlistId/play"
                  params={{ playlistId: playlist.id }}
                  className="button button--primary button--small"
                  aria-label={t("playlists.playNamed", { name: playlist.name })}
                >
                  {t("playlists.play")}
                </Link>
                {canWrite ? (
                  <>
                    <button
                      type="button"
                      className="button button--secondary button--small"
                      onClick={() => setEditing(playlist)}
                      aria-label={t("playlists.editNamed", { name: playlist.name })}
                    >
                      {t("playlists.edit")}
                    </button>
                    <button
                      type="button"
                      className="button button--ghost button--small"
                      onClick={() => setDeleting(playlist)}
                      aria-label={t("playlists.deleteNamed", { name: playlist.name })}
                    >
                      {t("playlists.delete")}
                    </button>
                  </>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
      {editing === null ? null : (
        <PlaylistDialog
          orgId={orgId}
          playlist={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting === null ? null : (
        <ConfirmDialog
          title={t("playlists.deleteTitle")}
          confirmLabel={t("playlists.delete")}
          onCancel={() => setDeleting(null)}
          onConfirm={() => remove.mutate(deleting.id)}
          busy={remove.isPending}
          error={remove.isError ? errorMessage(t, remove.error) : undefined}
        >
          {t("playlists.deleteText", { name: deleting.name })}
        </ConfirmDialog>
      )}
    </>
  );
}

function PlaylistDialog({
  orgId,
  playlist,
  onClose,
}: {
  orgId: string;
  playlist: Playlist | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const formId = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState(playlist?.name ?? "");
  const [interval, setIntervalSeconds] = useState(playlist?.intervalSeconds ?? 60);
  const [items, setItems] = useState<PlaylistItem[]>(playlist?.items ?? []);
  const [q, setQ] = useState("");
  const [tag, setTag] = useState("");
  const [nameError, setNameError] = useState<string | undefined>();
  // Titles of the dashboards in the list, from searches and the list of all dashboards.
  const all = useQuery({
    queryKey: ["dashboards", orgId, "playlist-picker", q],
    queryFn: ({ signal }) => fetchDashboards(orgId, { q }, signal),
  });
  const known = useQuery({
    queryKey: ["dashboards", orgId, "playlist-titles"],
    queryFn: ({ signal }) => fetchDashboards(orgId, {}, signal),
  });
  const titleOf = (id: string) =>
    [...(known.data?.items ?? []), ...(all.data?.items ?? [])].find((d) => d.id === id)?.title ??
    id;
  const save = useMutation({
    mutationFn: () => {
      const input = { name: name.trim(), intervalSeconds: interval, items };
      return playlist === null
        ? createPlaylist(orgId, input).then(() => undefined)
        : savePlaylist(orgId, playlist.id, { ...input, version: playlist.version });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [PLAYLISTS_KEY, orgId] });
      onClose();
    },
  });
  const move = (index: number, by: number) =>
    setItems((list) => {
      const next = [...list];
      const [item] = next.splice(index, 1);
      if (item !== undefined)
        next.splice(Math.max(0, Math.min(list.length - 1, index + by)), 0, item);
      return next;
    });
  const itemLabel = (item: PlaylistItem) =>
    item.type === "dashboard"
      ? titleOf(item.dashboardId)
      : t("playlists.tagItem", { tag: item.tag });

  return (
    <Dialog
      title={playlist === null ? t("playlists.new") : t("playlists.editTitle")}
      onClose={onClose}
      size="large"
      actions={
        <>
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("dashboards.dialog.cancel")}
          </button>
          <button
            type="submit"
            form={formId}
            className="button button--primary"
            disabled={save.isPending}
          >
            {t("playlists.save")}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() === "") {
            setNameError(t("playlists.nameRequired"));
            return;
          }
          setNameError(undefined);
          save.mutate();
        }}
      >
        <FormAlert>
          {save.isError
            ? isApiError(save.error, "version_conflict")
              ? t("playlists.changed")
              : errorMessage(t, save.error)
            : undefined}
        </FormAlert>
        <TextField
          label={t("playlists.name")}
          value={name}
          onValueChange={setName}
          error={nameError}
          autoComplete="off"
          data-autofocus
        />
        <div className="field">
          <label className="field__label" htmlFor={`${formId}-interval`}>
            {t("playlists.interval")}
          </label>
          <select
            id={`${formId}-interval`}
            className="select"
            value={interval}
            onChange={(event) => setIntervalSeconds(Number(event.currentTarget.value))}
          >
            {INTERVALS.map((s) => (
              <option key={s} value={s}>
                {intervalLabel(t, s)}
              </option>
            ))}
          </select>
        </div>
        <section className="settings__group" aria-label={t("playlists.items")}>
          <p className="section-title">{t("playlists.items")}</p>
          {items.length === 0 ? <p className="field__hint">{t("playlists.noItems")}</p> : null}
          <ol className="tool-list">
            {items.map((item, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: entries keep their order and may repeat
              <li key={index} className="tool-list__item">
                <span className="truncate" title={itemLabel(item)}>
                  {itemLabel(item)}
                </span>
                <span className="tool-list__actions">
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                    aria-label={t("playlists.up", { name: itemLabel(item) })}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    disabled={index === items.length - 1}
                    onClick={() => move(index, 1)}
                    aria-label={t("playlists.down", { name: itemLabel(item) })}
                  >
                    ↓
                  </button>
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    onClick={() => setItems((list) => list.filter((_, i) => i !== index))}
                    aria-label={t("playlists.remove", { name: itemLabel(item) })}
                  >
                    {t("dashboards.editor.remove")}
                  </button>
                </span>
              </li>
            ))}
          </ol>
          <TextField
            label={t("playlists.addDashboard")}
            type="search"
            value={q}
            onValueChange={setQ}
            autoComplete="off"
          />
          <ul className="tool-list">
            {(all.data?.items ?? []).slice(0, 8).map((d) => (
              <li key={d.id} className="tool-list__item">
                <span className="truncate" title={d.title}>
                  {d.title}
                </span>
                <button
                  type="button"
                  className="button button--secondary button--small"
                  onClick={() =>
                    setItems((list) => [...list, { type: "dashboard", dashboardId: d.id }])
                  }
                  aria-label={t("playlists.addNamed", { name: d.title })}
                >
                  {t("playlists.add")}
                </button>
              </li>
            ))}
          </ul>
          <div className="tool-inline">
            <TextField
              label={t("playlists.addTag")}
              value={tag}
              onValueChange={setTag}
              autoComplete="off"
            />
            <button
              type="button"
              className="button button--secondary"
              disabled={tag.trim() === ""}
              onClick={() => {
                setItems((list) => [...list, { type: "tag", tag: tag.trim() }]);
                setTag("");
              }}
            >
              {t("playlists.addTagButton")}
            </button>
          </div>
        </section>
      </form>
    </Dialog>
  );
}
