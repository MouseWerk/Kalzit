import { createContext, type ReactNode, use, useLayoutEffect, useState } from "react";

/**
 * The options pane's search and views (PanelEditor board): which options show. Each option field
 * asks `useOptionShown` with its label and value; groups and sections ask `useOptionScope` with
 * their title. Outside the panel editor nothing is filtered.
 */
export interface OptionFilter {
  /** Lower-case search text; empty shows every option. */
  query: string;
  /** Only options whose value differs from the panel's defaults ("Changed"). */
  changed: boolean;
  /** Only the overrides ("Overrides"). */
  overrides: boolean;
  /** The titles of the groups and sections around, so equal labels in two places stay apart. */
  path: string;
  /**
   * The values each option (by `optionKey`) has in a panel left at its defaults, collected once
   * per panel type by drawing the options off screen with `collect` set.
   */
  baseline: ReadonlyMap<string, ReadonlySet<string>> | null;
  /** Set while drawing the defaults: fields record their value here and draw nothing. */
  collect: Map<string, Set<string>> | null;
  /** Counts each entry into "Changed", so an option found changed there stays while edited. */
  session: number;
}

export const NO_FILTER: OptionFilter = {
  query: "",
  changed: false,
  overrides: false,
  path: "",
  baseline: null,
  collect: null,
  session: 0,
};

export const OptionFilterContext = createContext<OptionFilter>(NO_FILTER);

/** Whether the pane shows fewer options than it has (search, "Changed" or "Overrides"). */
export function isFiltering(filter: OptionFilter): boolean {
  return filter.query !== "" || filter.changed || filter.overrides;
}

export function matchesQuery(text: string, query: string): boolean {
  return query === "" || text.toLocaleLowerCase().includes(query);
}

/** An option's key for "Changed": where it stands and its label. */
export function optionKey(path: string, label: string): string {
  return `${path}\n${label}`;
}

function valueKey(value: unknown): string {
  return JSON.stringify(value ?? null) ?? "null";
}

/**
 * Whether the option with this label and value shows under the pane's filter. In "Changed" an
 * option that differed once stays until the view is left, so setting it back to its default
 * while typing does not take the field away under the cursor.
 */
export function useOptionShown(label: string, value: unknown): boolean {
  const filter = use(OptionFilterContext);
  const [kept, setKept] = useState(-1);
  const key = optionKey(filter.path, label);
  const valued = valueKey(value);
  const { collect, baseline, session } = filter;
  const differs = filter.changed && baseline !== null && baseline.get(key)?.has(valued) !== true;
  // Drawing the defaults: the value is recorded once the field is placed, not while drawing.
  useLayoutEffect(() => {
    if (collect === null) return;
    const seen = collect.get(key) ?? new Set<string>();
    seen.add(valued);
    collect.set(key, seen);
  }, [collect, key, valued]);
  useLayoutEffect(() => {
    if (differs) setKept(session);
  }, [differs, session]);
  if (collect !== null || !matchesQuery(label, filter.query)) {
    return false;
  }
  if (filter.changed && baseline !== null) {
    return differs || kept === session;
  }
  return true;
}

/**
 * A group or section of options: its title matching the search shows all of its options, and
 * while filtering it stands open.
 */
export function useOptionScope(title: string): {
  filtering: boolean;
  /** The search matches the title, so the group shows as a match even with no fields. */
  titleMatches: boolean;
  /** The filter for what is inside: one level deeper, the search lifted when the title matches. */
  inner: OptionFilter;
} {
  const filter = use(OptionFilterContext);
  const titleMatches =
    filter.query !== "" && filter.collect === null && matchesQuery(title, filter.query);
  const path = filter.path === "" ? title : `${filter.path}/${title}`;
  return {
    filtering: isFiltering(filter) && filter.collect === null,
    titleMatches,
    inner: { ...filter, path, ...(titleMatches ? { query: "" } : {}) },
  };
}

/**
 * One option written as its own markup (not one of the shared fields): drawn only when the
 * filter shows it, marked so the pane can tell a group with options left from an empty one.
 */
export function OptionField({
  label,
  value,
  className,
  children,
}: {
  label: string;
  value: unknown;
  /** The wrapper's class; without one the wrapper adds no box of its own. */
  className?: string;
  children: ReactNode;
}) {
  const shown = useOptionShown(label, value);
  if (!shown) {
    return null;
  }
  return (
    <div className={className ?? "option-field"} data-option="">
      {children}
    </div>
  );
}

/**
 * Draws `children` (the options of a panel left at its defaults) once, off screen, with every
 * field recording its value, and hands the collected values over once all are placed.
 */
export function DefaultsCollector({
  children,
  onCollected,
}: {
  children: ReactNode;
  onCollected: (baseline: ReadonlyMap<string, ReadonlySet<string>>) => void;
}) {
  const [collect] = useState(() => new Map<string, Set<string>>());
  // A parent's layout effect runs after its children's: every field has recorded by now.
  useLayoutEffect(() => {
    onCollected(collect);
  }, [collect, onCollected]);
  return <OptionFilterContext value={{ ...NO_FILTER, collect }}>{children}</OptionFilterContext>;
}
