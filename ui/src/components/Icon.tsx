/**
 * Kalzit's own icons, in the facet language of board Icons.dc.html: line drawings on a 24 px grid
 * in the current text color, with the geometry of the calcite mark (octagons instead of circles,
 * corners cut at 45 degrees, rhombi for nodes and knobs). Where an icon has a surface, one facet
 * is tinted with the text color at --icon-facet-opacity; controls stay pure line. Decorative by
 * default: the text next to an icon carries the meaning, so screen readers skip it.
 */
const PATHS = {
  // The Kalzit mark from the website: a calcite rhombohedron, three visible faces.
  logo: "M3.1 8.25 7.6 3.95l11.5-2 1.8 13.6-4 4.4L5.6 22.05ZM3.1 8.25 14.6 6.35l2.3 13.6M14.6 6.35l4.5-4.4",
  // Start: a house, its door the lit facet.
  home: "M3.5 10.5 12 3.5l8.5 7M5.5 9v11h13V9M10 20v-6h4v6",
  // Tiles with one cut corner; the small tile catches the light.
  dashboards: "M4 4h5l2 2v7H4zM13 4h5l2 2v3h-7zM13 11h5l2 2v7h-7zM4 15h5l2 2v3H4z",
  // A compass in an octagon: Explore is finding your way through data, not a search box.
  explore:
    "M15.25 4.15L19.85 8.75L19.85 15.25L15.25 19.85L8.75 19.85L4.15 15.25L4.15 8.75L8.75 4.15zM15.75 8.25 13.2 13.2 8.25 15.75 10.8 10.8z",
  // An octagonal lens and its handle.
  search: "M13 4.5 16.5 8v5L13 16.5H8L4.5 13V8L8 4.5zM15.5 15.5 20 20",
  // A hexagonal column of stacked layers; its top face is the facet.
  dataSources: "M4.5 6.5 12 3.5l7.5 3-7.5 3zM4.5 6.5v11l7.5 3 7.5-3v-11M4.5 12 12 15l7.5-3",
  check: "M5 12.5 10 17.5 19 7",
  alert:
    "M15.25 4.15L19.85 8.75L19.85 15.25L15.25 19.85L8.75 19.85L4.15 15.25L4.15 8.75L8.75 4.15zM12 8v5M12 16.25v.25",
  signOut: "M9.5 20h-4L4 18.5v-13L5.5 4h4M15 16.5 19.5 12 15 7.5M19.5 12h-10",
  lock: "M7.75 10.5L16.25 10.5L17.5 11.75L17.5 18.75L16.25 20L7.75 20L6.5 18.75L6.5 11.75zM8.5 10.5v-3L10.5 5h3l2 2.5v3",
  // A person with a key: a passkey (the second factor).
  passkey:
    "M9.75 3.75L12.78 5.5L12.78 9L9.75 10.75L6.72 9L6.72 5.5zM3.75 19.25 5.25 15 7.5 13.25h4.5l1 .75M17.75 11.25L20.25 13.75L17.75 16.25L15.25 13.75zM17.75 16.25v4M17.75 18.75h1.6",
  // A phone: the authenticator app.
  phone: "M8.5 3L15.5 3L17 4.5L17 19.5L15.5 21L8.5 21L7 19.5L7 4.5zM11 18h2",
  chevron: "M9 6.5 14.5 12 9 17.5",
  back: "M15 6.5 9.5 12l5.5 5.5",
  sidebar: "M6 4.5L18 4.5L19.5 6L19.5 18L18 19.5L6 19.5L4.5 18L4.5 6zM9.5 4.5v15",
  star: "M12 3.5l2.6 5.3 5.9.85-4.25 4.15 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.65l5.9-.85z",
  starFilled: "M12 3.5l2.6 5.3 5.9.85-4.25 4.15 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.65l5.9-.85z",
  plus: "M12 5v14M5 12h14",
  // A push pin: the head, the collar and the needle.
  pin: "M9 4h6M10 4v5.5L7 13h10l-3-3.5V4M12 13v7",
  arrowUp: "M12 19V5M6 11l6-6 6 6",
  arrowDown: "M12 5v14M6 13l6 6 6-6",
  keyboard:
    "M5 6.5L19 6.5L20.5 8L20.5 16L19 17.5L5 17.5L3.5 16L3.5 8zM7 10h.01M10 10h.01M13 10h.01M16 10h.01M8 14h8",
  // Themes and languages: sun, moon, an octagon split in two shades, a globe.
  sun: "M13.63 8.07L15.93 10.37L15.93 13.63L13.63 15.93L10.37 15.93L8.07 13.63L8.07 10.37L10.37 8.07zM12 3.5V5M12 19v1.5M3.5 12H5M19 12h1.5M6 6l1 1M17 17l1 1M18 6l-1 1M7 17l-1 1",
  moon: "M8.94 4.61 4.61 8.94v6.12l4.33 4.33h6.12l4.33-4.33L13.75 14 11 11.25 9.75 7z",
  contrast:
    "M15.25 4.15L19.85 8.75L19.85 15.25L15.25 19.85L8.75 19.85L4.15 15.25L4.15 8.75L8.75 4.15z",
  globe:
    "M15.25 4.15L19.85 8.75L19.85 15.25L15.25 19.85L8.75 19.85L4.15 15.25L4.15 8.75L8.75 4.15zM4.15 12h15.7M12 4.15 15.25 8v8L12 19.85 8.75 16V8z",
  // Opens a menu that lists choices above and below: two chevrons, one up, one down.
  chevronUpDown: "M8.5 9.5 12 6l3.5 3.5M8.5 14.5 12 18l3.5-3.5",
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  // A menu of more actions: three small rhombi in a row.
  more: "M6 10.75L7.25 12L6 13.25L4.75 12zM12 10.75L13.25 12L12 13.25L10.75 12zM18 10.75L19.25 12L18 13.25L16.75 12z",
  edit: "M5 19h3.5L19 8.5 15.5 5 5 15.5zM13.5 7l3.5 3.5",
  members:
    "M9 4L12.03 5.75L12.03 9.25L9 11L5.97 9.25L5.97 5.75zM3.5 20l1.25-4L7 14.5h4l2.25 1.5L14.5 20M15.5 4.5 18 6v3.5l-2.5 1.5M17.5 14.5l2 1.5.75 4",
  activity: "M3.5 12h4l2.5-6 4 12 2.5-6h4",
  checklist: "M10 6.5h9.5M10 12h9.5M10 17.5h9.5M4.5 6.5l1.25 1.25L8 5.5M4.5 12l1.25 1.25L8 11",
  folder: "M3.5 7 5 5.5h4l2 2h8l1.5 1.5v8.5L19 19H5l-1.5-1.5zM3.5 9.5h17",
  // Show and hide a password; the caps-lock warning next to a password field.
  eye: "M3 12l4.5-5h9l4.5 5-4.5 5h-9zM12 9L15 12L12 15L9 12z",
  eyeOff: "M3 12l4.5-5h9l4.5 5-4.5 5h-9zM12 9L15 12L12 15L9 12zM4 4l16 16",
  capsLock: "M12 4.5 4.5 12H8.5v3.5h7V12h4zM8.5 19.5h7",
  chevronDown: "M6.5 9.5 12 15l5.5-5.5",
  zoomIn: "M13 4.5 16.5 8v5L13 16.5H8L4.5 13V8L8 4.5zM15.5 15.5 20 20M7.5 10.5h6M10.5 7.5v6",
  zoomOut: "M13 4.5 16.5 8v5L13 16.5H8L4.5 13V8L8 4.5zM15.5 15.5 20 20M7.5 10.5h6",
  share:
    "M6 9.5L8.5 12L6 14.5L3.5 12zM18 3.5L20.5 6L18 8.5L15.5 6zM18 15.5L20.5 18L18 20.5L15.5 18zM8.5 12l7-6M8.5 12l7 6",
  screen: "M5 5L19 5L20.5 6.5L20.5 14.5L19 16L5 16L3.5 14.5L3.5 6.5zM8.5 20h7M12 16v4",
  expand: "M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15",
  history:
    "M4.61 15.06 8.94 19.39h6.12l4.33-4.33V8.94L15.06 4.61H8.94L4.61 8.94M9.1 8.94H4.61V4.45M12 8v4l2.5 2",
  // A bell: alerting. Struck through, a silence.
  bell: "M6.5 16v-5l2-4.5 3.5-2 3.5 2 2 4.5v5l2 2h-15zM10.5 20.5h3",
  bellOff: "M6.5 16v-5l2-4.5 3.5-2 3.5 2 2 4.5v5l2 2h-15zM10.5 20.5h3M4.5 4.5l15 15",
  trash: "M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 12.5h9l1-12.5M10 10.5v6M14 10.5v6",
  copy: "M10 8.5L18 8.5L19.5 10L19.5 18L18 19.5L10 19.5L8.5 18L8.5 10zM15.5 8.5V6L14 4.5H6L4.5 6v8L6 15.5h2.5",
  paste: "M8 5H5.5v13.5L7 20h10l1.5-1.5V5H16M9 3.5h6v3H9z",
  calendar:
    "M6 6L18 6L19.5 7.5L19.5 18.5L18 20L6 20L4.5 18.5L4.5 7.5zM4.5 10h15M8.5 3.5v4M15.5 3.5v4",
  code: "M9 7 4.5 12 9 17M15 7l4.5 5-4.5 5",
  rows: "M4.5 5h15v4h-15zM4.5 11.5h15M4.5 15.5h15M4.5 19.5h15",
  library: "M3.25 4.5h4v15h-4zM9.25 4.5h4v15h-4zM14.75 5.4l3.4-.9 2.6 14-3.4.9z",
  outline: "M4.5 6h2M9.5 6h10M6.5 12h2M11.5 12h8M6.5 18h2M11.5 18h8",
  plusSquare: "M6 4.5L18 4.5L19.5 6L19.5 18L18 19.5L6 19.5L4.5 18L4.5 6zM12 8.5v7M8.5 12h7",
  barChart: "M5.5 19.5V11M10 19.5V5.5M14.5 19.5V9M19 19.5V13",
  table: "M6 5L18 5L19.5 6.5L19.5 17.5L18 19L6 19L4.5 17.5L4.5 6.5zM4.5 10h15M4.5 14.5h15M10 10v9",
  gauge: "M4 16l.61-3.06 4.33-4.33h6.12l4.33 4.33L20 16M12 16l3.5-4",
  pie: "M15.25 4.15L19.85 8.75L19.85 15.25L15.25 19.85L8.75 19.85L4.15 15.25L4.15 8.75L8.75 4.15zM12 4.15V12h7.85",
  network:
    "M8.5 7 15.5 6M6 9.5 12 15.5M18 8.5 12 15.5M6 4.5L8.5 7L6 9.5L3.5 7zM18 3.5L20.5 6L18 8.5L15.5 6zM12 15.5L14.5 18L12 20.5L9.5 18z",
  stat: "M5 17.5h14M7 13.5v-7l-1.5 1M11 6.5h4l-3.5 7",
  text: "M5 7.5h14M5 12h14M5 16.5h9",
  filter: "M4.5 5h15l-6 7.5v6l-3 1.5v-7.5z",
  flag: "M6 20.5V4M6 4.5h11l-2.5 4 2.5 4H6",
  // Two links of a chain on a diagonal, their round ends cut into facets.
  link: "M10 14l1.3.87h3.06l1.3-.87 3-3 .87-1.3V6.64L17.36 4.47H14.3L13 5.34l-1 1M14 10l-1.3-.87H9.64L8.34 10l-3 3-.87 1.3v3.06l2.17 2.17H9.7l1.3-.87 1-1",
  help: "M15.25 4.15L19.85 8.75L19.85 15.25L15.25 19.85L8.75 19.85L4.15 15.25L4.15 8.75L8.75 4.15zM9.75 9.75V9L11 7.75h2L14.25 9v1.25L12 12v1.25M12 16.25v.25",
  // Settings: three sliders with rhombic knobs; the middle one catches the light.
  settings:
    "M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1M15 5L17 7L15 9L13 7zM9 10L11 12L9 14L7 12zM17 15L19 17L17 19L15 17z",
  // Updates: download and upload a package, look again, plan for later, a verified signature.
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  // A floppy disk: saving, as in every editor.
  save: "M5 4h11l3 3v13H5zM8 4v5h7V4M8 20v-6h8v6",
  upload: "M12 15V4M7 9l5-5 5 5M5 20h14",
  refresh:
    "M19.39 15.06 15.06 19.39H8.94L4.61 15.06V8.94L8.94 4.61h6.12l4.33 4.33M14.9 8.94h4.49V4.45",
  clock:
    "M15.25 4.15L19.85 8.75L19.85 15.25L15.25 19.85L8.75 19.85L4.15 15.25L4.15 8.75L8.75 4.15zM12 8v4l3 2",
  shieldCheck: "M12 3 19.5 6v6l-2.5 5.25L12 21l-5-3.75L4.5 12V6zM9 12l2.25 2.25L15.5 10",
  external: "M6.5 17.5l11-11M8.5 6.5h9v9",
  // Forward in a flow (Next, Open), a file, a terminal and a log of lines (where the setup code
  // is).
  arrowRight: "M5 12h14M13 6l6 6-6 6",
  file: "M6 3.5h8l4 4v13H6zM14 3.5v4h4M9 12h6M9 16h6",
  terminal: "M5 4.5L19 4.5L20.5 6L20.5 18L19 19.5L5 19.5L3.5 18L3.5 6zM7 9.5l3 2.5-3 2.5M12 15h5",
  log: "M4.5 6h15M4.5 12h15M4.5 18h10",
  // AI entry points (neutral, never in the accent color). "Fragen": a speech bubble with the AI
  // spark inside.
  ask: "M8 4.5h8l4 4v5l-4 4h-5.5L5 20l.75-3.75L4 13.5v-5zM12 8l.9 2.1 2.1.9-2.1.9L12 14l-.9-2.1-2.1-.9 2.1-.9z",
  sparkle:
    "M10.25 4l1.6 4.4 4.4 1.6-4.4 1.6-1.6 4.4-1.6-4.4-4.4-1.6 4.4-1.6zM16.75 14l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z",
  // Controls that were text characters before: a minus, a sort direction and a drag handle.
  minus: "M5 12h14",
  chevronUp: "M6.5 14.5 12 9l5.5 5.5",
  // Shift the time range a step back or forward (the dashboard toolbar, board Main).
  chevronsLeft: "M11.5 6.5 6 12l5.5 5.5M18 6.5 12.5 12l5.5 5.5",
  chevronsRight: "M6 6.5 11.5 12 6 17.5M12.5 6.5 18 12l-5.5 5.5",
  // About this item: the dashboard's details (board Main), not help.
  info: "M15.25 4.15L19.85 8.75L19.85 15.25L15.25 19.85L8.75 19.85L4.15 15.25L4.15 8.75L8.75 4.15zM12 11v5.25M12 7.75V8",
  grip: "M9 4.9L10.1 6L9 7.1L7.9 6zM15 4.9L16.1 6L15 7.1L13.9 6zM9 10.9L10.1 12L9 13.1L7.9 12zM15 10.9L16.1 12L15 13.1L13.9 12zM9 16.9L10.1 18L9 19.1L7.9 18zM15 16.9L16.1 18L15 19.1L13.9 18z",
  // Families of data sources without a logo (features/datasources/kindMarks.tsx). Braces: documents
  // with nested fields.
  documents: "M9 4.5H7.5l-1 1V10l-2 2 2 2v4.5l1 1H9M15 4.5h1.5l1 1V10l2 2-2 2v4.5l-1 1H15",
  // Lines of text and a lens: an index to search.
  searchIndex:
    "M3.75 5.5h10M3.75 9.5h6M3.75 13.5h4M16.59 9.77L18.48 11.66L18.48 14.34L16.59 16.23L13.91 16.23L12.02 14.34L12.02 11.66L13.91 9.77zM17.75 15.5l2.5 2.5",
  // A file holding a table: a database in one file.
  fileTable: "M6.5 3.5h7l4 4v13h-11zM13.5 3.5v4h4M9 12h6v5.5H9zM9 14.75h6M12 12v5.5",
  // A puzzle piece: what a plugin adds.
  plugin: "M4.5 6.5H9V5l1.5-1.5h1L13 5v1.5h4.5V11H19l1.5 1.5v1L19 15h-1.5v4.5h-13z",
  // A service account: a small robot.
  robot:
    "M6.75 8L17.25 8L19 9.75L19 17.25L17.25 19L6.75 19L5 17.25L5 9.75zM12 4v4M9.5 13h.01M14.5 13h.01M3 13v2M21 13v2",
  // The tools on a graph's canvas: the pointer, a rectangle and a lasso to select with, and the two
  // arrows of its history.
  pointer: "M6.5 4l11 6.5-4.75 1.5 2.75 6-2.5 1.2-2.75-6L7 16.5z",
  selectRect:
    "M4.5 5.5h3M10.5 5.5h3M16.5 5.5h3v3M19.5 11v3M19.5 16.5v2h-3M13.5 18.5h-3M7.5 18.5h-3v-2M4.5 14v-3M4.5 8.5v-3",
  lasso: "M8 4.5h8l4 3.25v3.5L16 14.5H8L4 11.25v-3.5zM8.5 14.5l1.25 2.5L8 19.5",
  undo: "M9 5 5 9l4 4M5 9h10.5l3 3v3.5l-3 3h-5",
  redo: "M15 5l4 4-4 4M19 9H8.5l-3 3v3.5l3 3h5",
  // A painter's palette: the style rules of a graph panel.
  palette:
    "M8.75 4.15h6.5l4.6 4.6v3.75H16L14.5 14v2l1 1.5-2 2.35H8.75l-4.6-4.6v-6.5zM7.5 11.5h.01M9.5 7.5h.01M14.5 7.5h.01",
  // One person: a faceted head and shoulders.
  user: "M12 4.25L15.25 6.12L15.25 9.88L12 11.75L8.75 9.88L8.75 6.12zM5 20.5l1.75-5h10.5l1.75 5",
  mail: "M5 5.5L19 5.5L20.5 7L20.5 17L19 18.5L5 18.5L3.5 17L3.5 7zM3.5 7.5 12 13l8.5-5.5",
  cloud: "M7 18.5h10.5l2.5-2.5v-2.5L18 11.5h-.75l-.75-3L13.5 6h-3L8 8.5l-.75 2.5H6.5L4 13.5V16z",
  folderOpen: "M3.5 18V7L5 5.5h4l2 2h6.5L19 9v2M3.5 18 6 11h15l-2.5 7z",
  key: "M8 7.5L12.5 12L8 16.5L3.5 12zM12.5 12h8M17.5 12v3M20.5 12v2.5",
  server:
    "M5 4.5L19 4.5L20 5.5L20 9.5L19 10.5L5 10.5L4 9.5L4 5.5zM5 13.5L19 13.5L20 14.5L20 18.5L19 19.5L5 19.5L4 18.5L4 14.5zM7.5 7.5h.01M7.5 16.5h.01",
  // A calendar with a clock: something that runs on a schedule.
  schedule:
    "M10.5 19H6l-1.5-1.5v-11L6 5h12l1.5 1.5V10M4.5 9.5h15M8.5 3.5v3M15.5 3.5v3M18.03 12.8L20.2 14.97L20.2 18.03L18.03 20.2L14.97 20.2L12.8 18.03L12.8 14.97L14.97 12.8zM16.5 15v1.5l1 1",
  webhook:
    "M12 3.75L14.25 6L12 8.25L9.75 6zM6 14.75L8.25 17L6 19.25L3.75 17zM18 14.75L20.25 17L18 19.25L15.75 17zM10.75 8 7.25 14.75M8.25 17h7.5M16.75 14.75 13.25 8",
  // A conversation in a chat tool (Slack, Teams): a bubble with lines.
  channel: "M5 5h14l1.5 1.5v8L19 16h-7l-4 3.5V16H5l-1.5-1.5v-8zM8 9h8M8 12h5",
  report: "M6 3.5h8l4 4v13H6zM14 3.5v4h4M9 17v-3M12 17v-5M15 17v-2",
  mapPin: "M12 21 6.5 13.5V9l2-3.5 3.5-2 3.5 2 2 3.5v4.5zM12 7L14 9L12 11L10 9z",
  layers: "M12 4l8 4-8 4-8-4zM4 12l8 4 8-4M4 16l8 4 8-4",
  // A series that goes on as a dashed guess.
  forecast: "M4 17l4-4.5 3 2.5 3-4M16 8.5l1-1M19 5.5l1-1M4 19.5h16",
  // Points along a baseline and one far above them.
  outlier: "M6 16h.01M9 14h.01M12 15h.01M15 12.5h.01M18 4.5L20.5 7L18 9.5L15.5 7zM4 19.5h16",
  tab: "M3.5 8.5V6L5 4.5h4.5L11 6v2.5M11 8.5V7l1.5-1.5H17L18.5 7v1.5M3.5 8.5h17v9.5L19 19.5H5L3.5 18z",
} as const;

export type IconName = keyof typeof PATHS;

/** Every icon's name, for the tests that keep the set in one style. */
export const ICON_NAMES = Object.keys(PATHS) as readonly IconName[];

/** The outline of an icon, on the 24 px grid. */
export function iconPath(name: IconName): string {
  return PATHS[name];
}

/** The Kalzit mark alone, for drawings that need it at another stroke (the sign-in backdrop). */
export const LOGO_PATH: string = PATHS.logo;

/** Icons drawn filled instead of outlined (the starred state of a star). */
const FILLED: ReadonlySet<IconName> = new Set<IconName>(["starFilled"]);

/**
 * Parts drawn filled on top of the outline, in the same color: the dark half of the contrast
 * octagon. The outline keeps its stroke, so the filled part lines up with the rest of the icon.
 */
const FILLS: Partial<Record<IconName, string>> = {
  contrast: "M12 4.15h3.25l4.6 4.6v6.5l-4.6 4.6H12z",
};

/**
 * The lit facet of an icon with a surface: one face, tinted with the text color (components.css,
 * --icon-facet-opacity). It is gone in the contrast theme and with forced colors, so no meaning
 * rests on it.
 */
const FACETS: Partial<Record<IconName, string>> = {
  home: "M10 14h4v6h-4z",
  dashboards: "M13 4h5l2 2v3h-7z",
  explore: "M15.75 8.25 13.2 13.2 10.8 10.8z",
  dataSources: "M4.5 6.5 12 3.5l7.5 3-7.5 3z",
  lock: "M7.75 10.5h8.5l1.25 1.25v7L16.25 20h-8.5L6.5 18.75v-7z",
  passkey: "M9.75 3.75L6.72 5.5L6.72 9L9.75 10.75z",
  sidebar: "M6 4.5h3.5v15H6l-1.5-1.5V6z",
  pin: "M10 9.5 7 13h10l-3-3.5z",
  edit: "M5 15.5 8.5 19H5z",
  members: "M9 4L5.97 5.75L5.97 9.25L9 11z",
  folder: "M3.5 7 5 5.5h4l2 2h8l1.5 1.5v.5h-17z",
  eye: "M12 9L15 12L12 15L9 12z",
  share: "M6 9.5L8.5 12L6 14.5L3.5 12z",
  screen: "M5 5h6l-7.5 7.5v-6z",
  bell: "M6.5 11l2-4.5 3.5-2L10 11z",
  calendar: "M6 6h12l1.5 1.5V10h-15V7.5z",
  library: "M3.25 4.5h4v15h-4z",
  table: "M6 5h12l1.5 1.5V10h-15V6.5z",
  pie: "M12 4.15L15.25 4.15L19.85 8.75L19.85 12L12 12z",
  network: "M12 15.5L14.5 18L12 20.5L9.5 18z",
  flag: "M6 4.5h11l-2.5 4 2.5 4H6z",
  settings: "M9 10L11 12L9 14L7 12z",
  save: "M8 4h7v5H8z",
  shieldCheck: "M12 3 4.5 6v6L7 17.25 12 21z",
  file: "M14 3.5l4 4h-4z",
  fileTable: "M13.5 3.5l4 4h-4z",
  plugin: "M4.5 12.5v7h7z",
  user: "M12 4.25L8.75 6.12L8.75 9.88L12 11.75z",
  mail: "M5 5.5h14l1.5 1.5v.5L12 13 3.5 7.5V7z",
  folderOpen: "M3.5 18 6 11h15l-2.5 7z",
  key: "M8 10.5L9.5 12L8 13.5L6.5 12z",
  server: "M5 4.5L19 4.5L20 5.5L20 9.5L19 10.5L5 10.5L4 9.5L4 5.5z",
  webhook: "M12 3.75L14.25 6L12 8.25L9.75 6z",
  report: "M14 3.5l4 4h-4z",
  mapPin: "M12 7L14 9L12 11L10 9z",
  layers: "M12 4l8 4-8 4-8-4z",
  outlier: "M18 4.5L20.5 7L18 9.5L15.5 7z",
  tab: "M3.5 8.5V6L5 4.5h4.5L11 6v2.5z",
};

/** Simpler drawings for 12 px (`size="small"`), drawn with a wider stroke (--icon-stroke-small). */
const SMALL: Partial<Record<IconName, string>> = {
  chevron: "M9.5 6 15.5 12l-6 6",
  back: "M14.5 6 8.5 12l6 6",
  chevronDown: "M6 9.5l6 6 6-6",
  chevronUp: "M6 14.5l6-6 6 6",
  close: "M6.5 6.5l11 11M17.5 6.5l-11 11",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  arrowUp: "M12 19V5M6 11l6-6 6 6",
  arrowDown: "M12 5v14M6 13l6 6 6-6",
  arrowRight: "M5 12h14M13 6l6 6-6 6",
};

/** The lit facet of an icon, if it has one (for the tests). */
export function iconFacet(name: IconName): string | undefined {
  return FACETS[name];
}

/** The 12 px drawing of an icon, if it has one (for the tests). */
export function iconSmallPath(name: IconName): string | undefined {
  return SMALL[name];
}

/**
 * One style for every icon: the 24 px grid, the stroke of `--icon-stroke` (components.css; the
 * attribute holds the same value for drawings without the stylesheet), round caps, mitered joins
 * that turn into bevels at sharp angles, the current text color, and the drawing inside 3 to 21
 * and centered on 12,12 (Icon.test.tsx). 16 and 20 px use the same drawing; `size="small"` (12
 * px) uses the simpler one where there is one.
 */
export function Icon({
  name,
  className,
  size,
}: {
  name: IconName;
  className?: string;
  size?: "small";
}) {
  const small = size === "small";
  const classes = ["icon", small ? "icon--small" : null, className ?? null]
    .filter(Boolean)
    .join(" ");
  const fill = FILLS[name];
  const facet = FACETS[name];
  return (
    <svg
      className={classes}
      viewBox="0 0 24 24"
      fill={FILLED.has(name) ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={small ? "2" : "1.5"}
      strokeLinecap="round"
      strokeLinejoin="miter"
      strokeMiterlimit="2"
      aria-hidden="true"
      focusable="false"
    >
      {facet === undefined ? null : <path className="icon__facet" d={facet} fill="currentColor" />}
      <path d={(small ? SMALL[name] : undefined) ?? PATHS[name]} />
      {fill === undefined ? null : <path d={fill} fill="currentColor" />}
    </svg>
  );
}
