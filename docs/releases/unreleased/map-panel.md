## Improved

- New panel **Map**: places from rows and documents as points, placed by latitude and longitude, a
  point field, a geohash or a country code, and countries filled by a value as areas, in up to
  four layers. The map draws outlines of countries and regions that ship with Kalzit, so it works
  without any network and never asks a map service. Near points are bundled, rows without a place
  are counted and listed with their reason, and a table view shows the same places. Graph results
  keep showing their nodes and edges on the map.
- Grafana import: geomap panels become maps; marker layers keep their place, size and query, and
  the report names what is not taken over (base map images, heatmap, route and GeoJSON layers, a
  fixed view).

## Checklist for Windows (manual)

- Add a map panel to a dashboard with a query that returns `lat` and `lon` columns, and one with a
  country code column as an areas layer: the outlines show with the network cable unplugged, the
  points and areas match the data, and "without a place" lists rows with empty coordinates.
- Import a Grafana dashboard with a geomap panel: the panel becomes a map and the report names
  the base map.
