# Kalzit devgen

Generators and checks that speed up writing code for Kalzit: free migration numbers, release
note lines in the right file, i18n keys in both languages, route and setting scaffolds that pass
the repository's checks out of the box, overlap between open pull requests, the binding rules as
a checklist and a lint, and cleanup of agent worktrees and cargo target directories.

One code base, two front ends: an MCP server over stdio (registered as `kalzit-devgen` in the
repository's `.mcp.json`) and a CLI with the same tools as subcommands. Instances, screenshots,
visual diffs, UI checks, CI and merge helpers are in `tools/devkit`, not here.

devgen is for development only. It is never part of the product binary, the packages or the
container image, and it holds no secrets: GitHub access goes through the `gh` CLI's own login.

## Setup

```
cd tools/devgen
npm ci
node src/cli.ts --help
```

Node 26 runs the TypeScript sources directly; there is no build step. `git` and `gh` must be on
the `PATH`; without `gh` (or offline) the tools say so and work with main and the checkout only.
The tools find the repository from their own location; `KALZIT_REPO` points them elsewhere.

The MCP server starts with `node tools/devgen/src/mcp.ts` from the repository root, which is
what `.mcp.json` does. Every call reads git and GitHub afresh, so open pull requests are current.

## Tools

CLI flags are the tool's fields in kebab case (`reasonEn` is `--reason-en`); lists take commas or
repeated flags; `--json` prints the data instead of the text; `<command> --help` lists the flags.
Commands that find errors exit with 2.

| Tool (MCP)         | CLI                | What it does                                                                                                                                        |
| ------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `next_migration`   | `next-migration`   | next free `server/migrations` number over main, this checkout and every open PR; `--create` writes the file with a header                           |
| `check_migrations` | `check-migrations` | clashes of a branch's new migrations with main, open PRs and each other, and numbers below main's newest                                            |
| `release_note`     | `release-note`     | adds a line under Improved, Fixed or the Windows checklist of the unreleased notes file; creates it; warns when another open PR creates it too      |
| `i18n_add`         | `i18n-add`         | adds a key in German and English next to its siblings; `--en-one`/`--de-one` make it a `One`/`Many` plural                                          |
| `i18n_check`       | `i18n-check`       | the translation tests' checks before CI, plus keys the code names without an entry and keys that look unused                                        |
| `scaffold_route`   | `scaffold-route`   | route table entry, handler with an explicit authorization check, reason and error code, docs section, Reasons row, UI texts and an integration test |
| `scaffold_setting` | `scaffold-setting` | registry entry and rule, generated `SettingKey`, de/en texts, section row, search words, docs row, server and UI tests                              |
| `pr_overlap`       | `pr-overlap`       | files open PRs share, with a hint at likely conflicts, and migration numbers taken twice                                                            |
| `rules`            | `rules`            | the binding rules of CLAUDE.md and the owner decisions as a checklist                                                                               |
| `rules_lint`       | `rules-lint`       | lints this branch's diff, commits and PR body for common violations                                                                                 |
| `cleanup_storage`  | `cleanup-storage`  | lists merged worktrees and cargo target dirs with sizes; `--apply` removes what is safe                                                             |

### Examples

```
# The next free migration, and the file with its header.
node src/cli.ts next-migration --create --name sort_keys --description "Language-aware sort keys."
# -> Next free migration: 0036 / Created server/migrations/0036_sort_keys.sql

# Does this branch clash with main or an open PR?
node src/cli.ts check-migrations --branch m6/collation

# A line in the right notes file (v0.6.0 once v0.5.0 has a tag, release or release PR).
node src/cli.ts release-note --section fixed --text "Sorting by name follows the language."

# One key, both languages, next to its siblings in admin.json.
node src/cli.ts i18n-add --key admin.users.lastSeen --en "Last seen {when}" --de "Zuletzt gesehen {when}"

# The translation checks, with the list of keys that look unused.
node src/cli.ts i18n-check --show-unused

# A route for editors in a new module, with a reason the UI translates.
node src/cli.ts scaffold-route --module widgets --method POST --path "/orgs/{orgId}/widgets" \
  --access dashboards:write --handler create_widget --summary "Creates a widget" \
  --docs dashboard-features.md --reason widgets.name_missing --reason-docs datasources.md \
  --reason-en "Enter a name." --reason-de "Gib einen Namen ein."

# A server setting in the storage section.
node src/cli.ts scaffold-setting --key audit.export_days --scope server --type int --default 30 \
  --min 1 --max 3650 --description "Days exports are kept." --label-en "Exports kept" \
  --label-de "Aufbewahrung der Exporte" --description-en "Days before exports are deleted." \
  --description-de "Tage, bis Exporte gelöscht werden." --section storage

# Which open PRs touch the same files as this branch?
node src/cli.ts pr-overlap --branch feat/dev-generators

# The checklist, then the lint over this branch and the PR body draft.
node src/cli.ts rules
node src/cli.ts rules-lint --pr-body-file pr-body.md

# What could go, then remove it.
node src/cli.ts cleanup-storage
node src/cli.ts cleanup-storage --apply
```

## How the tools decide

- **Migration numbers** count `origin/main` (run `git fetch` first), the checkout's
  `server/migrations` and the changed files of every open pull request (`gh pr list`), excluding
  the pull request of the current branch, whose files the checkout already has.
- **The unreleased notes file** is the newest `docs/releases/v<version>.md` whose version has no
  git tag, no GitHub release and no release pull request (`release/v<version>`, open or merged).
  When it is released, the next minor version's file is created with the three sections.
- **i18n rules** come from `ui/src/i18n/i18n.test.ts` where the test writes them as data (the Sie
  pattern, the German and English word lists, the names allowed in both languages) and from the
  Avoid column of `docs/glossary.md`, so the test stays the one definition. "Unused" counts
  literals, template heads (`` `settings.density.${v}` ``), prefixes ending in a dot and plural
  bases; it is a hint, the UI builds some keys at runtime.
- **Route scaffolds** follow `routes::access_guard`: `ServerAdmin` under `/admin`, organization
  routes under `/orgs/{orgId}`, session-only and public routes added to their lists. A reason
  goes into the Reasons table of a docs file the reasons check reads (`datasources.md`,
  `plugins.md`, `mail.md`, `sso.md`, `ai.md`, `access.md`, `scim.md`), its namespace into
  `NAMESPACES`, and its UI texts into the catalog the UI test reads. A new error code goes into
  `ERROR_CODES`, the generated `ErrorCode`, `SERVER_ERROR_CODE_SET` and `errors.<code>`. The
  test's forbidden case uses the weakest built-in role that lacks the permission, read from
  `authz.rs`. Touched files are formatted with rustfmt and the UI's Biome.
- **Setting scaffolds** refuse the areas of forms with dependent fields (mail, SSO, OIDC, LDAP,
  SAML, SCIM): those use one explicit Save after a connection test with a check token. Every other
  setting gets the shared `SettingRow`, which brings the source badge, the lock for values from
  `kalzit.toml` or the environment, and undo through `useSettingChanges`; the search index is
  built from the section and the texts. A key whose area is a reasons namespace is listed in
  `NOT_REASONS`.
- **Overlap hints** mark files where both sides usually edit the same lines (migrations, notes,
  catalogs, generated types, lock files, route and setting registries) as likely conflicts.
- **The lint** reads `git diff origin/main...HEAD` and `git log origin/main..HEAD`: literal colors,
  spacing, font sizes, weights, radii and z-indexes outside `tokens.css`; accent or status frames
  on states and left bars; `:focus` without `-visible`; JSX text and labels outside `t(...)`;
  emojis; lines in released notes; a "Generated with" line, trailers or assistant names in the PR
  body or commits; and commits not authored as the owner.
- **Cleanup** never touches the main checkout, the checkout it runs in, a worktree with
  uncommitted changes or one whose branch is not merged. Merged means the head commit is in
  `origin/main`, or a merged pull request's head is exactly that commit (squash merges). Target
  directories (`<home>/kalzit-target-*`) count as idle after two hours without a build.

## Proof

`npm run proof` scaffolds four routes (new module with a reason, new error code, an existing
module, a session-only route) and three settings (whole number, choice in a reasons namespace,
organization bool) into a temporary git worktree, then runs `cargo fmt --check`,
`cargo clippy --all-targets -D warnings`, the generated and affected server tests, Biome, the UI
typecheck and the affected UI tests. CI runs it in place (`--in-place`) in the job `devgen proof`.
Locally, keep the load low:

```
CARGO_BUILD_JOBS=2 CARGO_TARGET_DIR=C:/Users/klein/kalzit-target-devgen npm run proof
cargo clean --target-dir C:/Users/klein/kalzit-target-devgen
```

`--skip-cargo` and `--skip-ui` run one half; `--keep` leaves the worktree for a look.

## Development

```
npm run check       # Biome
npm run typecheck   # TypeScript 7
npm test            # Vitest
```
