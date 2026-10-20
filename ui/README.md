# Kalzit UI

The web interface of Kalzit: React 19 with the React Compiler, TypeScript, Vite, TanStack Router
and TanStack Query. No CSS framework, no component library, no web fonts. The production build in
`dist/` is embedded in the server binary and served from the same origin as the API.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload; proxies `/api`, `/healthz` and `/readyz` to the server on `http://127.0.0.1:3000` |
| `npm run build` | Typecheck, then production build to `dist/` |
| `npm run typecheck` | TypeScript, strict |
| `npm run lint` | Biome lint, warnings fail |
| `npm run format` | Biome format, writes changes |
| `npm run format:check` | Biome format, checks only |
| `npm run check` | Biome lint, format and import order together |
| `npm test` | Vitest: unit, component and guard tests |

Node 26 or newer. Start the server first (it listens on port 3000), then `npm run dev`. On a fresh data folder the UI
opens the setup page; the setup code is in `setup-token.txt` in the server's data folder.

## Structure

```
index.html            No inline script or style (CSP script-src 'self'; style-src 'self')
public/theme-boot.js  Applies the stored theme before the first paint
src/
  main.tsx            Entry
  app/                Query client, router, base routes and the sign-in guard (_app)
  api/client.ts       The only HTTP client; maps every failure to ApiError with a code
  api/auth.ts         Setup, sign in, sign out, current user; response shape checks
  api/orgs.ts         The current organization with its permissions
  auth/               Setup and sign-in pages, validation, safe redirect after sign in
  features/<area>/    One folder per area: routes.tsx, nav.ts (its navigation entry), pages
  features/nav.ts     The navigation entries of all areas, in display order
  org/                Current organization and useOrgPermissions() for hiding actions
  shell/              App shell: sidebar, account menu, theme and language choice
  pages/              Home, not found, error page
  components/         Small shared pieces: text field, form alert, empty state, icons
  i18n/               <lang>/core.json and <lang>/<area>.json, combined in catalogs.ts
  theme/              Theme store: system, light, dark, high contrast
  lib/                Escape layer stack, preference storage, document title
  styles/             tokens.css (all colors, weights, radii, layers), layered stylesheets
  test/               Test helpers: fake server, console guard, CSS reader, contrast math
```

## Rules the tests enforce

- Each area's catalog holds only keys starting with `<area>.`, no key sits in two files, and
  German and English files match key for key.
- Every page except setup and sign-in hangs under the `_app` sign-in guard route.
- Both catalogs have the same keys and placeholders, no emoji, no space before an ellipsis, no
  leftovers of the other language; German uses „du“ and „…“ quotes; words listed under „Nicht
  verwenden / Avoid“ in `docs/glossary.md` appear nowhere.
- The design rules below cover every stylesheet under `src`, area styles included (in the
  components layer).
- Literal colors, font weights, z-index layers and radii only in `tokens.css`; spacing and font
  sizes from tokens; no accent or status colored frames on hover, focus, selected or current
  states; no colored bars on the left; focus ring only from `--focus-outline` on `:focus-visible`;
  AA contrast for every token pair in every theme.
- Network access only through `src/api/client.ts`; no inline script, style or handlers in
  `index.html`.
- Any console warning or error during a test fails it, unless the test declares it as expected.

## Expected browser console entry

Signed out, the sign-in page asks `GET /api/me` whether a session exists. The server answers 401
`unauthenticated`, and browsers log that as "Failed to load resource" however the app handles it.
This one request is expected; end-to-end tests allow-list exactly it. While setup is still
needed, the UI asks only `GET /api/setup` and never calls `/api/me`, so the setup page loads
without that entry.
