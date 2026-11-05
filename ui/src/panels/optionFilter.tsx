import { createContext, type ReactNode, use, useState } from "react";

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
  /**
   * The defaults per option label, the values each label has in a panel with default options,
   * filled by rendering the options once with those defaults (`collect`).
   */
  baseline: ReadonlyMap<string, ReadonlySet<string>> | null;
  /** Set while rendering the defaults: fields record their value here and draw nothing. */
  collect: Map<string, Set<string>> | null;
  /** Counts each entry into "Changed", so an option found changed there stays while edited. */
  session: number;
}

export const NO_FILTER: OptionFilter = {
  query: "",
  changed: false,
  overrides: false,
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
  if (filter.collect !== null) {
    const seen = filter.collect.get(label) ?? new Set<string>();
    seen.add(valueKey(value));
    filter.collect.set(label, seen);
    return false;
  }
  if (!matchesQuery(label, filter.query)) {
    return false;
  }
  if (filter.changed && filter.baseline !== null && kept !== filter.session) {
    const differs = filter.baseline.get(label)?.has(valueKey(value)) !== true;
    if (!differs) {
      return false;
    }
    setKept(filter.session);
  }
  return true;
}

/**
 * A group or section of options: its title matching the search shows all of its options, and
 * while filtering it stands open. `shown` is false when the view leaves it out entirely.
 */
export function useOptionScope(title: string): {
  filtering: boolean;
  /** The filter for what is inside, the search lifted when the title matches. */
  inner: OptionFilter;
} {
  const filter = use(OptionFilterContext);
  const titleMatches = filter.query !== "" && matchesQuery(title, filter.query);
  return {
    filtering: isFiltering(filter) && filter.collect === null,
    inner: titleMatches ? { ...filter, query: "" } : filter,
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
