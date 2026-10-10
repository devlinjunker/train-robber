# Creating maps

How to make a new map, from an empty Tiled file to playing it with `?map=`. The technical background (what the converter does, the MapDef format) is in "Tiled workflow in detail" in [technical-design.md](technical-design.md); this page is the how-to.

## What you need

- [Tiled](https://www.mapeditor.org/) 1.10 or later.
- The repo checked out with `npm install` done.

A map is one Tiled file, `packages/content/maps-src/<id>.tmj`. `npm run maps` turns it into `packages/content/base/maps/<id>.json`, which the game loads as `?map=<id>`. Both files are committed. The file name is the map id: lowercase letters, digits and dashes.

## Quick start: copy a map

The fastest way to a new map is to copy one that is close to what you want. The copy keeps the layers, the zone tileset and the properties already set up.

1. Copy a source file, for example `cp packages/content/maps-src/tight-loop.tmj packages/content/maps-src/my-map.tmj`.
2. Run `npm run maps:watch` in one terminal and `npm run dev` in another.
3. Open `my-map.tmj` in Tiled. Every save rebuilds the map, and the browser reloads.
4. Play it at `http://localhost:5173/?map=my-map`. Add `&view=topdown` to start in the top-down view with the map overlay on, which shows zones, the track's control points and the baked curve.

`alpha-flats` is the plainest starting point (one stadium loop, almost no obstacles). `big-country` shows several routes and trains on an 800 × 400 map.

## Starting from an empty file

1. In Tiled, choose File, New, New Map. Set orientation **Orthogonal**, tile size **32 × 32** px, map size **fixed** (not infinite). Width and height are in tiles, and one tile is one game tile. `alpha-flats` is 400 × 200.
2. Save it in `packages/content/maps-src/` as `<id>.tmj` (JSON map format).
3. Add the tileset: Map, Add External Tileset, and pick `packages/content/maps-src/zones.tsj`. Its four tiles are the zones `open`, `slow`, `blocked` and `water`.
4. Add these layers, named exactly like this (the converter finds them by name):

| Layer | Type | Holds |
| --- | --- | --- |
| `terrain` | Tile layer | Zone tiles |
| `track` | Object layer | One polyline per route |
| `speedZones` | Object layer | Rectangles with `speedScale` (may stay empty) |
| `markers` | Object layer | The `playerSpawn` point |

## Painting terrain

Paint `terrain` with the zone tiles. An unpainted tile counts as `open`.

| Zone | Effect on the horse |
| --- | --- |
| `open` | Full speed |
| `slow` (mud) | Top speed times `horse.slowZoneSpeedScale` (0.5 now: 7 tiles/s, slower than the 9 tiles/s train) |
| `blocked` (rock) | Cannot enter |
| `water` | Cannot enter |

A blocked border two tiles wide keeps the rider on the map. Mud right beside the track is a good obstacle, because the rider has to switch sides to keep up with the train.

## Drawing a route

On the `track` layer, use Insert Polyline and click the control points. The baked curve passes through every point (a centripetal Catmull-Rom spline), so what you draw is close to the track you get.

- **Closing the loop:** don't click back on the first point. Give the polyline a bool property `closed` = true and the curve wraps from the last point to the first.
- **Naming it:** set a string property `route` (or the object's name). The blank train runs on `main` unless the map lists its own trains, so every map needs a `main` route.
- **Curves:** put a point every 30 degrees or so around a bend, at an even spacing. A long straight next to closely spaced curve points makes the spline kink where they meet. `npm run maps` prints the tightest radius; keep it at 17 tiles or more, because the 16-tile cars cut visibly inside anything tighter.
- **Where it may go:** every part of the curve must be inside the map and off `blocked` and `water` tiles.
- **Where the train starts:** at the route's first point, heading towards the second.

## More routes and trains

A map can hold several routes, each its own polyline with its own `route` id.

By default the game starts one blank train on `main`. To choose the trains yourself, give track objects an int property `trains`: that many trains run on that route, spaced evenly round it. An optional string property `trainType` picks the train type from `base/game.json` (default `blank`). Once any route has `trains`, only the listed trains run, so give `main` a count too if it should have one.

Trains never switch from one route to another; junctions are a separate design. Keep parallel tracks at least 16 tiles apart (centre to centre) so the cars and a rider between them fit.

## The spawn

On `markers`, place a point object named `playerSpawn`. The rider starts there mounted and stopped, and Esc returns there. It must be on an `open` tile, with a rideable path to the track.

## Checking a map

- `npm run maps` rebuilds every map and reports each route's length, sample count and the tightest radius. Errors name the file, the route and the sample or tile at fault.
- `npm run maps:check` (part of `npm run check` and CI) fails if a checked-in `.json` doesn't match its `.tmj`. Run `npm run maps` and commit both files.
- `packages/tools/test/all-maps.test.ts` runs against every map in `maps-src`. It checks:
  - there is no rock or water under the cars;
  - one side of every track is always open to ride beside, from 3.5 to 5.5 tiles out;
  - the spawn can reach every route;
  - the tightest curve is at least 17 tiles;
  - the sim starts the listed trains and runs a full lap;
  - no two trains come within 12 tiles of each other.

  If a test fails, its message names the map, route and sample.

In the game, the top-down view (V) with the overlay (O) shows the zones, the control points, the baked samples and their tangents, so you can compare what the converter made with what you drew.

## Before you open a PR

- Add the map to the table in the Maps section of [playtesting.md](playtesting.md), with its `?map=` link.
- Add a layout image to `docs/maps/` if it helps, and link it there too.
- Commit the `.tmj` and the built `.json` together. `npm run check` should pass.

## Known limits

- Trains run at constant speed. `speedZones` are baked into the route but the sim does not use them yet.
- Routes must be closed loops for now. An open line would need trains to appear and disappear at its ends.
- Scenery layers are not drawn yet; everything visible comes from the zones and the track.
