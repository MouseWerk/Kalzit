import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../components/Icon";
import { Dialog } from "../features/dashboards/ui/Dialog";
import { useI18n } from "../i18n/i18n";
import { showErrorToast } from "../lib/toasts";
import { type DashboardEntry, MAX_PINS, orderPins, pinsQuery, search, setPinned } from "./homeApi";
import { apiErrorText } from "./shellErrors";
import { useFloatingMenu } from "./useFloatingMenu";
import { useMenuButton } from "./useMenuButton";
import "../components/iconButton.css";
import "./shellUx.css";

/**
 * The dashboards the user pinned to the sidebar, in their own order, under a heading, with a
 * menu per entry (move up, move down, unpin) and "Pin dashboard", which finds one by name.
 * Pins of dashboards the user can no longer read are left out by the server.
 */
export function PinnedSection({ orgId }: { orgId: string }) {
  const { t } = useI18n();
  const headingId = useId();
  const queryClient = useQueryClient();
  const pins = useQuery(pinsQuery(orgId));
  const [picking, setPicking] = useState(false);
  const sectionRef = useRef<HTMLElement>(null);
  const items = pins.data?.items ?? [];
  const refresh = () => queryClient.invalidateQueries({ queryKey: pinsQuery(orgId).queryKey });
  const unpin = useMutation({
    mutationFn: (id: string) => setPinned(orgId, id, false),
    onError: (error) => showErrorToast(apiErrorText(t, error)),
    onSettled: refresh,
  });
  const reorder = useMutation({
    mutationFn: (ids: string[]) => orderPins(orgId, ids),
    // Shown in the new order at once; the menus wait until the server has it.
    onMutate: (ids) => {
      const byId = new Map(items.map((entry) => [entry.id, entry]));
      const reordered = ids.map((id) => byId.get(id)).filter((e) => e !== undefined);
      queryClient.setQueryData(pinsQuery(orgId).queryKey, { items: reordered, nextCursor: null });
    },
    onSuccess: (page) => queryClient.setQueryData(pinsQuery(orgId).queryKey, page),
    onError: (error) => {
      showErrorToast(apiErrorText(t, error));
      void refresh();
    },
  });
  function move(index: number, by: -1 | 1) {
    const ids = items.map((entry) => entry.id);
    const [moved] = ids.splice(index, 1);
    if (moved === undefined) return;
    ids.splice(index + by, 0, moved);
    reorder.mutate(ids);
  }
  /** After an unpin the menu button is gone: focus goes to the pin now in its place. */
  function unpinAt(index: number, id: string) {
    unpin.mutate(id, {
      onSettled: () =>
        requestAnimationFrame(() => {
          const section = sectionRef.current;
          if (section === null) return;
          const links = section.querySelectorAll<HTMLElement>(".shell__pin > .nav-link");
          const target =
            links[index] ??
            links[index - 1] ??
            section.querySelector<HTMLElement>(".shell__pin-add") ??
            null;
          target?.focus();
        }),
    });
  }
  if (pins.data === undefined) {
    return null;
  }
  return (
    <section ref={sectionRef} className="shell__pins" aria-labelledby={headingId}>
      <h2 id={headingId} className="shell__group-heading">
        {t("shell.pins.title")}
      </h2>
      {items.length === 0 ? null : (
        <ul className="shell__nav-list">
          {items.map((entry, index) => (
            <PinnedEntry
              key={entry.id}
              entry={entry}
              first={index === 0}
              last={index === items.length - 1}
              onUp={() => move(index, -1)}
              onDown={() => move(index, 1)}
              onUnpin={() => unpinAt(index, entry.id)}
              busy={reorder.isPending || unpin.isPending}
            />
          ))}
        </ul>
      )}
      {items.length >= MAX_PINS ? (
        <p className="shell__pins-full">{t("shell.pins.full", { count: MAX_PINS })}</p>
      ) : (
        <button type="button" className="shell__pin-add" onClick={() => setPicking(true)}>
          <Icon name="plus" />
          <span>{t("shell.pins.add")}</span>
        </button>
      )}
      {picking ? (
        <PinPicker
          orgId={orgId}
          pinned={items}
          onClose={() => setPicking(false)}
          onPinned={() => {
            setPicking(false);
            void refresh();
          }}
        />
      ) : null}
    </section>
  );
}

function PinnedEntry({
  entry,
  first,
  last,
  onUp,
  onDown,
  onUnpin,
  busy,
}: {
  entry: DashboardEntry;
  first: boolean;
  last: boolean;
  onUp: () => void;
  onDown: () => void;
  onUnpin: () => void;
  /** A move or an unpin is on its way: the menu waits, so changes never overlap. */
  busy: boolean;
}) {
  const { t } = useI18n();
  const menu = useMenuButton();
  const { open, closeMenu } = menu;
  const choose = (action: () => void, returnFocus = true) => {
    action();
    closeMenu(returnFocus);
  };
  // Drawn in the window beside its button: the sidebar's overflow never clips it.
  const onMenuKeyDown = useFloatingMenu(menu, "beside");
  return (
    <li className="shell__pin">
      <Link
        to="/dashboards/$dashboardId"
        params={{ dashboardId: entry.id }}
        className="nav-link"
        title={entry.path.length === 0 ? undefined : [...entry.path, entry.title].join(" / ")}
      >
        <Icon name="pin" />
        <span className="nav-link__label">{entry.title}</span>
      </Link>
      <div className="menu-anchor shell__pin-menu" ref={menu.anchorRef}>
        <button
          ref={menu.buttonRef}
          type="button"
          className="shell__pin-more"
          aria-label={t("shell.pins.actionsNamed", { name: entry.title })}
          title={t("shell.pins.actions")}
          aria-haspopup="menu"
          aria-expanded={menu.open}
          aria-controls={menu.open ? menu.menuId : undefined}
          onClick={menu.toggle}
          onKeyDown={menu.onButtonKeyDown}
        >
          <Icon name="more" />
        </button>
        {open
          ? createPortal(
              <div
                ref={menu.menuRef}
                id={menu.menuId}
                role="menu"
                aria-label={t("shell.pins.actionsNamed", { name: entry.title })}
                className="menu toolbar-menu__list"
                onKeyDown={onMenuKeyDown}
                // A click in the menu is the menu's, not a click outside that closes it.
                onPointerDown={(event) => event.stopPropagation()}
              >
                {first ? null : (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className="menu__item"
                    disabled={busy}
                    onClick={() => choose(onUp)}
                  >
                    <Icon name="arrowUp" />
                    {t("shell.pins.up")}
                  </button>
                )}
                {last ? null : (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className="menu__item"
                    disabled={busy}
                    onClick={() => choose(onDown)}
                  >
                    <Icon name="arrowDown" />
                    {t("shell.pins.down")}
                  </button>
                )}
                <button
                  type="button"
                  role="menuitem"
                  tabIndex={-1}
                  className="menu__item"
                  disabled={busy}
                  onClick={() => choose(onUnpin, false)}
                >
                  <Icon name="close" />
                  {t("shell.pins.unpin")}
                </button>
              </div>,
              document.body,
            )
          : null}
      </div>
    </li>
  );
}

/** Finds a dashboard by name and pins it; ones already pinned are marked and left out. */
function PinPicker({
  orgId,
  pinned,
  onClose,
  onPinned,
}: {
  orgId: string;
  pinned: readonly DashboardEntry[];
  onClose: () => void;
  onPinned: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [q, setQ] = useState("");
  const results = useQuery({
    queryKey: ["shell", orgId, "pin-search", q],
    queryFn: ({ signal }) => search(orgId, { q, kind: "dashboard", limit: 20 }, signal),
  });
  const pin = useMutation({
    mutationFn: (dashboardId: string) => setPinned(orgId, dashboardId, true),
    onSuccess: onPinned,
    onError: (error) => showErrorToast(apiErrorText(t, error)),
  });
  const pinnedIds = new Set(pinned.map((entry) => entry.id));
  const hits = (results.data?.items ?? []).filter((hit) => !pinnedIds.has(hit.id));
  return (
    <Dialog title={t("shell.pins.pickTitle")} onClose={onClose}>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-q`}>
          {t("shell.pins.search")}
        </label>
        <input
          id={`${id}-q`}
          data-autofocus
          type="search"
          className="input"
          value={q}
          onChange={(event) => setQ(event.currentTarget.value)}
        />
      </div>
      {results.isPending ? (
        <p className="loading">{t("common.loading")}</p>
      ) : hits.length === 0 ? (
        <p className="field__hint">{t("shell.pins.none")}</p>
      ) : (
        <ul className="pin-picker" aria-label={t("shell.pins.results")}>
          {hits.map((hit) => (
            <li key={hit.id}>
              <button
                type="button"
                className="pin-picker__item"
                disabled={pin.isPending}
                onClick={() => pin.mutate(hit.id)}
              >
                <span className="pin-picker__title truncate">{hit.title}</span>
                {hit.path.length === 0 ? null : (
                  <span className="pin-picker__path truncate">{hit.path.join(" / ")}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
