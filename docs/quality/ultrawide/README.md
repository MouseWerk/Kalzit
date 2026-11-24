# Ultrawide and large monitors: audit 2026-11-24

How Kalzit looks on 1440p, 21:9, 32:9 and HiDPI 4K screens. An audit only: nothing is fixed
here; fixes follow as their own pull requests, and each finding is then marked fixed (with the
commit) or not fixed (with the reason or the release it moves to).

| File | Area | Findings |
|---|---|---|
| [auth.md](auth.md) | sign-in, setup, mailed links, help (handbook), public share pages | UW-A1 to UW-A4 |
| [shell.md](shell.md) | sidebar, top bar, Start, toasts, menus; the text measure across areas | UW-S1 to UW-S3 |
| [dashboards.md](dashboards.md) | dashboard view, edit mode, panel editor, panels and charts | UW-D1 to UW-D4 |
| [explore.md](explore.md) | Explore with results | UW-E1, UW-E2 |
| [admin.md](admin.md) | data sources, alerting, reports, Verwaltung, settings | UW-M1 to UW-M4 |

## Summary

17 findings: 0 blocker, 3 major, 11 minor, 3 polish. No horizontal scrolling, clipped controls or
blurred canvases at any width.

Top 10, in the order we recommend fixing them:

1. **UW-A1** (major) Help pages: the sign-in backdrop's light and grid are painted over the text;
   all widths, worst in light.
2. **UW-D1** (major) Time axes drop the date once the chart is wide enough for sub-day ticks: a
   7-day panel reads "12:00 AM, 12:00 PM, ..." from 2560 (Explore) or 3840 (dashboards) up.
3. **UW-M1** (major) Alert rule and report editors stretch every field over the window (inputs
   up to 4 400 px at 5120).
4. **UW-E1** (minor) Explore's result is a fixed 24rem high; half of a 1600 px screen stays empty.
5. **UW-S1** (minor) Start: stat tiles, empty states and lists stretch to 3 500-4 800 px.
6. **UW-S3** (minor) No text measure: hints, leads and descriptions run to 100-250 characters per
   line.
7. **UW-D3** (minor) Table panels spread four columns over 3 500 px.
8. **UW-A2** (minor) Sign-in sheet capped at 1536 px, backdrop panel ends with a
   hard edge in the middle of a 21:9 or 32:9 screen.
9. **UW-M2** (minor) Add data source: kind descriptions cut off while an empty placeholder takes
   47 % of the width.
10. **UW-E2** (minor) Explore hints and "Start here" stretch across the whole editor width.

Owner decisions (2026-11-24), recorded in the findings:

- **UW-A2:** the sign-in background fills the full screen width on every monitor; the form
  column stays as narrow as it is now.
- **UW-D2:** keep the fixed row height, like Grafana; only the axes and tables that break are
  fixed (UW-D1, UW-D3). UW-D2 itself is not fixed.
- **UW-M3:** lists stop at the content width token (`--content-max-width`, 72rem).
- **UW-M4:** reading-width pages are centred in the main area on wide screens.

## Method

- **Instance:** the comparison instance at `http://localhost:3310`, built from `main` at
  `cae59d2e`, org "Shop", signed in as its admin. Every finding was checked against the code of
  `origin/main` at `b99aa491`; file:line references are on that commit. Where `main` changed a
  file since `cae59d2e` (panels, dashboard page, shell), the finding was re-read in the new code.
- **Widths:** 2560 x 1440, 3440 x 1440 (21:9), 3840 x 1600, 5120 x 1440 (32:9), each at DPR 1,
  and 3840 x 2160 at 200 % scaling, i.e. a 1920 x 1080 CSS viewport at DPR 2 (HiDPI). Every page
  in light and dark (`kalzit.theme` plus `prefers-color-scheme`), 49 pages and states per width
  and theme, 490 screenshots in all (Chromium from Playwright 1.64).
- **Pages:** sign-in, setup, invitation, password reset (request and link), registration,
  e-mail confirmation, public dashboard and snapshot links ("Dieser Link ist nicht verfügbar."),
  the handbook (`/help/getting-started`, `/help/installation`, before sign-in and inside the
  app); Start, the dashboard list, "Shop operations" in view and edit mode, the panel editor, the
  "New dashboard" dialog, a chart tooltip, Explore empty and with results (SQL table, Prometheus
  series), data sources (list, detail, add), Verwaltung (overview, members, roles, audit, usage,
  users, organizations, instances, shares), settings (general, appearance, e-mail, profile),
  alerting (rules, new rule, contact points, policies, history), reports (list, new report),
  the command palette, the user menu and a toast.
- **Probes:** per page the script recorded horizontal overflow, the main area's and content's
  extent, every text block over 90 characters with its characters per line, canvas backing size
  against CSS size, image natural size against shown size, open dialogs, menus and tooltips, and
  sticky or fixed bars with their extent. Measurements quoted in the findings come from targeted
  DOM probes (`getBoundingClientRect`) on the running instance.
- **Data:** the instance's sources (PostgreSQL, Prometheus, Loki in WSL Docker) were not
  reachable during the audit, and WSL did not answer while a local CI run held the lock, so they
  were not started. Query answers were faked in the browser only (Playwright `route` on the
  panel and Explore query endpoints, three series over the range, a 200-row orders table);
  nothing was written to the instance. Layout, axes, ticks, tables and canvases are the real
  code; values (e.g. gauge percentages) are not meaningful. Not covered for lack of data: graph
  canvases (Sigma/WebGL) and trace waterfalls, alert rule and report lists with entries.
- **Reference:** `docs/design/blueprint/` (Access, Auth, Start, Explore, Alerting, Reports boards
  and the README's layout notes) and the tokens in `ui/src/styles/tokens.css`, in particular the
  comment on `--content-max-width` ("Reading width, for forms, settings and running text only.
  Dashboards, Explore and lists use the whole width of the window.").

Screenshots are in `shots/` (PNG, wide pages scaled to 1920 or 2560 px wide, details as 1:1
crops).
