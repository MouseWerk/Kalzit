## Improved

- The sign-in pages have a new picture next to the form: a calcite crystal with the lines of a
  table, a document and a graph, faint behind the crystal and clear and double inside it. It is
  drawn in the colors of the theme, in every theme and variant, stands still and is part of
  Kalzit itself; nothing is loaded from elsewhere. After a successful sign-in a light runs over
  the crystal's edges once; with reduced motion set, nothing moves.
- On wide and ultrawide monitors the panel with the picture now reaches the right edge of the
  window; the form keeps its width. Language, theme and help stand in the window's corner.
- New server setting **Picture next to the sign-in form** under Settings > Appearance and brand
  (`signin.backdrop`): turns the picture off, at once and with undo. On a server with its own
  product name or logo the picture is drawn fainter. See
  [Administration](../../guide/administration.md#appearance-and-brand).
- Narrow screens, the high-contrast theme and the forced colors of the operating system show a
  plain page without the picture.

## Fixed

- On the help pages before sign-in and on sign-in pages between 640 and 1024 px, the old
  background's light and grid no longer lie over the text.
- The old background's light no longer shows rings on large dark screens.

## Checklist for Windows (manual)

- Open the sign-in page on a wide monitor in a light and a dark theme: the crystal with table,
  document and graph stands next to the form, sharp, and the panel reaches the right window edge.
- Sign in: a light runs once over the crystal's edges, then the app opens. With "Animation
  effects" turned off in Windows (Settings > Accessibility > Visual effects) nothing moves.
- Turn on a contrast theme in Windows (Settings > Accessibility > Contrast themes): the panel is
  plain, without the picture, and the form stays readable.
- Settings > Appearance and brand > Picture next to the sign-in form: turn it off, reload the
  sign-in page in a private window (plain panel), then Undo.
