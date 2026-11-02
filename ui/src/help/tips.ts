import { useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { useEffect, useState, useSyncExternalStore } from "react";
import { preferencesQuery, usePreferenceChange } from "../preferences/preferences";
import { defineRegistry } from "./registry";

/**
 * Tips: small hints at the moment they help ("you can filter with WHERE" after a first result).
 * Each appears once for a person, wherever they sign in: the server keeps the tips they have seen
 * and whether they want tips at all (docs/api/shell.md, "Preferences"). Only one tip shows at a
 * time, a tip never takes the focus, and closing it or turning tips off is one click.
 */
export const TIP_IDS = [
  // Explore: after the first result, with a pattern of the source's language.
  "explore.first-result",
  // Explore: after running with the mouse, the keyboard shortcut.
  "explore.run-shortcut",
  // Explore: after a starter, that steps shape the result without writing a query.
  "explore.steps",
] as const;

export type TipId = (typeof TIP_IDS)[number];

/** Every tip by id; the ids are what the server stores as seen. */
export const TIPS = defineRegistry(
  "tips",
  TIP_IDS.map((id) => ({ id })),
);

// The tip on screen, so a second one waits until it is closed.
let active: string | null = null;
const listeners = new Set<() => void>();
const activeStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: () => active,
  set(id: string | null) {
    active = id;
    for (const listener of listeners) listener();
  },
};

/** Forgets the tip on screen; for tests, which render one app after another. */
export function resetActiveTip(): void {
  activeStore.set(null);
}

const appRoute = getRouteApi("/_app");

export interface TipState {
  visible: boolean;
  dismiss: () => void;
  /** Turns every tip off (the "Show tips" preference). */
  turnOff: () => void;
}

/**
 * A tip that shows once `when` holds, if the person wants tips and has not seen it yet. It counts
 * as seen as soon as it shows; it stays until closed or until the screen is left.
 */
export function useTip(id: TipId, when: boolean): TipState {
  const { me } = appRoute.useRouteContext();
  const preferences = useQuery(preferencesQuery(me.id));
  const change = usePreferenceChange(me.id, {});
  const onScreen = useSyncExternalStore(activeStore.subscribe, activeStore.get, activeStore.get);
  const [phase, setPhase] = useState<"waiting" | "shown" | "closed">("waiting");
  const enabled = preferences.data?.showTips === true;
  const seen = preferences.data?.seenTips.includes(id) ?? true;
  const mayShow = phase === "waiting" && when && enabled && !seen && onScreen === null;
  const { mutate } = change;

  useEffect(() => {
    if (!mayShow) {
      return;
    }
    activeStore.set(id);
    setPhase("shown");
    mutate({ seenTips: [id] });
  }, [mayShow, id, mutate]);
  // Leaving the screen frees the place for the next tip.
  useEffect(
    () => () => {
      if (activeStore.get() === id) activeStore.set(null);
    },
    [id],
  );

  const close = () => {
    setPhase("closed");
    if (activeStore.get() === id) activeStore.set(null);
  };
  return {
    visible: phase === "shown" && enabled,
    dismiss: close,
    turnOff: () => {
      close();
      mutate({ showTips: false });
    },
  };
}
