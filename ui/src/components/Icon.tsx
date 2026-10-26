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
  // A push pin: the head, the collar and the needle.
  pin: "M9 4h6M10 4v5.5L7 13h10l-3-3.5V4M12 13v7",
  arrowUp: "M12 19V5M6 11l6-6 6 6",
  arrowDown: "M12 5v14M6 13l6 6 6-6",
  keyboard: "M3.5 6.5h17v11h-17zM7 10h.01M10 10h.01M13 10h.01M16 10h.01M8 14h8",
  // Themes and languages: sun, moon, a circle split in two shades, a globe.
  sun: "M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zM12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4",
  moon: "M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z",
  contrast: "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM12 3.5v17M12 7v10M15 6v12",
  globe:
    "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM3.5 12h17M12 3.5c2.3 2.4 3.4 5.2 3.4 8.5s-1.1 6.1-3.4 8.5C9.7 18.1 8.6 15.3 8.6 12s1.1-6.1 3.4-8.5z",
  // Opens a menu that lists choices above and below: two chevrons, one up, one down.
  chevronUpDown: "M8.5 9.5 12 6l3.5 3.5M8.5 14.5 12 18l3.5-3.5",
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  // A menu of more actions: three dots in a row.
  more: "M5 12a1 1 0 1 0 2 0 1 1 0 1 0-2 0M11 12a1 1 0 1 0 2 0 1 1 0 1 0-2 0M17 12a1 1 0 1 0 2 0 1 1 0 1 0-2 0",
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
  chevronLeft: "M15 6.5 9.5 12 15 17.5",
  chevronDown: "M6.5 9.5 12 15l5.5-5.5",
  zoomOut: "M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM15.25 15.25 20 20M7.5 10.5h6",
  share:
    "M8.25 10.75 15.75 6.75M8.25 13.25l7.5 4M6 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM18 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM18 15.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5z",
  screen: "M3.5 5h17v11h-17zM8.5 20h7M12 16v4",
  expand: "M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15",
  history: "M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v4h4M12 8v4l2.5 2",
  trash: "M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5M10 10.5v6M14 10.5v6",
  copy: "M8.5 8.5h11v11h-11zM15.5 8.5v-4h-11v11h4",
  paste: "M8 5H5.5v15h13V5H16M9 3.5h6v3H9z",
  calendar: "M4.5 6h15v14h-15zM4.5 10h15M8.5 3.5v4M15.5 3.5v4",
  code: "M9 7 4.5 12 9 17M15 7l4.5 5-4.5 5",
  rows: "M4.5 5h15v4h-15zM4.5 11.5h15M4.5 15.5h15M4.5 19.5h15",
  library: "M5 4.5h4v15H5zM11 4.5h4v15h-4zM16.5 5.4l3.4-.9 2.6 14-3.4.9z",
  outline: "M4.5 6h2M9.5 6h10M6.5 12h2M11.5 12h8M6.5 18h2M11.5 18h8",
  plusSquare: "M4.5 4.5h15v15h-15zM12 8.5v7M8.5 12h7",
  barChart: "M5.5 19.5V11M10 19.5V5.5M14.5 19.5V9M19 19.5V13",
  table: "M4.5 5h15v14h-15zM4.5 10h15M4.5 14.5h15M10 10v9",
  gauge: "M4.5 16a7.5 7.5 0 1 1 15 0M12 16l3.5-4",
  pie: "M12 3.5v8.5h8.5A8.5 8.5 0 1 1 12 3.5z",
  network:
    "M6 4a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM18 6a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM9 16a2 2 0 1 1 0 4 2 2 0 0 1 0-4zM8 6.5l8 1M6.5 8l2 8",
  stat: "M5 19.5h14M7 15.5V8.5l-1.5 1M11 8.5h4l-3.5 7",
  text: "M5 6h14M5 10.5h14M5 15h9",
  filter: "M4.5 5h15l-6 7.5v6l-3 1.5v-7.5z",
  flag: "M6 20.5V4M6 4.5h11l-2.5 4 2.5 4H6",
  link: "M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1",
  help: "M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM9.75 9.5a2.25 2.25 0 1 1 3.4 1.95c-.7.4-1.15.9-1.15 1.8v.25M12 16.25v.25",
  // Settings: three sliders with their knobs.
  settings: "M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1M15 5v4M9 10v4M17 15v4",
  // Updates: download and upload a package, look again, plan for later, a verified signature.
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  // A floppy disk: saving, as in every editor.
  save: "M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6",
  upload: "M12 15V4M7 9l5-5 5 5M5 20h14",
  refresh: "M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5",
  clock: "M12 4a8 8 0 1 1 0 16 8 8 0 0 1 0-16zM12 8v4l3 2",
  shieldCheck: "M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6zM9 12l2 2 4-4",
  external: "M7 17 17 7M9 7h8v8",
  database:
    "M4.5 6c0-1.66 3.36-3 7.5-3s7.5 1.34 7.5 3-3.36 3-7.5 3-7.5-1.34-7.5-3zM4.5 6v12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3V6M4.5 12c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3",
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
