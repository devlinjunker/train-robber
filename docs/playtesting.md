# Playtesting and tuning

How to play a build, switch between variants, change tuning values, and record what you found. The numbers in [technical-design.md](technical-design.md) are placeholders for exactly this: Phase 1's gate is a judgement call ("is riding and boarding fun?"), so play, tweak and write down what changed your mind.

## Where to play

- **A pull request:** `https://devlinjunker.github.io/train-robber/pr-preview/pr-<number>/`, linked from a bot comment on the PR. It rebuilds on every push.
- **`main`:** `https://devlinjunker.github.io/train-robber/`.
- **Locally:** `npm install`, then `npm run dev`. Saving a file reloads the page, so this is the fastest loop for tuning values.

## Choosing a setup from the URL

| Parameter | Example | What it does |
| --- | --- | --- |
| `preset` | `?preset=alpha-default` | Picks a preset (one variant per group). `alpha-default` is the only one so far. |
| `v` | `?v=throttleModel:coast` | Swaps one group's variant. Repeat it for several groups. |
| `seed` | `?seed=abc123` | Fixes the seed so a run can be repeated. Without one the page picks a random seed. |
| `map` | `?map=alpha-flats` | Picks a built map from `packages/content/base/maps`. |

Join them with `&`, for example `?v=steering:heading-relative&v=throttleModel:coast&seed=test1`. The debug overlay's third line shows the preset and the variants that are actually in effect, so check it before you judge a setting.

### Variant groups

| Group | Options (default first) | What it changes |
| --- | --- | --- |
| `steering` | `screen-relative`, `heading-relative` | Screen-relative: the arrow keys set a direction on screen and the horse turns toward it. Heading-relative: A/D turn the horse. |
| `throttleModel` | `hold`, `coast`, `cruise` | What releasing W does. Hold keeps your speed, coast slows under drag, and cruise makes W/S move a target speed the horse settles on. |
| `boardingFailure` | `time-and-damage`, `time-only` | Whether a failed jump costs health as well as time (from M3). |

## Controls and the debug view

| Key | Action |
| --- | --- |
| W / S | Throttle up / down |
| Arrow keys | Steer (screen-relative) |
| A / D | Steer (heading-relative) |
| Mouse wheel | Zoom |
| O | Toggle the map overlay (zones, track samples, tangents) |
| L, or the Export logs button | Download this session's command and event logs |

The overlay shows horse speed and heading, the ground under the horse, the train's position, and the **boarding** line: whether you are in range of the nearest door and within the speed tolerance of the train (`IN ZONE`, `TOO FAST`, `TOO SLOW` or `TOO FAR`), plus how long you have held the zone and your best hold. On the map, each door has a circle of the boarding range. The nearest door's circle fills green in the zone and orange when you are close enough but at the wrong speed.

## Changing a value

All tuning lives in `packages/content`:

- `base/game.json` holds the base value of every key. Keys carry their unit in the name (`Sec`, `PerSec`, `Tiles`, `Deg`). The resolve step turns these into per-tick values, so never write a tick count by hand.
- `variants/*.json` each hold the few values one variant changes, as a `patch` over the base.
- `presets/*.json` pick one variant per group.

The loop:

1. Edit the value. For a quick experiment, edit `base/game.json`. When you want to compare two settings side by side, make it a variant instead (see below).
2. Play it with `npm run dev`, or push and use the PR preview.
3. When you keep a change, run `npm run golden:update`, then `npm run check`. Any config change alters the config hash, so the golden replay test fails until it is re-recorded. That is expected, and the re-recorded file goes in the same commit.
4. If the value is in the "Starting values" table of `technical-design.md`, update the table in the same PR. The doc is the record of decided values, so a change there should say why (a line in the PR description is enough).

`npm run check` also runs `tools validate`, which resolves every preset with every single-variant swap, so a typo in a key or a value out of range fails there with the file and path.

### Values worth tuning now

| What it feels like | Key | Now |
| --- | --- | --- |
| How fast the horse gets going | `horse.accel` | 7 tiles/s² |
| How hard S stops it | `horse.brake` | 12 tiles/s² |
| Top speed (and how fast you close on the train) | `horse.maxSpeed` | 14 tiles/s |
| How quickly coast bleeds speed | `horse.dragTilesPerSec2` | 3 tiles/s² |
| How fast W/S move the cruise target | `horse.cruiseTargetRateTilesPerSec2` | 10 tiles/s² |
| How sharp the horse turns | `horse.turnRateDegPerSec` | 120°/s |
| How much slow ground hurts | `horse.slowZoneSpeedScale` | 0.5 |
| How close to a door counts | `boarding.rangeTiles` | 2 tiles |
| How exactly you must match speed | `boarding.speedToleranceTilesPerSec` | 2 tiles/s |
| Train speed | `trains.blank.speedTilesPerSec` | 9 tiles/s |

Map changes (zones, the route, the spawn) are made in Tiled in `packages/content/maps-src/`; `npm run maps:watch` rebuilds the map on every save. See "Tiled workflow in detail" in the design doc.

### Adding a variant

Copy an existing file in `packages/content/variants/`, name it `<group>-<id>.json`, and give it a new `id` and a `patch` with only the values that differ. For example, a heavier coast:

```json
{
  "schemaVersion": 1,
  "id": "coast-heavy",
  "group": "throttleModel",
  "label": "Coast, heavy drag",
  "question": "What should releasing W do?",
  "patch": { "horse": { "throttleModel": "coast", "dragTilesPerSec2": 8 } }
}
```

It is then selectable as `?v=throttleModel:coast-heavy` with no other change. A new group also needs an entry in every preset, and two groups may not patch the same key. Validation catches both.

## Recording a session

1. Note the URL you played (it carries the seed and the variants).
2. Press L to export the logs. The command log replays the session exactly: `npm run tools -- replay <file>.commands.ndjson` reruns it and checks every state hash. That is the way to hand over a bug: "it happened near the end of this log."
3. Write down what you tried and how it felt, alongside the setup. Short notes are fine, for example "coast + heading-relative, seed test1: matching 9 tiles/s is easy, staying in the zone for 1 s is hard."

The event log (boarding attempts, run outcomes) gains the Phase 1 events in M3 and M5; the M5 report will read these logs to give attempts per run and failure reasons.
