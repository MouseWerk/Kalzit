# Ultrawide audit: pages before the app (sign-in, setup, links, help, public pages)

Audit of 2026-11-24 on the comparison instance (`http://localhost:3310`, built from `cae59d2e`),
every finding checked against `origin/main` at `b99aa491`; file:line references are on that
commit. Widths, themes and method are in [README.md](README.md).

| Id | Severity | Status |
|---|---|---|
| UW-A1 | major | open |
| UW-A2 | minor | open (owner decision: the 1536 px sheet is in the blueprint) |
| UW-A3 | minor | open |
| UW-A4 | polish | open |

Checked without findings: the sign-in form itself (one 400 px column, readable at every width),
setup ("already set up"), invitation, password reset (request and link), registration, e-mail
confirmation, and the public pages "Dieser Link ist nicht verfügbar." (dashboards and snapshots):
the message stays a small centred block at every width and in both themes, which is right for a
page with one sentence. No horizontal scroll at any width.

## UW-A1 Help pages: the backdrop's light and grid are painted over the text

- **Where:** `/help/getting-started`, `/help/installation` (the built-in handbook before sign-in).
  `ui/src/auth/AccessLayout.tsx:181` (`<main className="access__column ...">`) and `:190`
  (`<Backdrop />` after it); `ui/src/auth/auth.css:201-203` (`.access__column { position:
  relative }`), `:1188-1194` (`.access-bd { position: absolute; inset: 0 }`, no `z-index`).
- **Width/theme:** every width the help page has (it never uses the split layout), so 1920 at
  DPR 2, 2560, 3440, 3840 and 5120; clearly visible in light, faint in dark.
- **Reproduce:** open `/help/getting-started` in the light theme, look at the heading "Erste
  Schritte", the tabs and the first paragraph.
- **Expected / actual:** the backdrop lies behind the page. Actually the drifting light
  (`.access-bd__lamp`, 45rem, `oklch(100% 0 0 / 0.8)` in light) washes the heading, the tabs and
  the first lines out to a pale grey, and the grid lines cross the text. The light drifts, so the
  washed-out spot moves over the text while one reads.
- **Screenshot:** `shots/auth-help-backdrop-over-text-3840-light.png` (1:1 crop),
  `shots/auth-help-backdrop-over-text-1920-dpr2-light.png` (crop at 1920 x 1080, DPR 2).
- **Root cause (confirmed):** `.access__column` and `.access-bd` are both positioned with
  `z-index: auto` inside the isolated `.access`; positioned boxes paint in DOM order, and the
  panel with the backdrop comes after `<main>`. In the split layout the backdrop sits inside its
  own panel, so sign-in on wide screens is not affected; the non-split layout is: the help pages
  at every width, and every sign-in page between 640 and 1024 px (checked at 900 px: the heading
  "Anmelden" is washed out and the crystal's lines cross the input fields; below 640 px the
  light is off; the grid has the same stacking, so it likely lies on top there too, not checked).
- **Fix:** `.access-bd { z-index: -1; }` (`.access` already has `isolation: isolate`, so the
  backdrop stays above the page background), or render `<Backdrop />` before `<main>`.
- **Test:** an e2e check on `/help/getting-started` and on `/login` at 900 px that samples the
  h1's pixels in a screenshot and finds the text colour (`--text`) unchanged, with reduced motion
  so the light stands still; `elementsFromPoint` cannot see the backdrop (it has
  `pointer-events: none`).

## UW-A2 Sign-in: the sheet stops at 1536 px and the backdrop panel ends with a hard edge

- **Where:** `/login`, `/setup`, `/invite`, `/reset-password`, `/register`, `/confirm-email`
  (all split pages). `ui/src/auth/auth.css:1297-1306` (`.access--split { max-width:
  var(--size-access-split); margin-inline: auto }`), `:1318-1332` (`.access--split
  .access__panel`: hairline border, radius, `background: var(--bg-surface)`),
  `ui/src/styles/tokens.css:802` (`--size-access-split: 96rem`).
- **Width/theme:** from about 1600 px; at 3440 the sheet is a 1536 px box with 952 px of flat
  page on each side and the panel ends at x = 2476; at 3840 at x = 2 676; at 5120 1792 px stay
  empty on each side. Both themes; in dark the panel is darker than the page, so the edge reads
  as a cut.
- **Reproduce:** open `/login` at 3440 x 1440 or wider.
- **Expected / actual:** the blueprint (README "Layout of the pages before the app", Access board:
  "Das Blatt aus Formular und Fläche wächst bis 1536 px und steht darüber mittig") asks for
  exactly this cap, so the code matches the board. On ultrawide screens the result looks like a
  phone-sized card floating in a void: the grid, the crystal and the light end at a framed edge
  in the middle of the screen, the form sits about a quarter in from the left, and two thirds of
  the window are flat background.
- **Screenshot:** `shots/auth-login-3440-light.png`, `shots/auth-login-5120-dark.png`.
- **Root cause (confirmed):** the panel and its backdrop live inside the capped sheet; nothing
  outside the sheet carries the backdrop.
- **Fix (owner decision, recommended first):**
  1. Keep the 1536 px measure for the form and the panel's text, but let the panel's surface and
     backdrop bleed to the right window edge above 1536 px (panel `margin-inline-end: calc((100vw
     - var(--size-access-split)) / -2)` or a full-bleed `::before` on `.access`), so the page
     reads as "form on the left, calm surface on the right" at any width. Update the Access board.
  2. Raise the cap with the window (`--size-access-split: clamp(96rem, 60vw, 140rem)`) and keep
     the frame; smaller change, still a framed edge at 5120.
- **Test:** a screenshot assertion at 3440 and 5120 that the panel's right edge is the window
  edge (option 1) or within the cap (option 2).

## UW-A3 Help pages: the top bar spans the window while the text is a centred column

- **Where:** `/help/getting-started`, `/help/installation`. `ui/src/auth/auth.css:54-62`
  (`.access__top`, full width in the non-split layout) against `:214-216`
  (`.access__column--done`, `max-width: calc(47.5rem + 2rem)`, centred).
- **Width/theme:** visible from 2560, strong at 3840 and 5120; both themes.
- **Reproduce:** open `/help/getting-started` at 3840 x 1600.
- **Expected / actual:** the mark and the language/theme/help tools frame the text column, as on
  the sign-in sheet, where mark, form and fine print share one left edge (blueprint README). At
  3840 the mark "Kalzit" sits at x = 24 and the tools at the right window edge, 1 400 px left and
  right of a 760 px text column; at 5120 about 2 000 px.
- **Screenshot:** `shots/auth-help-3840-dark.png`.
- **Root cause (confirmed):** only `.access--split` places the top bar on the sheet's grid; the
  `done` width keeps the bar at window width.
- **Fix:** give `.access:not(.access--split) .access__top` the column's measure
  (`max-width: calc(var(--size-access-column-done) + var(--space-8)); margin-inline: auto;
  width: 100%`), or a wider help measure shared by bar and text.
- **Test:** e2e at 3840: the left edge of `.access__brand` equals the left edge of the text column
  within 1 px.

## UW-A4 Backdrop light shows rings (banding) on large dark panels

- **Where:** `ui/src/auth/auth.css:1237-1247` (`.access-bd__lamp`, `radial-gradient(closest-side,
  ...)` mask over a flat `--access-lamp`), `ui/src/styles/tokens.css:831` (`--access-lamp:
  light-dark(oklch(100% 0 0 / 0.8), oklch(100% 0 0 / 0.055))`).
- **Width/theme:** dark theme, every width; noticeable on large, bright monitors because the
  lamp is 720 px wide and the panel is tall.
- **Reproduce:** `/login` in dark at 3840 x 1600; look at the top-left of the panel. Measured
  luminance along the lamp's radius goes 21, 20, 19, 18, 17, 16, 15 (8-bit): six steps over
  360 px, so each ring is about 50 px wide.
- **Expected / actual:** a soft, even glow. Actually concentric rings, faint but visible on a good
  panel (the autocontrast crop makes them obvious).
- **Screenshot:** `shots/auth-lamp-banding-3840-dark.png` (1:1),
  `shots/auth-lamp-banding-3840-dark-autocontrast.png` (same crop, contrast stretched).
- **Root cause (suspected):** a 5.5 % white over a near-black background leaves only six 8-bit
  levels for the whole gradient; no dither.
- **Fix:** add a tiny noise layer to the lamp (an inline SVG `feTurbulence` as `mask-image` or
  background at 2-3 % opacity), or give the gradient more stops with an ease-out curve so the
  steps fall where they are least visible. Keep it CSS-only as the motion rules require.
- **Test:** none automatic; a reviewer checks the 1:1 crop in dark.
