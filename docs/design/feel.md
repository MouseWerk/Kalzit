# Kalzit: look and feel

How the interface should feel, what is wrong with it today, and the plan to get there. Written
after an audit of the running app (2026-10-22) against mature data tools and the owner's visual
reference. Measurements are from the release build with the demo data (a dashboard with eight
panels), in Chromium at 1920 x 1080 unless noted; "4x" means four times CPU throttling, roughly a
mid-range laptop on battery.

## 1. What we are aiming for

The owner's words: the app "still looks very bare-bones", "the editor in the dashboard feels
laggy" and "the dashboard does not use the full width of the monitor". Two references set the
target.

**Mature data tools** (dashboard tools, search and log consoles, BI tools, cloud monitoring, an
infrastructure admin console, a graph browser). What makes them feel dense, professional and
full, translated into rules for Kalzit:

1. **The canvas is the whole window.** Dashboards, Explore and lists fill the width next to the
   sidebar. A centered reading width is for forms, settings and text only.
2. **One spacing unit, small gaps.** Everything on the 4 px grid; 8 px between panels, 8 px
   inside a panel's frame. Loose 16 px gaps are what makes a dashboard look sparse.
3. **A fine grid.** 24 columns with short rows (about 30 px) so a small stat sits next to a
   large chart without empty space.
4. **Three close layers.** Sidebar and wells a step below the canvas, cards and panels a step
   above it, popovers above those; 2 to 4 % lightness apart in dark. Hairline borders carry the
   structure, not shadows.
5. **Quiet panel chrome.** A 32 px title bar, medium-weight title at body size, actions in one
   menu that shows on hover or focus. Loading is a thin bar at the panel's top edge that keeps the
   old data visible; errors are a small icon in the title bar with the message on hover or focus;
   "no data" is one muted line.
6. **One toolbar row.** Title (and breadcrumbs) on the left; variables, time range, refresh with
   interval, share and edit on the right. A kiosk mode removes every piece of chrome.
7. **Split editors.** The panel editor is a full-page view: live preview on top, queries below,
   options in a resizable pane on the right (about 330 px). Splits snap shut below a threshold and
   remember their size.
8. **Never query per keystroke.** Queries run on Ctrl+Enter, on the Run button or on leaving the
   editor. Display options redraw the cached result without a new query. A changed but unrun
   query marks the preview as stale.
9. **Keyboard first.** Ctrl+K palette, `/` for search, `?` for help, `e` to edit the panel under
   the pointer, `v` to view it alone, Esc to leave, Ctrl+S to save; arrow keys move and resize
   panels.
10. **Fast, short motion.** 90 to 250 ms, standard easing, none at all for reduced motion. Drag
    and resize follow the pointer and snap on release.
11. **Body text 13 to 14 px**, secondary 12 px, one sans and one mono, weights 400 to 600; large
    type only for page greetings and stat numbers.

**The owner's visual reference** (a dark SaaS dashboard). Its qualities, in Kalzit's terms:

- Near-black neutral graphite, almost monochrome: sidebar darkest, canvas a step lighter, cards
  one more step, each card with a hairline border just lighter than its fill. No shadows, no
  gradients. Light is the same idea inverted: soft greys, white cards, hairline borders.
- Generous radii: cards about 10 px, buttons and nav items about 6 px (after scaling the
  reference down by 1.5).
- A clean grotesk; titles medium weight; body in muted grey, primary text near white.
- Sidebar about 240 px: a workspace switcher card on top (mark, name, up/down chevron), Search
  with a small `/` keycap, nav groups between thin dividers, 1.5 px outline icons, the current
  item a slightly lighter pill with a hairline border and white text (neutral, as our rules
  require), a folders section, and a dismissible card at the bottom.
- Page header: a small icon and the page name in muted text, then a large greeting on the start
  page.
- Stat cards: small muted label, a large number (about 30 px, regular weight), an illustration
  well on the right behind a vertical hairline.
- Monochrome charts: the main series a near-white smooth line, a comparison series a grey dashed
  line, a diagonal hatch under the main line instead of a solid fill, horizontal grid lines only,
  very faint, muted axis labels, no frame besides the card.
- Content cards with a thumbnail tile, title, two muted lines, avatars with a count, and two
  actions: a filled secondary button and a ghost button.

Kalzit keeps its own name, texts, icons and accent: the sunstone copper stays, used sparingly,
for primary actions and data highlights only.

## 2. Principles

1. **Canvas pages fill the window; form pages keep the reading width.** Canvas: dashboards,
   Explore, the dashboard and data source lists, admin lists. Reading width (72 rem): data source
   form, settings, account, dialogs.
2. **Graphite first, color for meaning.** Surfaces are neutral; color comes from data (series,
   thresholds, states) and from the one primary action per view.
3. **Density by default.** 8 px grid gap, 8 px panel padding, 32 px controls and title bars,
   14 px body, 13 px in tables and panel titles.
4. **Chrome on demand.** Panel actions, row tools and resize handles appear on hover or focus,
   always on touch screens and in edit mode.
5. **Responsive to the frame.** No interaction may cost more than one frame (16 ms) at 1x or
   three frames at 4x; nothing paints stale geometry.
6. **States stay neutral.** Current, selected and active are a quiet tint plus weight, or the
   raised pill with a neutral hairline. Never an accent border, outline, glow or left bar. Focus
   is the neutral ring on `:focus-visible` only.
7. **Every theme, every width.** Light, dark and contrast; 360 px phones without horizontal page
   scroll; the 900, 1280 and 1920 px widths from the plan.
8. **Motion is optional.** Durations come from tokens that drop to zero for
   `prefers-reduced-motion`.

## 3. Audit: before and after per page

Screenshots of every page at 1920 x 1080 and 1440 x 900, light and dark, were taken from the
release build before and after the quick wins (see the PR). Findings:

| Page | Before | After the quick wins | Still to do (phase 2) |
|---|---|---|---|
| Shell | Warm stone surfaces; sidebar lighter than the canvas in dark; current nav item a flat tint | Graphite layers, sidebar below the canvas, current item a raised pill with a hairline | Workspace switcher card, Search with `/` keycap, group dividers, folders section, setup checklist card (#28) |
| Start | One empty state in a capped column | Full width | Greeting, stat cards (dashboards, data sources, later alerts), recent and starred dashboards as cards (#28) |
| Dashboards list | Capped at 72 rem | Full width | Cards view with thumbnails next to the table; starred; folder tree with folder marks |
| Dashboard | 1152 of 1624 px used at 1920 (71 %), two 236 px empty margins; every panel title bar full of text buttons; 4 px corners | Edge to edge (1640 of 1640 px); actions show on hover or focus; 10 px card radius; medium titles; grid gap and padding from density tokens | Panel menu (one icon button) instead of text buttons; loading bar instead of "Loading..."; error icon in the title bar; one-row toolbar with icon buttons; kiosk (#32) |
| Dashboard, edit mode | Each panel shows six text buttons; drag snaps late and has no ghost | Unchanged except the tokens | Live drag and resize with a placeholder, commit on release; selection outline neutral; edit toolbar (#32) |
| Panel editor | Modal dialog, 72 rem; preview only 18 rem high; options as long radio lists | Unchanged except the tokens | Full-page editor: preview on top, queries below, options pane on the right, resizable splits; panel picker cards (#33); query editor header with the kind mark |
| Explore | Capped at 72 rem; editor and chart share the width of a form | Full width | Split view, history, kind mark in the source picker, results area with tabs in a card (#27, #29, #30) |
| Data sources | Table capped; kind as plain text; picker as plain buttons with one generic icon | Full-width table with a kind mark; picker as cards with mark, name and one-line summary | Health column with status dot and last check; row hover actions |
| Data source form | Generic icon in the header | Kind mark in the header | Two-column form on wide screens (connection left, limits right) |
| Admin | Lists and settings in one capped column | Lists full width; settings keep the reading width | Table density (36 px rows), row actions on hover, sticky table headers |
| Sign-in | Centered card on paper | Graphite tokens | Side illustration well in the reference's style on wide screens |

## 4. Tokens

Changed in the quick wins (`ui/src/styles/tokens.css`):

| Token | Before | After | Why |
|---|---|---|---|
| `--bg` / `--bg-surface` / `--bg-raised` (dark) | 17 / 19.5 / 21.5 % L, warm hue 60 | 19.7 / 16.9 / 22.8 % L, hue 286, chroma 0.003 to 0.006 | Sidebar and wells below the canvas, cards above; graphite |
| same (light) | 97.6 / 95.6 / 99.5 % L, warm | 97.8 / 95.8 / 100 % L, neutral | White cards on soft grey |
| `--bg-hover`, `--bg-active`, `--border` | warm | neutral, `--border` a step above `--bg-active` | The hairline stays visible on an active pill |
| `--text`, `--text-muted` | warm | neutral; muted 72 % L in dark, 46 % in light | AA on every surface (styles.test.ts) |
| `--radius-sm/md/lg` | 3 / 4 / 8 px | 4 / 6 / 10 px | Softer, as the reference |
| `--chart-8`, `--shadow-color`, `--focus-ring` | warm | neutral | No warm cast left in the neutrals |
| new `--space-gutter` | | 24 px | Gutter around canvas pages |
| new `--space-grid`, `--space-panel` | | 8 px each | Dashboard grid gap, panel padding |
| new `--size-grid-row`, `--size-panel-header` | | 32 px each | Dashboard row, panel title bar |
| new `--size-kind-mark(-small)` | | 40 / 24 px | Data source kind marks |
| `--content-max-width` | caps the whole content | caps forms, settings and lead text only | Full-width canvases |

Phase 2 tokens:

- Type scale: `--font-size-display` (stat numbers, 30 px; #33 adds a 32 px one, align on one
  value), `--font-size-greeting` (start page, 26 px, already `--font-size-2xl`).
- Monochrome charts: `--chart-mono` (main series: near white in dark, near black in light),
  `--chart-mono-compare` (grey for the dashed comparison series), `--chart-hatch` (the hatch
  stroke, 3:1 against the panel is not needed for a fill, but the line above it must keep 3:1),
  `--chart-grid` (horizontal grid lines, fainter than `--border`).
- Motion: `--duration-instant` (90 ms) for hover reveals; all durations still zero for reduced
  motion.
- Elevation: `--bg-overlay` for popovers and the palette, one step above `--bg-raised`.

## 5. Layout

- `.shell__content` has no width cap. Canvas pages use the full width with `--space-gutter`
  around them.
- Reading width (`--content-max-width`, 72 rem) applies to: data source form (`.ds-edit`), admin
  settings lists, page lead text, dialogs. New form pages opt in the same way.
- Dashboards: 24 columns, 32 px rows, 8 px gaps, at every desktop width; one column below
  48 rem as today. Phase 2: an optional "fixed width" per dashboard for TV walls is not needed;
  kiosk mode fills the screen instead.
- Explore (phase 2): source picker, time range and Run in one toolbar row; query editor and
  result one above the other, resizable; a second pane side by side on wide screens (split view).
- Panel editor (phase 2): replaces the dialog with a full-page view at
  `/dashboards/$id/panels/$panelId/edit`: preview on top (resizable, 50 % by default), query
  editors below, options pane on the right (resizable, 330 px, collapsible); Esc goes back to the
  dashboard with the change applied but unsaved, as today.

## 6. Panel chrome

- Title bar 32 px, title 13 px medium weight, truncated with the full title on hover.
- View mode: the actions appear on hover or keyboard focus (done in the quick wins, CSS only).
  Phase 2 (#32): replace the text buttons with one icon button that opens a menu (View, Edit,
  Inspect, Duplicate, Copy, Remove, links), keyboard shortcuts shown in the menu.
- Loading: a 2 px indeterminate bar at the top edge in `--text-muted`, the last result stays.
  First load: a skeleton of the visualization's shape (lines for a time series, a block for a
  stat).
- Errors: an alert icon in the title bar (danger color for the icon only), message in a tooltip
  and in Inspect; the panel keeps its last data when there is any.
- Edit mode: the whole title bar is the drag handle, a resize corner at the bottom right, the
  selected panel tinted (`--bg-hover`), never outlined in the accent.

## 7. Toolbar

One row, 40 px: title on the left; on the right variables (when few), time range, refresh as a
split button (Refresh plus interval), then Share, Edit (primary) and a "more" menu for history,
access, settings and delete. Icon buttons carry their name in a tooltip and as their accessible
name. Variables wrap to a second row only when there are many. (#32 owns the toolbar.)

## 8. Charts

- Single series and stat sparklines: monochrome by default (`--chart-mono`), smooth line, hatch
  under the line, faint horizontal grid only, muted axis labels.
- A comparison series (time shift, previous period): `--chart-mono-compare`, dashed.
- Two or more series: the accessible categorical palette (`--chart-1` to `--chart-8`) as today.
- Bars: one series in `--chart-mono` at full strength, several series with the palette.
- These are defaults; field options from #33 override them.

## 9. Motion

- Hover reveals and pill changes: `--duration-fast` (120 ms), color and background only.
- Drag and resize: the panel follows the pointer through `transform` (not layout properties),
  the placeholder snaps to the grid; on release the panel moves to its cell, 180 ms. Reduced
  motion: no transition, the panel jumps.
- Dialogs, menus and the palette: fade and a 4 px rise, 120 ms; none for reduced motion.
- `styles.test.ts` keeps forbidding transitions on layout properties.

## 10. Performance: the editor lag, measured

Interaction timings come from the Event Timing API (durations include waiting for the next
frame, rounded to 8 ms), render attribution from React's profiling build with a commit hook,
main-thread time from Chrome traces.

| Interaction | 1x | 4x | Where the time goes |
|---|---|---|---|
| Typing in a panel's query (per key) | 16 ms p50, 24 ms p95; 7.6 ms of script | 24 ms p50, 40 ms p95, 64 ms max; 39 ms of script | Every key re-renders the whole editor: PanelEditor, the query editors, the options editor and the preview's chart shell, 40 renders each for 40 keys |
| Typing in the panel title (per key) | 16 ms p50; 4.2 ms of script | 24 ms p95; 27 ms of script | Same: the whole editor re-renders for one text field |
| Changing an option (per key) | 24 ms p50 | 48 ms p95 | Same, plus the preview redraws |
| Switching the visualization | 24 ms | 56 to 72 ms | Builds the new panel and drops the old chart |
| Opening the panel editor | 72 ms | 320 ms | Under 2 ms is React; the rest builds the CodeMirror view, a new uPlot chart and lays out the modal |
| Entering edit mode | 32 ms | 104 ms | All eight panel cards re-render because their props change |
| Dragging a panel (120 moves, 38 cell changes) | under 16 ms per move | 24 ms p50, one 83 ms long task | Each cell change re-renders the dashboard view and all eight panel cards (304 card renders) |
| Resizing a panel or the window | every step painted the chart one frame at its old size: 7 of 7 panel steps, 13 of 13 window steps | | ResizeObserver set state, React rendered in a later task, uPlot resized after paint |

Root causes:

1. **The panel editor keeps all of its state at the top.** `PanelEditor` holds title, type,
   options and targets in one `panel` object; each change makes a new object, and the preview
   receives `{ ...panel, targets: preview.targets }`, a new object on every key, so the compiler
   cannot skip the preview or the options editor. Nothing re-queries per key (the preview runs
   on Run or Ctrl+Enter), but every component in the dialog renders.
2. **Dashboard edits re-render every panel.** `onGrid` replaces the whole draft per cell change,
   `DashboardGrid` passes each card a new `query` object (`{ ...query, source }`), and the stored
   targets are compared by `JSON.stringify` per card per render.
3. **Drag and resize commit per cell and do not follow the pointer.** The panel moves only after
   the pointer crosses half a cell; there is no placeholder or ghost, so it feels sticky even when
   frames are fast.
4. **Charts painted stale geometry for a frame on every resize.** Fixed in the quick wins:
   `useElementSize` renders the new size with `flushSync` inside the ResizeObserver callback,
   which runs between layout and paint; the chart's resize effect then runs in the same frame.
   After the fix: 0 stale frames in both scenarios at 1x and 4x.
5. **The editor is a modal that rebuilds everything on open.** CodeMirror and uPlot instances are
   created per open; the dashboard behind stays mounted.

Fixes (phase 2, in the files the open PRs rewrite):

1. Split the editor state: `look` (title, type, options) and `targets` in separate state; the
   preview gets a memoized panel built from `look` and the last run targets; each target editor
   gets a stable `onChange` keyed by refId. Expected: typing re-renders only the target's editor
   (under 2 ms per key at 4x).
2. Keep the drag in the card: pointer moves update a CSS transform on the card and a placeholder
   cell (no React state per move); commit `onGrid` once on release. Pass cards a memoized `query`
   and compute `source` inside the card from a precomputed set of changed panel ids.
3. Draft changes through a reducer keyed by panel id, so unchanged panels keep their object
   identity and the compiler skips them.
4. Full-page editor (section 5) instead of a modal; keep the CodeMirror view per target alive
   while the editor is open; update uPlot with `setData` and `setSize` instead of rebuilding it
   when only data or size changes.
5. A performance budget test in e2e: typing 40 keys in the panel editor with 4x throttling must
   stay under 50 ms p95 Event Timing; dragging must not produce long tasks over 50 ms.

Done in P1-1a (`ui/e2e/budget.spec.ts`, best of three rounds, run last and alone): fixes 1 to 5,
plus what the measurements turned up on the way: The dashboard's range, the cards' query input,
the view actions and the annotation marks keep their identity while they stay the same (the
marks were new on every render, which drew every card again); a card's steps, options and field
options are memoized, so a moved panel hands its chart the same series and uPlot does not draw
again; the drag sets `translate` on the card, not a custom property, which would restyle the
whole card on every frame; the editor's panes use `contain: strict`. Measured on the same machine
with the same test, before and after: typing 40 keys at 4x, p95 40 to 48 ms (max 56) before and
40 ms (max 48) after, the longest task while typing 38 to 45 ms before and 27 to 30 ms after,
React's share of the main thread down by a third; dragging a panel at 4x, 2 to 3 long tasks of
56 to 78 ms per drag before, none after (the drop renders as a transition, in slices, and the
card keeps its offset until it stands in its new cell).

## 11. Data source logos

The owner decided to show the real vendor logos, in nominative use (to identify the data source,
next to its name, no endorsement implied), as other dashboard tools do. The marks come unchanged
from Simple Icons 16.35.0 (CC0), copied into `ui/src/assets/logos/` (no runtime dependency) and
bundled as inline SVG paths, so the content security policy stays strict. Each logo is drawn in
its brand color on a light tile in both schemes, because several marks are dark blue and would
vanish on dark; the contrast theme draws them in the text color. A kind for two products (MySQL
and MariaDB, Elasticsearch and OpenSearch) shows both marks. SQL Server, Memgraph and TigerGraph
have no file their owners allow to be copied, and file and HTTP JSON are no products: they keep
Kalzit's neutral glyph for their family of data. Logos are content: no brand color in any
selection, focus or current-state styling. `ui/src/assets/logos/NOTICE.md` records source,
version, license and guideline per logo; the README carries the trademark notice.

The registry (`ui/src/features/datasources/kindMarks.tsx`) already maps the kinds of the open
source PRs (#22 graph sources, #24 search and files), so they only add their one-line summaries.

Places: the kind picker (cards named by the product, described by the summary), the list rows and
the form header (done); the Explore source picker and the query editor header (phase 2, files
owned by #27, #29, #30).

## 12. Collisions with the open PRs

| PR | Files it rewrites that this plan touches | What to align in phase 2 |
|---|---|---|
| #28 ux/shell | `AppShell.tsx`, `HomePage.tsx`, new `shellUx.css`, `DataSourceForm.tsx` and `DataSourcesPage.tsx` (other hunks) | Start page after the reference (greeting, stat cards, recent and starred as cards); workspace switcher on top of the sidebar; the search button with a `/` keycap (it shows the palette's shortcut today); setup checklist card at the sidebar bottom; use the new radius and layer tokens in `shellUx.css` |
| #32 ux/dashboards | `DashboardGrid.tsx` (rewritten), `PanelCard.tsx`, `DashboardPage.tsx`, `PanelEditor.tsx` | Performance fixes 2 and 3; live drag and resize; panel menu instead of text buttons (its new links, annotate and view buttons sit in `.panel-card__actions`, so they already hide until hover); one-row toolbar; loading bar and error icon |
| #33 ux/visualizations | `PanelEditor.tsx`, `PanelCard.tsx`, `ChartShell.tsx`, `UplotTimeSeriesChart.tsx`, `series.ts`, `viz.css`, tokens | Monochrome defaults with hatch and dashed comparison; one display font size token; options pane on the right of the full-page editor; uPlot `setData` instead of rebuild |
| #27 m2/documents-ui | `PanelEditor.tsx`, `ExplorePage.tsx`, `PanelCard.tsx` | Performance fix 1 on top of its editor changes; Explore toolbar row and split view; kind mark in the source picker |
| #29 m3/graph-ui | `PanelCard.tsx`, `DashboardPage.tsx`, `QueryEditor.tsx`, `ExplorePage.tsx` | Kind mark in the query editor header; graph selection stays neutral (dim the rest) |
| #30 m1/analysis | `PanelEditor.tsx`, `PanelCard.tsx`, `ExplorePage.tsx` | Steps editor as a tab in the editor's lower pane |
| #22, #24 data sources | catalogs | Add `datasources.kinds.<kind>.summary` in both languages; the marks are already mapped |

## 13. Order of work

1. Quick wins (this PR): full-width canvases, graphite tokens and density tokens, soft radii,
   raised nav pill, quiet panel chrome, data source kind marks and picker cards, the stale-frame
   fix.
2. After #28, #32 and #33 are merged: the editor and drag performance fixes with the budget test,
   the full-page panel editor, panel menu, loading bar, toolbar row, monochrome charts, start page
   and sidebar after the reference.
3. After #27, #29 and #30: Explore layout, kind marks in the source pickers and editor headers.

## 14. Phase 2 targets from the review of the quick wins

- Page header as breadcrumbs plus quiet icon buttons with an overflow menu; Edit in view mode as a
  secondary button, not the copper primary (copper stays for Save and the one main action).
- Stat tiles as in the reference: small label, large number, a sparkline in a well behind a
  vertical hairline.
- Radii and spacing a little closer to the reference: cards 12 px, card padding 16 to 20 px,
  12 to 16 px gaps on the start page and lists (the dashboard grid stays at 8 px).
- Monochrome chart defaults: near-white or near-black main line, dashed grey comparison series,
  faint horizontal grid only.
- Sidebar: workspace switcher card, thin dividers between nav groups, keyboard hints (`/` for
  search, the palette shortcut) shown as keycaps.

## 15. Phase 2, part A: shell, start page and lists (done)

- Sidebar: workspace card on top (mark tile, organization name and role, up/down chevron) that
  opens the organization menu (settings, members, teams, all organizations for a server admin;
  a plain card for who has none of them); Search as a nav row with a `/` keycap, and `/` opens
  the palette anywhere but in a text field; thin dividers between the nav groups (start, data,
  administration; `NAV_SECTIONS` in `features/nav.ts`); nav rows 32 px at body size; tooltips
  name the shortcuts (Search: `/` or Ctrl+K, sidebar: Ctrl+B; Strg on German keyboards). The
  collapse toggle sits in the content header at the top left, before the breadcrumbs (which
  `Breadcrumbs` portals there), so the workspace card has the sidebar's full width; on phones,
  where the sidebar is a bar on top, there is nothing to collapse and no toggle.
- First-steps card at the bottom of the sidebar (on the start page where the sidebar is a bar on
  top): add a data source, create a dashboard, invite a colleague, each only for who may do it
  and checked from real data (search, member list); gone once all are done or when dismissed,
  remembered in the browser per account and organization (there is no server preference yet).
- Start page: a muted page name, the greeting, quick actions on the same row; stat tiles for
  dashboards, data sources, members and changes of the last seven days (audit log, counted per
  day in the user's time zone, with a sparkline), each a link, only what the user may see;
  starred and recently opened dashboards as cards with a thumbnail tile, title, folder, a star
  toggle and Edit.
- Tokens: `--radius-md` 7 px, `--radius-lg` 12 px, sidebar 240 px, `--space-card`,
  `--space-cards`, `--font-size-display` (30 px), stat, thumbnail, switcher and row sizes.
- Lists: tables are cards (hairline frame, sunken header row, 36 px rows, neutral hover tint);
  admin rows at least 36 px with the same tint; cards use the card padding and gaps.
- The stat tile's divider is the tile's border color showing through a 1 px gap, not a border on
  one side, so the guard against left bars holds.
