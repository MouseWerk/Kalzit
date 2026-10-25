/**
 * The tab a key moves to in a tablist (WAI-ARIA tabs pattern): the arrows step and wrap around,
 * Home and End jump to the first and last tab. `undefined` for any other key, so the caller
 * leaves it alone.
 */
export function tabForKey<T>(tabs: readonly T[], current: T, key: string): T | undefined {
  if (tabs.length === 0) {
    return undefined;
  }
  const index = Math.max(0, tabs.indexOf(current));
  const position: Record<string, number> = {
    ArrowRight: (index + 1) % tabs.length,
    ArrowLeft: (index + tabs.length - 1) % tabs.length,
    Home: 0,
    End: tabs.length - 1,
  };
  const target = position[key];
  return target === undefined ? undefined : tabs[target];
}
