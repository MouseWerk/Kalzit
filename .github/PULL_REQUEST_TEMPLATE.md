## Summary

<!-- What changes and why. Link the issue it closes, if any (Closes #123). -->

## Checklist

- [ ] The branch is named `m<n>/<topic>`, `fix/<topic>` or `docs/<topic>` and targets `main`.
- [ ] The title is a plain English sentence; it becomes the commit subject on squash merge.
- [ ] Tests cover the change; a fix has a test that fails without it.
- [ ] Server checks pass: `cargo fmt --all --check`, `cargo clippy --locked --all-targets -- -D warnings`, `cargo test --locked`.
- [ ] UI checks pass (in `ui/`): `npm run check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build`.
- [ ] End-to-end tests pass where the change touches them (`npm run e2e`).
- [ ] Authorization for new routes and resources is checked on the server.
- [ ] New UI texts are in the English and German catalogs.
- [ ] Visible UI changes: `npm run screenshots` was rerun and the changed images are committed.
- [ ] User-facing changes have a line in `docs/releases/v<version>.md` ("Improved" or "Fixed"), and a manual Windows check where needed.
- [ ] Docs (`docs/ARCHITECTURE.md`, `docs/api/`) are updated when a contract changed.

## Screenshots

<!-- For UI changes: before and after, light and dark theme where it matters. -->

## Notes for reviewers

<!-- Anything that needs attention: risks, follow-ups, manual steps. -->
