import { type ComponentType, lazy, type ReactNode, Suspense } from "react";
import { useI18n } from "../i18n/i18n";
import "./panels.css";

function Loading() {
  const { t } = useI18n();
  return <p className="panel-empty">{t("common.loading")}</p>;
}

/** A panel component that loads with its first use, and `preload` to load it ahead of that. */
export type LazyPanel<P extends object> = ((props: P) => ReactNode) & {
  preload: () => Promise<unknown>;
};

/**
 * A panel component that loads with its first use. The registry lists every panel type, and is
 * part of every dashboard; panels with heavy code (the graph panels and their renderer) keep it
 * out of dashboards that do not show them. `preload` starts the same load ahead of time.
 */
export function lazyPanel<P extends object>(load: () => Promise<ComponentType<P>>): LazyPanel<P> {
  let loading: Promise<ComponentType<P>> | null = null;
  const once = () => {
    loading ??= load();
    return loading;
  };
  const Lazy = lazy(() => once().then((component) => ({ default: component })));
  // biome-ignore lint/correctness/noComponentHookFactories: the factory exists to create one lazy component per panel
  function LazyPanel(props: P) {
    return (
      <Suspense fallback={<Loading />}>
        <Lazy {...props} />
      </Suspense>
    );
  }
  return Object.assign(LazyPanel, { preload: once });
}
