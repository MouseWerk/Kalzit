## Improved

- Map images through the Kalzit server: under Administration > Map a server administrator can
  set one source of map images (an https address with `{z}`, `{x}` and `{y}`, an attribution, an
  optional access key kept in the secret store), test it and save it in one step. It is off by
  default; switching it off applies at once, with undo. Browsers only ever ask Kalzit for the
  pictures, which the server fetches through its cache and the outbound proxy, for signed-in
  people and public links that show a map, limited per person and per link. Without map images,
  or while they do not load, maps draw the bundled outlines and say so
  ([Administration](../../guide/administration.md#map)).
- Graph layout "Map": a network panel can put its nodes on the same map as the map panel, by a
  `point` or by latitude and longitude, with the panel's style rules, selection and search; nodes
  without a place stand in a strip beside the map ([Panels](../../guide/panels.md#map)).
