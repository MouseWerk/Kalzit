# Contributing to Kalzit

Thank you for helping. This file covers how changes reach `main`, the checks they must pass and
the rules the code follows. Start with [docs/PLAN.md](docs/PLAN.md) (what Kalzit becomes, in
German) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (how the code is shaped).

By taking part you agree to the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems go to
[SECURITY.md](SECURITY.md), never to a public issue.

## Before you start

- **Bugs:** open an issue with the bug report form, with steps to reproduce and your operating
  system.
- **Features:** open an issue with the feature request form first, so we can agree on the scope
  before you write code. Larger changes should fit the milestones in the plan.
- **Clean room:** Kalzit is an independent implementation. Do not copy code, texts, names or
  logos from other dashboard products.

## Workflow

1. Create a branch from `main`: `m<n>/<topic>` for milestone work (`m2/change-streams`),
   `fix/<topic>` for fixes, `feat/<topic>` for features outside a milestone, `ux/<topic>` for
   interface polish, `docs/<topic>` for documentation.
2. Make the change, with tests (a fix comes with a test that fails without it).
3. Run the checks below locally.
4. Add a release note fragment if users notice the change (see "Release notes" below).
5. Open a pull request into `main` and fill in the template.
6. Every pull request gets a review; its findings are resolved before the merge.
7. CI must be green on Windows and Linux. CI runs on the maintainer's machine
   ([`tools/local-ci`](tools/local-ci/README.md)), not on GitHub's runners: a maintainer tests
   the pull request merged onto the current `main` on Windows and on Linux (WSL), and the results
   appear on the pull request as the statuses `local/windows` and `local/linux`, which `main`
   requires. Expect a short wait between opening a pull request and its first status.
8. A maintainer merges. Pull requests are squash-merged, so the pull request title becomes the
   commit subject; write it as a plain English sentence that says what changes for the user
   ("Alerting: the rules list fits at 1024 px"). The branch is deleted after the merge.

`main` is protected: no direct pushes and no force pushes. Please do not force-push a branch
once its pull request has a review; add commits instead, they are squashed at the merge. The whole
process, from decision to release, is described in [docs/process.md](docs/process.md).

## Building

You need the current stable Rust toolchain, Node.js 26 or newer and Git; no C compiler, OpenSSL
or database server. The UI is built first, because the server embeds `ui/dist`:

```sh
cd ui
npm ci
npm run build
cd ..
cargo build --locked
```

For development, run the server with `cargo run` and the UI dev server with `npm run dev` in
`ui/`, which proxies the API to the server on port 3000. More in the README under
[Build](README.md#build) and in [ui/README.md](ui/README.md).

## Checks

From the repository root:

```sh
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```

From `ui/`:

```sh
npm ci
npm run check
npm run lint
npm run typecheck
npm test
npm run build
npm run e2e        # Playwright against the release binary
```

Data source tests run against real databases when `KALZIT_TEST_<SOURCE>_URL` is set (see
"Testing contracts" in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#testing-contracts)). Never
skip or weaken a test to make a change pass.

## Rules for the code

- Match the style and comment density of the surrounding code. No emojis anywhere.
- **Authorization** is checked on the server for every request and resource; the UI only hides
  what the server would refuse.
- **Native shapes:** query results stay `frame`, `documents`, `graph` or `trace`; conversions are
  explicit analysis steps, never implicit in the backend.
- **Read-only sources:** nothing may write to a data source; write queries are refused on the
  server.
- **Windows and Linux** are both first-class: paths, line endings and file permissions must work
  on both.
- **UI texts** go through the i18n catalogs in English and German (German uses "du"); the
  translation tests must pass, and terms follow [docs/glossary.md](docs/glossary.md).
- **Design:** use the design tokens, no one-off colors or sizes. Selected, active or current
  states use a quiet neutral tint and text weight, never accent-colored borders, outlines, glows
  or bars on the left. Focus is visible only on `:focus-visible`.
- Secrets never go into the repository, the configuration file or logs.

## Screenshots

A pull request that visibly changes the UI reruns `npm run screenshots` in `ui/` and commits the
changed images in `docs/screenshots/`; the user guide shows them. The README and the gallery of the
website show the gallery renders in `docs/screenshots/gallery/`, which come from the gallery
workflow; see `docs/screenshots/README.md`. Screenshots are desktop only, no phone captures.

## Release notes

A pull request with user-facing changes adds a fragment
`docs/releases/unreleased/<pr>-<topic>.md` (the number of the pull request and a short topic) with
the sections "## Improved", "## Fixed" and "## Checklist for Windows (manual)" as needed, written
for users, not developers; [docs/releases/unreleased/README.md](docs/releases/unreleased/README.md)
has the details. The release pull request assembles the fragments into
`docs/releases/v<version>.md`. Changes without a visible effect (refactoring, tests, internal
docs) need no fragment.

## Commits

Write commit messages and pull request titles in English, in plain sentences, without emojis.
Commits carry no tool or assistant trailers. Since pull requests are squash-merged, the history of
`main` shows one commit per pull request, under its title.

## License

Kalzit is licensed under the [AGPL-3.0](LICENSE). By contributing, you agree that your
contribution is licensed under the same terms.
