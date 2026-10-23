/**
 * Line icons drawn on a 24 px grid with the current text color. Decorative by default: the text
 * next to an icon carries the meaning, so screen readers skip it.
 */
const PATHS = {
  // The Kalzit mark from the website: a calcite rhombohedron, three visible faces.
  logo: "M3.5 8.5 8 4.2l11.5-2 1.8 13.6-4 4.4L6 22.3ZM3.5 8.5 15 6.6l2.3 13.6M15 6.6l4.5-4.4",
  home: "M3.5 10.5 12 3.5l8.5 7M5.5 9v11h13V9M10 20v-6h4v6",
  dashboards: "M4 4h7v9H4zM13 4h7v5h-7zM13 11h7v9h-7zM4 15h7v5H4z",
  // A compass: Explore is finding your way through data, not a search box.
  explore: "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM15.25 8.75l-1.9 4.6-4.6 1.9 1.9-4.6z",
  search: "M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM15.25 15.25 20 20",
  dataSources:
    "M4.5 6c0-1.66 3.36-3 7.5-3s7.5 1.34 7.5 3-3.36 3-7.5 3-7.5-1.34-7.5-3zM4.5 6v12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3V6M4.5 12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3",
  admin: "M12 3 19.5 6v5.5c0 4.5-3.2 8.2-7.5 9.5-4.3-1.3-7.5-5-7.5-9.5V6zM9 12l2.25 2.25L15.5 10",
  check: "M5 12.5 10 17.5 19 7",
  alert: "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM12 8v5M12 16.25v.25",
  signOut:
    "M9.5 20H5.5a1.5 1.5 0 0 1-1.5-1.5v-13A1.5 1.5 0 0 1 5.5 4h4M15 16.5 19.5 12 15 7.5M19.5 12H9.5",
  lock: "M6.5 10.5h11v9.5h-11zM8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5",
  chevron: "M9 6.5 14.5 12 9 17.5",
  back: "M15 6.5 9.5 12l5.5 5.5",
  sidebar: "M4.5 4.5h15v15h-15zM9.5 4.5v15",
  star: "M12 3.5l2.6 5.3 5.9.85-4.25 4.15 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.65l5.9-.85z",
  starFilled: "M12 3.5l2.6 5.3 5.9.85-4.25 4.15 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.65l5.9-.85z",
  plus: "M12 5v14M5 12h14",
  keyboard: "M3.5 6.5h17v11h-17zM7 10h.01M10 10h.01M13 10h.01M16 10h.01M8 14h8",
  // Opens a menu that lists choices above and below: two chevrons, one up, one down.
  chevronUpDown: "M8.5 9.5 12 6l3.5 3.5M8.5 14.5 12 18l3.5-3.5",
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  edit: "M5 19h3.5L18.5 9a2.47 2.47 0 0 0-3.5-3.5L5 15.5zM13.5 7l3.5 3.5",
  members:
    "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM3.5 20a5.5 5.5 0 0 1 11 0M15.5 4.5a3.5 3.5 0 0 1 0 6.5M17.5 14.5a5.5 5.5 0 0 1 3 5.5",
  activity: "M3.5 12h4l2.5-6 4 12 2.5-6h4",
  checklist: "M10 6.5h9.5M10 12h9.5M10 17.5h9.5M4.5 6.5l1.25 1.25L8 5.5M4.5 12l1.25 1.25L8 11",
  folder:
    "M3.5 7A1.5 1.5 0 0 1 5 5.5h4l2 2h8A1.5 1.5 0 0 1 20.5 9v8.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5z",
  // Show and hide a password; the caps-lock warning next to a password field.
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  eyeOff:
    "M4 4l16 16M10.2 5.7A9 9 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.9 3.7M6.6 6.9C4 8.6 2.5 12 2.5 12S6 18.5 12 18.5a9 9 0 0 0 4.5-1.2M9.9 9.9a3 3 0 0 0 4.2 4.2",
  capsLock: "M12 4.5 4.5 12H8.5v3.5h7V12h4zM8.5 19.5h7",
} as const;

/** Icons drawn filled instead of outlined (the starred state of a star). */
const FILLED: ReadonlySet<IconName> = new Set<IconName>(["starFilled"]);

export type IconName = keyof typeof PATHS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className === undefined ? "icon" : `icon ${className}`}
      viewBox="0 0 24 24"
      fill={FILLED.has(name) ? "currentColor" : "none"}
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
