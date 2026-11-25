# Ultrawide audit: shell, Start page and cross-cutting text measure

Audit of 2026-11-24 on the comparison instance (`cae59d2e`), every finding checked against
`origin/main` at `b99aa491`; file:line references are on that commit.

| Id | Severity | Status |
|---|---|---|
| UW-S1 | minor | open |
| UW-S2 | minor | open |
| UW-S3 | minor | open |

Checked without findings:

- **Sidebar and main area.** The sidebar keeps 240 px by default (resizable from 192 to 384 px,
  `ui/src/shell/sidebarState.ts:12-13`); that is 9 % of the window at 2560 and 5 % at 5120,
  which is right for navigation: it does not need to grow. The top bar spans the main area at
  every width, search and the help button stay at its right end, the breadcrumb at its left; the
  sticky header and sidebar keep their size while scrolling; no horizontal scroll at any width.
- **Menus and overlays.** The user menu opens upwards from the sidebar's foot and stays inside
  the window; the command palette is centred with a fixed width; dialogs are centred in the
  window (not the main area; the 120 px difference is not visible at these widths).
- **HiDPI.** At 1920 x 1080 with DPR 2 (a 3840 x 2160 monitor at 200 %) text, icons, the Start
  illustrations (SVG) and the data source logos are sharp; no raster image is loaded at the wrong
  resolution, and canvases use the device pixel ratio.

## UW-S1 Start page: tiles, empty states and lists stretch to 3 500-4 800 px

- **Where:** `ui/src/shell/shellUx.css:1358-1381` (`.start__stats`: four `1fr` columns, no
  maximum), the sections of `ui/src/pages/HomePage.tsx` (each a full-width card), the stat tile
  `shellUx.css:1404-1470` (text left, illustration well right).
- **Width/theme:** from 3440; both themes. Measured at 3840 / 5120: a stat tile is 879 / 1 199
  px wide and its number stands 757 / 1 077 px left of its illustration; "Favorites" (empty),
  "Recently opened" (one card of 250 px) and "Recently changed" are 3 552 / 4 832 px wide;
  "Source status" is 1 770 / 2 410 px, with each source's latency right-aligned at the far end of
  its row.
- **Reproduce:** sign in and open Start at 3840 x 1600 or 5120 x 1440.
- **Expected / actual:** Start is an overview to take in at a glance; the number and its picture
  belong together, and an empty state ("Star a dashboard on its page to find it here.") stays
  near where the content will appear. Actually the tiles read as a number with a lone picture far
  away, the empty states are one short line in a 4 800 px bar, and the page uses the top third
  of the screen.
- **Screenshot:** `shots/shell-start-5120-light.png`, `shots/shell-start-3840-dark.png`.
- **Root cause (confirmed):** every block takes the full content width; nothing on Start has a
  maximum width or more columns on wide screens.
- **Fix:** cap Start at a wide measure (a new token, e.g. `--size-start-max: 120rem`, left-aligned
  like the other pages) and above it place the lists side by side (`grid-template-columns:
  repeat(auto-fit, minmax(36rem, 1fr))` for Favorites / Recently opened / Recently changed /
  Source status / Hints); cap the stat tile's width (or let the well follow the number:
  `justify-content: start` with a max tile width).
- **Test:** e2e at 5120: no Start section is wider than the cap; the distance from a tile's
  number to its well is under 40rem.

## UW-S2 Toasts appear bottom-centre of the window, far from the action

- **Where:** `ui/src/shell/shellUx.css:4-13` (`.toaster { position: fixed; inset-block-end:
  var(--space-4); inset-inline: var(--space-4); justify-items: center }`).
- **Width/theme:** 3440 and up; both themes.
- **Reproduce:** on a dashboard at 5120 x 1440 press `t` `c` (copy the time range; on plain HTTP
  the toast reports that the clipboard is unavailable). The 512 px toast appears at x = 2 243,
  y = 1 369, i.e. bottom centre, while the time picker that caused it is at the top right
  of the window.
- **Expected / actual:** a confirmation appears where the eye is or at a fixed, predictable
  corner. On a 32:9 screen bottom centre is 2 500 px from the toolbar and below the eye line;
  short toasts are easily missed before they time out.
- **Screenshot:** `shots/shell-toast-5120-light.png`.
- **Root cause (confirmed):** the toaster is centred on the window at every width.
- **Fix:** above a wide breakpoint (e.g. `min-width: 120rem`), anchor the toaster to the bottom
  end of the main area (`justify-items: end`, `inset-inline-start: var(--sidebar-width)`), or
  centre it on the main area with a maximum distance; keep the centred layout below.
- **Test:** e2e at 5120: a toast's right edge is within the main area's right `--space-4`.

## UW-S3 No measure token: hints, leads and descriptions run to 100-250 characters per line

- **Where:** across areas; the reading width token `ui/src/styles/tokens.css:166-169`
  (`--content-max-width: 72rem`) is a layout width, not a text measure, and is used for text:
  `.page__lead` (`ui/src/styles/components.css:1182-1185`, 72rem); unbounded: `.field__hint`
  (`components.css:495-498`), `.alert-hint` (`ui/src/features/alerting/alerting.css:52-60`),
  `.usage-muted` (`ui/src/features/usage/usage.css:23-27`), `.settings-row__description`
  (`ui/src/features/settings/settings.css:333-336`); rem-capped but still long:
  `.admin-section__lead` (`ui/src/features/admin/admin.css:86-90`, 44rem at the small size), the
  help column (`auth.css:214-216`, 47.5rem).
- **Width/theme:** the unbounded ones grow with the window (2560 and up), the capped ones are long
  at every width; both themes. Measured characters per line at 3840 (unchanged or longer at
  5120): Explore and panel editor hint 182-251, alert policy hint 188, alerting empty state text
  179, rule editor hints 140-171, usage note 134, e-mail setting description 139, page leads on
  alerting 121-125, help pages 106-118, admin and settings leads 93-121.
- **Reproduce:** any of the pages above at 3840; the sweep's text-measure probe (see
  [README.md](README.md)) lists them.
- **Expected / actual:** running text at about 45-80 characters per line (the brief's limit,
  and the common reading guideline). Actually up to three times that.
- **Screenshot:** `shots/explore-hints-3840-light.png`,
  `shots/admin-alert-rule-editor-3840-light.png` (hints under the fields).
- **Root cause (confirmed):** no `ch`-based measure exists; text containers inherit the width of
  their layout box or a rem cap meant for forms.
- **Fix:** add `--measure: 70ch` (and `--measure-wide: 90ch` for tables of facts) to
  `tokens.css`; apply `max-inline-size: var(--measure)` to `.page__lead`, `.field__hint`,
  `.alert-hint`, `.alert-muted`, `.usage-muted`, `.settings-row__description`,
  `.admin-section__lead`, empty-state texts and the help body; `ch` follows each element's font
  size, so the small hints get the same measure as body text. Add the measure check to the UI
  sweep (`docs/quality/ui-pass-2026-11.md`).
- **Test:** a sweep rule: no visible text block with more than 90 characters per line at 3840.
