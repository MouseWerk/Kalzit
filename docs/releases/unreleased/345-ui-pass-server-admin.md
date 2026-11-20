## Improved

- Traces: the detail of a span stands beside the waterfall instead of over it, also at 1024 px;
  on a phone it opens as a sheet over the waterfall and gives the focus back to the span's row
  when it is closed. A list of traces on a phone or in a small panel shows id, root, duration and
  status instead of scrolling sideways, and is as tall as its rows.
- Verwaltung > Sicherungen: the last runs are a list with sizes and durations at the right edge,
  one block per run on a phone; the target stands in one place and is edited from the section's
  header.
- Apps in the sidebar: an app with several pages shows its name once and its pages below it by
  their own titles, and its page says where it is in the top bar ("Apps / name").
- Verwaltung > CORS: the lists of origins and headers stand under their text at one width.
- Requests from self-registration: "Approve" and "Refuse" stand on one line and are quiet buttons;
  the card's explanation stands under its heading.
- "Create account" names the allowed domains as "a or b" in the page's language.

## Fixed

- The menu of a dashboard panel low in the window opened under its button, with its lower entries
  (Edit, Duplicate, Delete) past the window's edge and out of reach. It now opens above the
  button where there is more room, and scrolls in itself in a low window.
- Verwaltung > Sicherungen no longer scrolls the whole page sideways at 1024 px and on a phone.
- A trace in a low panel or in the panel editor's preview scrolls in its frame instead of running
  over what stands below it.
- An app carries the same two letters everywhere (sidebar, its own bar, Verwaltung > Apps and
  Verwaltung > Plugins).
