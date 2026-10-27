import { type KeyboardEvent, useEffect, useEffectEvent, useId, useRef, useState } from "react";
import { useEscapeLayer } from "../lib/layers";

type FocusTarget = "first" | "last";

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  if (menu === null) {
    return [];
  }
  return Array.from(
    menu.querySelectorAll<HTMLElement>(
      '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]',
    ),
  );
}

/**
 * A menu button after the WAI-ARIA pattern, shared by the account menu, the workspace menu and
 * the dashboard's variable and links menus: arrow keys move between items (menu items, radio and
 * checkbox items), Home and End jump, Escape and Tab close, a click elsewhere closes without
 * pulling focus back, and focus returns to the button after a choice, Escape or Tab.
 */
export function useMenuButton(options: { onOpen?: () => void } = {}) {
  const [open, setOpen] = useState(false);
  const [focusTarget, setFocusTarget] = useState<FocusTarget>("first");
  const anchorRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const onOpen = useEffectEvent(() => options.onOpen?.());

  function openMenu(target: FocusTarget) {
    onOpen();
    setFocusTarget(target);
    setOpen(true);
  }

  function closeMenu(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) {
      buttonRef.current?.focus();
    }
  }

  useEscapeLayer(open, () => closeMenu(true));

  // Runs after every render while open: items that arrive after the menu opened (permissions or
  // teams still loading) get the focus the opening asked for. An item that arrives ahead of the
  // one focused takes the focus over, as long as it still rests where the opening put it; once
  // the person moved it, it stays where they put it (an item that went away hands it on).
  const placed = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) {
      placed.current = null;
      return;
    }
    const active = document.activeElement;
    const moved =
      placed.current !== null &&
      active !== placed.current &&
      (placed.current.isConnected || menuRef.current?.contains(active) === true);
    if (moved) {
      return;
    }
    const items = menuItems(menuRef.current);
    const target = focusTarget === "last" ? items.at(-1) : items[0];
    if (target !== undefined && target !== placed.current) {
      target.focus();
      placed.current = target;
    }
  });

  const onOutsidePointer = useEffectEvent((event: PointerEvent) => {
    // The menu counts as inside even when it is drawn elsewhere in the page (a portal).
    if (
      event.target instanceof Node &&
      anchorRef.current?.contains(event.target) !== true &&
      menuRef.current?.contains(event.target) !== true
    ) {
      // Focus follows the click to wherever the user pointed, so it is not pulled back.
      closeMenu(false);
    }
  });

  useEffect(() => {
    if (!open) {
      return;
    }
    const listener = (event: PointerEvent) => onOutsidePointer(event);
    document.addEventListener("pointerdown", listener);
    return () => document.removeEventListener("pointerdown", listener);
  }, [open]);

  function onButtonKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      openMenu(event.key === "ArrowUp" ? "last" : "first");
    }
  }

  function onMenuKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const items = menuItems(menuRef.current);
    const index = items.indexOf(document.activeElement as HTMLElement);
    let next: HTMLElement | undefined;
    switch (event.key) {
      case "ArrowDown":
        next = items[(index + 1) % items.length];
        break;
      case "ArrowUp":
        next = items[(index - 1 + items.length) % items.length];
        break;
      case "Home":
        next = items[0];
        break;
      case "End":
        next = items.at(-1);
        break;
      case "Tab":
        closeMenu(false);
        return;
      default:
        return;
    }
    event.preventDefault();
    next?.focus();
  }

  return {
    open,
    anchorRef,
    buttonRef,
    menuRef,
    menuId,
    openMenu,
    closeMenu,
    toggle: () => (open ? closeMenu(false) : openMenu("first")),
    onButtonKeyDown,
    onMenuKeyDown,
  };
}
