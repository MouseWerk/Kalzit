/**
 * Line icons drawn on a 24 px grid with the current text color. Decorative by default: the text
 * next to an icon carries the meaning, so screen readers skip it.
 */
const PATHS = {
  logo: "M12 2.5 20.5 7.25v9.5L12 21.5l-8.5-4.75v-9.5zM12 2.5v19M3.5 7.25 12 12l8.5-4.75",
  home: "M3.5 10.5 12 3.5l8.5 7M5.5 9v11h13V9M10 20v-6h4v6",
  dashboards: "M4 4h7v9H4zM13 4h7v5h-7zM13 11h7v9h-7zM4 15h7v5H4z",
  explore: "M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM15.25 15.25 20 20",
  dataSources:
    "M4.5 6c0-1.66 3.36-3 7.5-3s7.5 1.34 7.5 3-3.36 3-7.5 3-7.5-1.34-7.5-3zM4.5 6v12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3V6M4.5 12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3",
  admin: "M12 3 19.5 6v5.5c0 4.5-3.2 8.2-7.5 9.5-4.3-1.3-7.5-5-7.5-9.5V6zM9 12l2.25 2.25L15.5 10",
  check: "M5 12.5 10 17.5 19 7",
  alert: "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM12 8v5M12 16.25v.25",
  signOut:
    "M9.5 20H5.5a1.5 1.5 0 0 1-1.5-1.5v-13A1.5 1.5 0 0 1 5.5 4h4M15 16.5 19.5 12 15 7.5M19.5 12H9.5",
  lock: "M6.5 10.5h11v9.5h-11zM8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className === undefined ? "icon" : `icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
