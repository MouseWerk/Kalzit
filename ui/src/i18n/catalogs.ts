// One catalog file per area and language, so work on different areas does not touch the same
// file. Keys are prefixed with their area (`admin.users.title`); the parity and guard tests run
// over the combined catalogs. Each language is its own module (en.ts, de.ts) and its own chunk:
// the app loads them through i18n.ts, one at a time; this module with both is for the tests.
export { de } from "./de";
export { en } from "./en";
