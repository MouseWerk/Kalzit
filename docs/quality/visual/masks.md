# Visual comparison: masked areas

Every mask in `ui/e2e/visual/screens.ts` is a hole in the comparison. Each one is listed here with
its cause and how to remove it.

| Id | Where | Severity | What | Proposed fix | Status |
|---|---|---|---|---|---|
| VIS-1 | `ui/e2e/visual/screens.ts`, screen "cors in use" | Low | `.shell__sidebar` and `.settings-nav` are masked in both themes at every width, because about every second run showed a sub-pixel difference there at 1280 px (scrolled and not scrolled; the section next to it was identical). A real regression of the sidebar or the settings navigation on this one page goes unseen; every other screen compares both unmasked. | Find the non-determinism (likely the sticky position or the scroll settle "40 px short of the end" on this page), then unmask; if only one sticky element shifts, mask only that one. | Not fixed: accepted with #444 (owner rule: tracked here), to be fixed in the UI pass after the open PRs. |
