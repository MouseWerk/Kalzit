# Unreleased release notes

Every pull request with a user-facing change adds one fragment here instead of editing
`docs/releases/v<version>.md`, so parallel pull requests never conflict on the same file.

## Format

- File name: `<pr-number>-<short-topic>.md`, for example `224-ops-guides.md`.
- Content: only the sections the change needs, in this order and spelling:

  ```
  ## Improved

  - ...

  ## Fixed

  - ...

  ## Checklist for Windows (manual)

  - ...
  ```

- User-facing lines only, written like the existing release notes; no headline, no internal
  details.
- Links are relative to this folder (`../../guide/...`); the release pull request adjusts them
  to `../guide/...` when it moves the lines into `v<version>.md`.

## Release

The release pull request assembles all fragments into `docs/releases/v<version>.md` with the three
sections above and deletes the fragments it used.
