/**
 * Links to the documentation in the repository. They point at the release this build belongs to
 * (the tag `v<version>`, with the version from server/Cargo.toml, set in vite.config.ts), not at
 * `main`: the guide on `main` may already describe what the next release changes.
 */
declare const __KALZIT_VERSION__: string;

export const REPOSITORY_URL = "https://github.com/MouseWerk/Kalzit";

/** The git tag of the release this build belongs to. */
export const DOCS_REF = `v${__KALZIT_VERSION__}`;

/** The repository's files as of that release; relative paths resolve against it. */
export const DOCS_BASE_URL = `${REPOSITORY_URL}/blob/${DOCS_REF}/`;

/** The docs folder of that release. */
export const DOCS_URL = `${REPOSITORY_URL}/tree/${DOCS_REF}/docs`;

/** The user guide of that release. */
export const GUIDE_URL = `${DOCS_BASE_URL}docs/guide/`;
