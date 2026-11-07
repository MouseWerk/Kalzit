## Improved

- Data sources and Add data source use the wording of their design: all sources are read-only.
- Updates names the Linux arm64 packages for an offline update, and shows no "0 kept · 0 byte"
  while there are no backups.
- Fragen: "Allowed sources" shows how many sources are asked, such as "2 of 4".
- Hints and mails name the pages where they are in the navigation: Settings > AI, Settings >
  Plugins and Settings > Sign-in.

## Fixed

- Fragen: "Dashboard as context" puts the cursor into its search, and Escape anywhere in it or in
  "+ Source" closes the picker and returns to the button that opened it, without stopping a
  running answer. Escape on the picker's own button closes it too, and "+ Source" opens at its
  first source.
- Fragen: a long dashboard title in the picker wraps instead of widening the page on a phone.
- Plugins: after "Check key…" from the catalog, closing the key leads to the trusted keys
  instead of losing the focus.
- Fragen: "AI may not read" next to a source stays on one line instead of one word per line.
- Data sources: the details button and the row menu sit side by side in every row.
