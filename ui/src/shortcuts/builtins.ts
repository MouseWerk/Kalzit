import { combo, keySet, sequence } from "./keyNames";
import type { AreaDef, ShortcutDef } from "./registry";

/**
 * The app's own shortcuts, by area, in the help's fixed order (board Shortcuts, frame 4). A new
 * shortcut is defined here (or with `defineShortcut` from its feature) and matched with
 * `matchesShortcut`; the help, tooltips and `aria-keyshortcuts` follow on their own.
 *
 * The graph canvas of M8 adds its keys to the "graph" area the same way.
 */
export const BUILTIN_AREAS: readonly AreaDef[] = [
  { id: "everywhere", title: "shortcuts.area.everywhere" },
  { id: "lists", title: "shortcuts.area.lists" },
  { id: "palette", title: "shortcuts.area.palette" },
  {
    id: "time",
    title: "shortcuts.area.time",
    sequence: true,
    page: '[data-shortcuts~="time"]',
  },
  {
    id: "dashboardEdit",
    title: "shortcuts.area.dashboardEdit",
    page: '[data-shortcuts~="dashboardEdit"]',
  },
  { id: "panelEditor", title: "shortcuts.area.panelEditor", page: ".dashboard--editor" },
  { id: "explore", title: "shortcuts.area.explore", page: ".explore" },
  { id: "editors", title: "shortcuts.area.editors", focus: ".cm-editor, .code-editor" },
  {
    id: "charts",
    title: "shortcuts.area.charts",
    detail: "shortcuts.area.chartsDetail",
    focus: ".ts__plot, .readout",
  },
  {
    id: "graph",
    title: "shortcuts.area.graph",
    detail: "shortcuts.area.graphDetail",
    focus: ".graph__stage",
  },
  {
    id: "traces",
    title: "shortcuts.area.traces",
    detail: "shortcuts.area.tracesDetail",
    focus: ".trace-grid",
  },
  {
    id: "analyses",
    title: "shortcuts.area.analyses",
    detail: "shortcuts.area.analysesDetail",
    page: ".analyses-layout",
  },
  { id: "policies", title: "shortcuts.area.policies", page: '[data-shortcuts~="policies"]' },
  { id: "ask", title: "shortcuts.area.ask", page: ".ask__main" },
];

const ARROWS_UD = ["ArrowUp", "ArrowDown"];
const ARROWS_LR = ["ArrowLeft", "ArrowRight"];
const ARROWS = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"];

export const BUILTIN_SHORTCUTS: readonly ShortcutDef[] = [
  // Everywhere
  {
    id: "palette.open",
    area: "everywhere",
    keys: [combo("Mod", "K"), combo("/")],
    label: "shortcuts.palette.open",
    note: "shortcuts.note.notKiosk",
  },
  // The key cap in the top bar's search field.
  { id: "palette.key", area: "everywhere", keys: [combo("Mod", "K")], partOf: "palette.open" },
  { id: "help.toggle", area: "everywhere", keys: [combo("?")], label: "shortcuts.help.toggle" },
  {
    id: "layer.close",
    area: "everywhere",
    keys: [combo("Esc")],
    label: "shortcuts.layer.close",
    note: "shortcuts.layer.closeNote",
  },
  {
    id: "regions.next",
    area: "everywhere",
    keys: [combo("F6"), combo("Shift", "F6")],
    label: "shortcuts.regions",
  },
  {
    id: "sidebar.toggle",
    area: "everywhere",
    keys: [combo("Mod", "B")],
    label: "shortcuts.sidebar.toggle",
    note: "shortcuts.note.wide",
  },

  // Menus, lists and tabs: the same keys in every menu, list, tree and tab row.
  {
    id: "lists.move",
    area: "lists",
    keys: [keySet([], ...ARROWS_UD)],
    label: "shortcuts.lists.move",
  },
  {
    id: "lists.ends",
    area: "lists",
    keys: [keySet([], "Home", "End")],
    label: "shortcuts.lists.ends",
  },
  {
    id: "lists.sideways",
    area: "lists",
    keys: [keySet([], ...ARROWS_LR)],
    label: "shortcuts.lists.sideways",
  },
  {
    id: "lists.choose",
    area: "lists",
    keys: [combo("Enter"), combo("Space")],
    label: "shortcuts.lists.choose",
  },

  // Command palette
  {
    id: "palette.move",
    area: "palette",
    keys: [keySet([], ...ARROWS_UD)],
    label: "shortcuts.palette.move",
  },
  {
    id: "palette.page",
    area: "palette",
    keys: [keySet([], "PgUp", "PgDn")],
    label: "shortcuts.palette.page",
  },
  { id: "palette.run", area: "palette", keys: [combo("Enter")], label: "shortcuts.palette.run" },

  // Time range: one key after the other.
  {
    id: "time.back",
    area: "time",
    keys: [sequence("T", "ArrowLeft")],
    label: "shortcuts.time.back",
  },
  {
    id: "time.forward",
    area: "time",
    keys: [sequence("T", "ArrowRight")],
    label: "shortcuts.time.forward",
  },
  { id: "time.zoomOut", area: "time", keys: [sequence("T", "Z")], label: "shortcuts.time.zoomOut" },
  { id: "time.copy", area: "time", keys: [sequence("T", "C")], label: "shortcuts.time.copy" },
  { id: "time.paste", area: "time", keys: [sequence("T", "V")], label: "shortcuts.time.paste" },

  // Edit dashboard
  { id: "panel.edit", area: "dashboardEdit", keys: [combo("E")], label: "shortcuts.panel.edit" },
  {
    id: "panel.duplicate",
    area: "dashboardEdit",
    keys: [combo("Mod", "D")],
    label: "shortcuts.panel.duplicate",
  },
  {
    id: "panel.copy",
    area: "dashboardEdit",
    keys: [combo("Mod", "C")],
    label: "shortcuts.panel.copy",
  },
  {
    id: "panel.paste",
    area: "dashboardEdit",
    keys: [combo("Mod", "V")],
    label: "shortcuts.panel.paste",
  },
  {
    id: "panel.remove",
    area: "dashboardEdit",
    keys: [combo("Del")],
    label: "shortcuts.panel.remove",
    note: "shortcuts.panel.removeNote",
  },
  {
    id: "panel.move",
    area: "dashboardEdit",
    keys: [keySet([], ...ARROWS)],
    label: "shortcuts.panel.move",
    context: "handle",
  },
  {
    id: "panel.resize",
    area: "dashboardEdit",
    keys: [keySet(["Shift"], ...ARROWS)],
    label: "shortcuts.panel.resize",
    context: "handle",
  },
  {
    id: "row.move",
    area: "dashboardEdit",
    keys: [keySet([], ...ARROWS_UD)],
    label: "shortcuts.row.move",
    context: "rowHandle",
  },

  // Panel editor
  {
    id: "panelEditor.run",
    area: "panelEditor",
    keys: [combo("Mod", "Enter")],
    label: "shortcuts.query.run",
    note: "shortcuts.note.inEditor",
  },
  {
    id: "panelEditor.back",
    area: "panelEditor",
    keys: [combo("Esc")],
    label: "shortcuts.panelEditor.back",
    note: "shortcuts.panelEditor.backNote",
    overrides: "layer.close",
  },

  // Explore
  {
    id: "explore.run",
    area: "explore",
    keys: [combo("Mod", "Enter")],
    label: "shortcuts.query.run",
    note: "shortcuts.note.inEditor",
    context: "editor",
  },
  {
    id: "explore.helpPanel",
    area: "explore",
    keys: [combo("Shift", "F1"), combo("Mod", "/")],
    label: "shortcuts.explore.helpPanel",
  },
  {
    id: "explore.save",
    area: "explore",
    keys: [combo("Mod", "S")],
    label: "shortcuts.explore.save",
  },
  {
    id: "explore.saveAs",
    area: "explore",
    keys: [combo("Mod", "Shift", "S")],
    label: "shortcuts.explore.saveAs",
  },
  {
    id: "explore.open",
    area: "explore",
    keys: [combo("Mod", "O")],
    label: "shortcuts.explore.open",
  },
  {
    id: "explore.aiDraft",
    area: "explore",
    keys: [combo("Mod", "Enter")],
    label: "shortcuts.explore.aiDraft",
    note: "shortcuts.explore.aiDraftNote",
    context: "aiField",
  },

  // Query editors
  {
    id: "editor.suggest",
    area: "editors",
    keys: [combo("Ctrl", "Space")],
    label: "shortcuts.editor.suggest",
  },
  {
    id: "editor.suggestClose",
    area: "editors",
    keys: [combo("Esc")],
    label: "shortcuts.editor.suggestClose",
    overrides: "layer.close",
  },
  { id: "editor.undo", area: "editors", keys: [combo("Mod", "Z")], label: "shortcuts.editor.undo" },
  {
    id: "editor.redo",
    area: "editors",
    // Both everywhere; the platform's own first (board Shortcuts, decision 4).
    keys: (platform) =>
      platform === "mac"
        ? [combo("Mod", "Shift", "Z"), combo("Mod", "Y")]
        : [combo("Mod", "Y"), combo("Mod", "Shift", "Z")],
    label: "shortcuts.editor.redo",
  },
  {
    id: "editor.comment",
    area: "editors",
    keys: [combo("Mod", "/")],
    label: "shortcuts.editor.comment",
  },

  // Charts, with the focus on the chart
  {
    id: "chart.readout",
    area: "charts",
    keys: [keySet([], ...ARROWS_LR)],
    label: "shortcuts.chart.readout",
  },
  {
    id: "chart.readoutFast",
    area: "charts",
    keys: [keySet(["Shift"], ...ARROWS_LR)],
    label: "shortcuts.chart.readoutFast",
  },
  {
    id: "chart.ends",
    area: "charts",
    keys: [keySet([], "Home", "End")],
    label: "shortcuts.chart.ends",
  },
  {
    id: "chart.annotate",
    area: "charts",
    keys: [combo("A"), combo("Mod", "Click")],
    label: "shortcuts.chart.annotate",
  },
  {
    id: "chart.annotateClick",
    area: "charts",
    keys: [combo("Mod", "Click")],
    partOf: "chart.annotate",
  },

  // Graph, with the focus on the canvas
  { id: "graph.next", area: "graph", keys: [keySet([], ...ARROWS)], label: "shortcuts.graph.next" },
  { id: "graph.open", area: "graph", keys: [combo("Enter")], label: "shortcuts.graph.open" },
  { id: "graph.select", area: "graph", keys: [combo("Space")], label: "shortcuts.graph.select" },
  { id: "graph.only", area: "graph", keys: [combo("S")], label: "shortcuts.graph.only" },
  { id: "graph.pin", area: "graph", keys: [combo("P")], label: "shortcuts.graph.pin" },
  {
    id: "graph.zoom",
    area: "graph",
    keys: [keySet([], "+", "-", "0")],
    label: "shortcuts.graph.zoom",
  },
  { id: "graph.undo", area: "graph", keys: [combo("Mod", "Z")], label: "shortcuts.graph.undo" },
  {
    id: "graph.clear",
    area: "graph",
    keys: [combo("Esc")],
    label: "shortcuts.graph.clear",
    overrides: "layer.close",
  },

  // Traces, with the focus on the waterfall
  {
    id: "trace.move",
    area: "traces",
    keys: [keySet([], ...ARROWS_UD)],
    label: "shortcuts.trace.move",
  },
  {
    id: "trace.toggle",
    area: "traces",
    keys: [keySet([], ...ARROWS_LR)],
    label: "shortcuts.trace.toggle",
  },
  { id: "trace.open", area: "traces", keys: [combo("Enter")], label: "shortcuts.trace.open" },
  {
    id: "trace.close",
    area: "traces",
    keys: [combo("Esc")],
    label: "shortcuts.trace.close",
    overrides: "layer.close",
  },

  // Analyses, the list
  {
    id: "analyses.search",
    area: "analyses",
    keys: [combo("/")],
    label: "shortcuts.analyses.search",
    note: "shortcuts.analyses.searchNote",
    overrides: "palette.open",
  },
  {
    id: "analyses.rows",
    area: "analyses",
    keys: [keySet([], "J", "K")],
    label: "shortcuts.analyses.rows",
  },

  // Alerting: notification policies
  {
    id: "policies.open",
    area: "policies",
    keys: [combo("Enter")],
    label: "shortcuts.policies.open",
  },
  {
    id: "policies.move",
    area: "policies",
    keys: [keySet(["Alt"], ...ARROWS_UD)],
    label: "shortcuts.policies.move",
  },
  {
    id: "policies.moveUp",
    area: "policies",
    keys: [combo("Alt", "ArrowUp")],
    partOf: "policies.move",
  },
  {
    id: "policies.moveDown",
    area: "policies",
    keys: [combo("Alt", "ArrowDown")],
    partOf: "policies.move",
  },
  // Alt+Left and Right are the browser's Back and Forward; step 2 of board Shortcuts moves
  // indenting to Alt+Shift with the arrows (decision 6). Only these definitions change then.
  {
    id: "policies.indent",
    area: "policies",
    keys: [keySet(["Alt"], "ArrowRight", "ArrowLeft")],
    label: "shortcuts.policies.indent",
  },
  {
    id: "policies.indentIn",
    area: "policies",
    keys: [combo("Alt", "ArrowRight")],
    partOf: "policies.indent",
  },
  {
    id: "policies.outdent",
    area: "policies",
    keys: [combo("Alt", "ArrowLeft")],
    partOf: "policies.indent",
  },

  // Ask
  { id: "ask.send", area: "ask", keys: [combo("Enter")], label: "shortcuts.ask.send" },
  {
    id: "ask.newline",
    area: "ask",
    keys: [combo("Shift", "Enter")],
    label: "shortcuts.ask.newline",
  },
  {
    id: "ask.stop",
    area: "ask",
    keys: [combo("Esc")],
    label: "shortcuts.ask.stop",
    overrides: "layer.close",
  },
];
