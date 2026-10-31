import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type DragEvent, type KeyboardEvent, useState } from "react";
import { Icon } from "../../../components/Icon";
import { ToolbarMenu } from "../../../components/ToolbarMenu";
import { type Translate, useI18n } from "../../../i18n/i18n";
import { ConfirmDialog } from "../components/Dialog";
import { formatDateTime } from "../components/format";
import { useNotice } from "../components/Notice";
import {
  deleteProvider,
  type ProviderSummary,
  type SignInOverview,
  setProviderEnabled,
  setProviderOrder,
  ssoKeys,
} from "./api";
import { KindDialog, type ProviderKind } from "./KindDialog";
import { LdapDialog } from "./LdapDialog";
import { LdapSyncDialog } from "./LdapSyncDialog";
import { ProviderDialog } from "./ProviderDialog";
import { ssoErrorText } from "./texts";
import "../../datasources/datasources.css";
import "./sso.css";

type Editing =
  | { mode: "add"; kind: ProviderKind }
  | { mode: "edit"; provider: ProviderSummary; startTest: boolean }
  | { mode: "sync"; provider: ProviderSummary }
  | null;

/** The short mark of a provider kind, as on the board ("OI" for OpenID Connect, "LD" for LDAP). */
function kindMark(kind: string): string {
  if (kind === "oidc") return "OI";
  if (kind === "ldap") return "LD";
  return kind.slice(0, 2).toUpperCase();
}

/** "OpenID Connect", "LDAP · Active Directory" (the summary's `flavor`, when it says) or "LDAP". */
export function kindLabel(t: Translate, kind: string, flavor?: string): string {
  if (kind === "oidc") return t("sso.kind.oidc");
  if (kind === "ldap") return t(flavor === "ad" ? "sso.kind.ldapAd" : "sso.kind.ldap");
  return kind;
}

/** Status dot and word: active and checked, active but never checked, or paused. */
function providerStatus(t: Translate, provider: ProviderSummary) {
  if (!provider.enabled) {
    return { status: "untested", text: t("sso.providers.status.paused") };
  }
  if (provider.checkedAt === null) {
    return { status: "untested", text: t("sso.providers.status.unchecked") };
  }
  return { status: "connected", text: t("sso.providers.status.active") };
}

/** The ids in their new order after moving `id` by `step` places. */
function moved(ids: readonly string[], id: string, to: number): string[] {
  const rest = ids.filter((candidate) => candidate !== id);
  const index = Math.max(0, Math.min(to, rest.length));
  return [...rest.slice(0, index), id, ...rest.slice(index)];
}

/**
 * The providers (board frame 5A): kind, place on the sign-in page, status and people, "Edit" and
 * a menu with pause, test sign-in and remove. The handle or Alt+Arrow changes the order of the
 * buttons at once, with undo.
 */
export function ProvidersTab({
  overview,
  adding,
  onAdded,
}: {
  overview: SignInOverview;
  adding: boolean;
  onAdded: () => void;
}) {
  const { t, language, timeZone } = useI18n();
  const queryClient = useQueryClient();
  const notice = useNotice();
  const [editing, setEditing] = useState<Editing>(null);
  const [removing, setRemoving] = useState<ProviderSummary | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const providers = [...overview.providers].sort((a, b) => a.position - b.position);
  const ids = providers.map((provider) => provider.id);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ssoKeys.all });

  /** Shows the new order at once; a refusal reads the stored one back. */
  function showOrder(order: readonly string[]) {
    queryClient.setQueryData<SignInOverview>(ssoKeys.overview, (current) =>
      current === undefined
        ? current
        : {
            ...current,
            providers: current.providers.map((provider) => ({
              ...provider,
              position: order.indexOf(provider.id),
            })),
          },
    );
  }

  const order = useMutation({
    mutationFn: (input: {
      ids: string[];
      previous: string[];
      provider: ProviderSummary;
      undo: boolean;
    }) => setProviderOrder(input.ids),
    onMutate: (input) => showOrder(input.ids),
    onSuccess: (_, input) => {
      void refresh();
      const shown = input.ids.filter(
        (id) => overview.providers.find((candidate) => candidate.id === id)?.enabled === true,
      );
      const message = input.provider.enabled
        ? t("sso.providers.moved", {
            name: input.provider.name,
            place: shown.indexOf(input.provider.id) + 1,
          })
        : t("sso.providers.orderChanged");
      notice.show(
        input.undo
          ? { message: t("sso.providers.orderRestored") }
          : {
              message,
              undo: () =>
                order.mutate({
                  ids: input.previous,
                  previous: input.ids,
                  provider: input.provider,
                  undo: true,
                }),
            },
      );
    },
    onError: (error) => {
      void refresh();
      notice.showError(ssoErrorText(t, error));
    },
  });

  const enable = useMutation({
    mutationFn: (input: { provider: ProviderSummary; enabled: boolean; undo: boolean }) =>
      setProviderEnabled(input.provider.id, input.enabled),
    onSuccess: async (_, input) => {
      await refresh();
      const name = input.provider.name;
      notice.show(
        input.undo
          ? {
              message: t(input.enabled ? "sso.providers.resumed" : "sso.providers.paused", {
                name,
              }),
            }
          : {
              message: t(input.enabled ? "sso.providers.resumed" : "sso.providers.paused", {
                name,
              }),
              undo: () =>
                enable.mutate({ provider: input.provider, enabled: !input.enabled, undo: true }),
            },
      );
    },
    onError: (error) => notice.showError(ssoErrorText(t, error)),
  });

  const remove = useMutation({
    mutationFn: (provider: ProviderSummary) => deleteProvider(provider.id),
    onSuccess: async (_, provider) => {
      setRemoving(null);
      await refresh();
      notice.show({ message: t("sso.providers.removed", { name: provider.name }) });
    },
  });

  function move(provider: ProviderSummary, to: number) {
    const next = moved(ids, provider.id, to);
    if (next.join() === ids.join() || order.isPending) {
      return;
    }
    order.mutate({ ids: next, previous: ids, provider, undo: false });
  }

  function onHandleKey(event: KeyboardEvent<HTMLButtonElement>, provider: ProviderSummary) {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) {
      return;
    }
    event.preventDefault();
    const index = ids.indexOf(provider.id);
    move(provider, event.key === "ArrowUp" ? index - 1 : index + 1);
  }

  function onDrop(event: DragEvent<HTMLTableRowElement>, target: ProviderSummary) {
    event.preventDefault();
    const provider = providers.find((candidate) => candidate.id === dragged);
    setDragged(null);
    if (provider !== undefined && provider.id !== target.id) {
      move(provider, ids.indexOf(target.id));
    }
  }

  let place = 0;
  const editingProvider =
    editing?.mode === "edit" && editing.provider.kind !== "ldap"
      ? { providerId: editing.provider.id, startTest: editing.startTest }
      : undefined;
  const editingLdap = editing?.mode === "edit" && editing.provider.kind === "ldap";
  const addingKind = editing?.mode === "add" ? editing.kind : null;

  function closeForm() {
    setEditing(null);
    onAdded();
  }

  function saved(name: string, created: boolean) {
    setEditing(null);
    onAdded();
    void refresh();
    notice.show({
      message: t(created ? "sso.providers.created" : "sso.providers.saved", { name }),
    });
  }

  // A directory has no button: its accounts use the password form.
  function savedLdap(name: string, created: boolean) {
    setEditing(null);
    onAdded();
    void refresh();
    notice.show({
      message: t(created ? "sso.providers.createdLdap" : "sso.providers.saved", { name }),
    });
  }

  return (
    <>
      {providers.length === 0 ? (
        <div className="settings-card settings-card--padded sso-empty">
          <h3 className="settings-row__title">{t("sso.providers.emptyTitle")}</h3>
          <p className="settings-row__description">{t("sso.providers.emptyText")}</p>
        </div>
      ) : (
        <div className="settings-card">
          <div className="sso-table-wrap">
            <table className="sso-table">
              <thead>
                <tr>
                  <th scope="col">
                    <span className="visually-hidden">{t("sso.providers.order")}</span>
                  </th>
                  <th scope="col">{t("sso.providers.name")}</th>
                  <th scope="col">{t("sso.providers.kind")}</th>
                  <th scope="col">{t("sso.providers.place")}</th>
                  <th scope="col">{t("sso.providers.status")}</th>
                  <th scope="col" className="sso-table__number">
                    {t("sso.providers.people")}
                  </th>
                  <th scope="col">
                    <span className="visually-hidden">{t("sso.providers.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {providers.map((provider) => {
                  const status = providerStatus(t, provider);
                  // LDAP signs in through the password form, never with a button of its own,
                  // so it has no place among the buttons and no handle (board frame 5A).
                  const directory = provider.kind === "ldap";
                  if (provider.enabled && !directory) {
                    place += 1;
                  }
                  return (
                    <tr
                      key={provider.id}
                      className={dragged === provider.id ? "sso-table__row--dragged" : undefined}
                      draggable={!directory}
                      onDragStart={(event) => {
                        event.dataTransfer.effectAllowed = "move";
                        setDragged(provider.id);
                      }}
                      onDragEnd={() => setDragged(null)}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => onDrop(event, provider)}
                    >
                      <td className="sso-table__handle">
                        {directory ? null : (
                          <button
                            type="button"
                            className="button button--ghost icon-button"
                            aria-label={t("sso.providers.moveNamed", { name: provider.name })}
                            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                            title={t("sso.providers.moveHint")}
                            onKeyDown={(event) => onHandleKey(event, provider)}
                          >
                            <Icon name="chevronUpDown" />
                          </button>
                        )}
                      </td>
                      <td>
                        <span className="sso-provider">
                          <span className="sso-mark" aria-hidden="true">
                            {kindMark(provider.kind)}
                          </span>
                          <span className="sso-provider__text">
                            <span className="sso-provider__name">{provider.name}</span>
                            <span className="sso-mono sso-muted" translate="no">
                              {provider.issuer}
                            </span>
                          </span>
                        </span>
                      </td>
                      <td>
                        <span className="sso-pill">
                          {kindLabel(t, provider.kind, provider.flavor)}
                        </span>
                      </td>
                      <td>
                        {!provider.enabled
                          ? t("sso.providers.placeHidden")
                          : directory
                            ? t("sso.providers.placeForm")
                            : t("sso.providers.placeButton", { place })}
                      </td>
                      <td>
                        <span className="sso-status">
                          <span className="ds-status" data-status={status.status}>
                            <span className="ds-status__dot" aria-hidden="true" />
                            <span>{status.text}</span>
                          </span>
                          <span className="sso-muted sso-small">
                            {provider.lastSignInAt === null
                              ? t("sso.providers.noSignIn")
                              : t("sso.providers.lastSignIn", {
                                  time: formatDateTime(provider.lastSignInAt, language, timeZone),
                                })}
                          </span>
                        </span>
                      </td>
                      <td className="sso-table__number">{provider.people}</td>
                      <td className="sso-table__actions">
                        <button
                          type="button"
                          className="button button--ghost button--small"
                          aria-label={t("sso.providers.editNamed", { name: provider.name })}
                          onClick={() => setEditing({ mode: "edit", provider, startTest: false })}
                        >
                          {t("sso.providers.edit")}
                        </button>
                        <ToolbarMenu
                          label={t("sso.providers.menu", { name: provider.name })}
                          icon="more"
                          entries={[
                            {
                              key: "enabled",
                              label: t(
                                provider.enabled ? "sso.providers.pause" : "sso.providers.resume",
                              ),
                              onSelect: () =>
                                enable.mutate({
                                  provider,
                                  enabled: !provider.enabled,
                                  undo: false,
                                }),
                            },
                            directory
                              ? {
                                  key: "sync",
                                  label: t("sso.sync.open"),
                                  onSelect: () => setEditing({ mode: "sync", provider }),
                                }
                              : {
                                  key: "test",
                                  label: t("sso.form.test"),
                                  onSelect: () =>
                                    setEditing({ mode: "edit", provider, startTest: true }),
                                },
                            { kind: "separator", key: "separator" },
                            {
                              key: "remove",
                              label: t("sso.providers.remove"),
                              danger: true,
                              onSelect: () => {
                                remove.reset();
                                setRemoving(provider);
                              },
                            },
                          ]}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <p className="settings-hint sso-note">{t("sso.providers.note")}</p>
      {adding && addingKind === null && editing === null ? (
        <KindDialog onClose={onAdded} onChoose={(kind) => setEditing({ mode: "add", kind })} />
      ) : null}
      {addingKind === "oidc" || editingProvider !== undefined ? (
        <ProviderDialog
          key={editingProvider?.providerId ?? "new"}
          redirectBase={overview.redirectBase}
          providerId={editingProvider?.providerId}
          startTest={editingProvider?.startTest ?? false}
          onClose={closeForm}
          onSaved={saved}
        />
      ) : null}
      {addingKind === "ldap" || editingLdap ? (
        <LdapDialog
          key={editing?.mode === "edit" ? editing.provider.id : "new-ldap"}
          providerId={editing?.mode === "edit" ? editing.provider.id : undefined}
          onClose={closeForm}
          onSaved={savedLdap}
        />
      ) : null}
      {editing?.mode === "sync" ? (
        <LdapSyncDialog
          providerId={editing.provider.id}
          name={editing.provider.name}
          onClose={() => setEditing(null)}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        title={t("sso.providers.removeTitle")}
        confirmLabel={t("sso.providers.removeConfirm")}
        busy={remove.isPending}
        error={remove.error === null ? null : ssoErrorText(t, remove.error)}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          if (removing !== null) {
            remove.mutate(removing);
          }
        }}
      >
        {t("sso.providers.removeText", { name: removing?.name ?? "" })}
      </ConfirmDialog>
    </>
  );
}
