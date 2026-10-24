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
4. Open a pull request into `main` and fill in the template.
5. CI must be green on Windows and Linux, and review findings must be resolved. Pull requests
   are squash-merged, so the pull request title becomes the commit subject; write it as a plain
   English sentence. The branch is deleted after the merge.

`main` is protected: no direct pushes and no force pushes.

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
- **Native shapes:** query results stay `frame`, `documents` or `graph`; conversions are explicit
  analysis steps, never implicit in the backend.
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
changed images in `docs/screenshots/`; the README shows them.

## Release notes

User-facing changes add a line to `docs/releases/v<version>.md` under "## Improved" or
"## Fixed", written for users, not developers. Changes that need a manual check on Windows add it
under "## Checklist for Windows (manual)".

## License

Kalzit is licensed under the [AGPL-3.0](LICENSE). By contributing, you agree that your
contribution is licensed under the same terms.
