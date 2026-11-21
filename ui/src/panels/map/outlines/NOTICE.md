# Map outlines

`world.kzo` (land, large lakes, borders between countries) and `regions.kzo` (borders of
first-level regions such as German states) are made from Natural Earth, which is in the public
domain: <https://www.naturalearthdata.com/about/terms-of-use/>. No permission is needed to use or
ship them; Kalzit names the source on every map that draws them ("Outlines: Natural Earth, public
domain").

## Source

The GeoJSON files of the natural-earth-vector repository, folder `geojson/`
(<https://github.com/nvkelso/natural-earth-vector>), version 5.x:

| File                                            | Scale | Used as                               |
| ----------------------------------------------- | ----- | ------------------------------------- |
| `ne_50m_land.geojson`                           | 1:50m | land, filled                          |
| `ne_50m_lakes.geojson`                          | 1:50m | large lakes, filled                   |
| `ne_50m_admin_0_boundary_lines_land.geojson`    | 1:50m | borders between countries, lines      |
| `ne_10m_admin_1_states_provinces_lines.geojson` | 1:10m | borders of first-level regions, lines |

The exact release tag of the files in this folder was not recorded when they were first built.
Whoever builds them again writes the tag (for example `v5.1.2`) into this table.

## How they are built

`node ui/scripts/map-outlines.mjs <folder with the four files>` writes both files here. It:

1. reads the GeoJSON features and keeps their rings and lines in longitude and latitude;
2. simplifies each line with Douglas-Peucker (borders are lines, so a shared border is stored
   once and simplifying cannot open a gap between neighbours);
3. stores the points in steps of 0.002 degrees (about 220 m) as zigzag varint differences in the
   `.kzo` format described at the top of the script (magic `KZO1`, scale, number of paths, then
   per path its kind and points).

The map panel decodes the files in the browser (`../outlines.ts`) and projects them to Web
Mercator. They are served by Kalzit itself, so maps work without any network access.
