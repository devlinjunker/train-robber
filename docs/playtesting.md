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
| `view` | `?view=topdown` | Starts in the top-down debug view instead of the isometric one (V switches either way). |

Join them with `&`, for example `?v=steering:heading&v=throttleModel:coast&seed=test1`. The debug readout's third line shows the preset and the variants that are actually in effect, so check it before you judge a setting.

### Variant groups

| Group | Options (default first) | What it changes |
| --- | --- | --- |
| `steering` | `heading`, `screen` | Heading-relative: A/D turn the horse. Screen-relative: the arrow keys set a direction on screen and the horse turns toward it. |
| `throttleModel` | `coast`, `hold`, `cruise` | What releasing W does. Coast slows under drag, hold keeps your speed, and cruise makes W/S move a target speed the horse settles on. |
| `boardingFailure` | `time-and-damage`, `time-only` | Whether a failed jump costs health as well as time. |

## Controls and the debug view

| Key | Action |
| --- | --- |
| W / S | Throttle up / down |
| Arrow keys | Steer (screen-relative). In the isometric view one arrow is that direction on screen, and two arrows ride along the tile axis on that diagonal, the way the track and the cars run |
| A / D | Steer (heading-relative) |
| E | Commit to the train in range (the prompt at the bottom says `E: commit to blank-1` when you can) |
| Space | Boarding jump: samples the meter on that tick |
| W A S D, aboard | Walk inside the car, screen-relative (W+D walks toward the front); hold Shift to run |
| Esc | Cancel the run: back to the spawn, mounted and stopped |
| R | Quick retry: ends any run and puts you on the horse, stopped, 60 tiles behind the train on the side you were on |
| Q / Z, `-` / `=`, mouse wheel | Zoom out / in while idle; from commit until the run ends the zoom is locked (1x in iso, 1.75x top-down; `?runZoom=1.4` overrides) |
| V | Switch between the isometric view and the top-down debug view |
| O | Toggle the map overlay (speed zones, track samples, tangents, markers) |
| B | Toggle the boarding range circles around every door |
| backquote (`` ` ``) | Toggle the debug readout |
| L, or the Export logs button | Download this session's command and event logs |

### A run

1. Ride within 12 tiles of the train (`commit.rangeTiles`, measured to the nearest car) and press E. The run starts in `approach`, the train is yours, and health is full.
2. Ride beside a door on either side. The **boarding** line comes from the sim's own rule: `ELIGIBLE` (in range and speed matched), `TOO FAST`, `TOO SLOW` or `TOO FAR`, the side you are on, the distance to the nearest door on that side, and your speed along the car minus the train's.
3. In range, the meter above the horse sweeps back and forth: slowly with a white marker when your speed matches the train's, fast with an orange marker when it doesn't. Out of range it is dim and parked. The green band is perfect, the yellow band around it is good, the rest fails. The bands move to a new random place after every jump, never while you are lining up.
4. Space jumps. Out of range it is refused (`TOO FAR`); at the wrong speed it is allowed, just on the faster meter. A **perfect** landing puts you in the car; a **good** one too, with a 2.5 s stumble at a third of walking speed; a **fail** throws you clear, stuns the horse for 1.5 s at half its speed (it ignores the reins), costs 15 health under `time-and-damage`, and the train pulls ahead. Seven failures from full health kill you: "YOU DIED", and you are back at the spawn.
5. Aboard, walk the empty car with WASD (Shift runs). The view keeps the train's direction on screen. Esc or R ends the run.

The HUD shows the phase and health at the top right, and at the bottom what to do next and the last rejection or jump result. The doors on your side of the train carry markers: dim out of range, an orange ring in range at the wrong speed, and a filled green circle when in range and matched. Under the meter, `MATCHED`, `TOO FAST` or `TOO SLOW` gives your speed against the train's. Off-screen trains get an arrow on the screen edge with their distance, gold for the one you committed to. Committing to a train locks the zoom for the whole run (1 in iso, 1.75 top-down, or `?runZoom=`), aboard too; the zoom keys and wheel come back when the run ends, at the zoom you rode with. Aboard, the view stays the same: your car opens up (no roof, low walls) so you can see yourself walking in it, and the camera rides along with the train. When a car is between the camera and your horse and rider (or you, aboard), that car is cut away the same way, so you stay in sight.

The debug readout (top left, backquote hides it) keeps the details: the `run:` line with the phase and jump count, the `boarding:` line with the door distance and speed difference, the meter position and bands, and the in-zone timer for how long you have held the zone. B shows the boarding range circles around every door.

## Changing a value

All tuning lives in `packages/content`:

- `base/game.json` holds the base value of every key. Keys carry their unit in the name (`Sec`, `PerSec`, `Tiles`, `Deg`). The resolve step turns these into per-tick values, so never write a tick count by hand.
- `variants/*.json` each hold the few values one variant changes, as a `patch` over the base.
- `presets/*.json` pick one variant per group. A preset always applies: without `?preset=` the game uses `alpha-default`.

Keys that a variant group sets (`horse.steering`, `horse.throttleModel`) are decided by the chosen variant, never by `base/game.json`, because every variant in those groups patches the key. To change which steering or throttle model you get by default, edit the group's entry in `presets/alpha-default.json` (for example `"throttleModel": "coast"`). To change it for one session, use `?v=`.

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
| How far a commit reaches | `commit.rangeTiles` | 12 tiles |
| How fast the meter sweeps when speed matched (one full back and forth) | `boarding.meter.matchedSweepPeriodSec` | 1.85 s |
| How fast it sweeps in range at the wrong speed | `boarding.meter.sweepPeriodSec` | 1.3 s |
| Perfect and good band widths | `boarding.meter.zoneWidths` | 3%, 15% |
| How long a failed jump stuns the horse | `boarding.failure.stunSec` | 1.5 s |
| Horse speed after a failed jump | `boarding.failure.horseSpeedScale` | 0.5 |
| Health lost per failed jump | `boarding.failure.damageFraction` | 15% of max |
| Good-landing stumble | `boarding.landing.stumbleSec`, `stumbleSpeedScale` | 2.5 s at 0.33 |
| Running speed aboard (walking is half, in `packages/client/src/input.ts` as `WALK_AXIS`) | `player.speedTilesPerSec` | 8 tiles/s |
| Quick retry on R, and its gap behind the train | `playtest.quickRetry`, `playtest.quickRetryGapTiles` | on, 60 tiles |
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
3. Write down what you tried and how it felt, alongside the setup. Ideas for new features go in [ideas.md](ideas.md). Short notes are fine, for example "coast + heading-relative, seed test1: matching 9 tiles/s is easy, staying in the zone for 1 s is hard."

The event log now carries `RunStarted`, `RunPhaseChanged`, `BoardingAttempt` (result, attempt number, meter position), `DamageDealt`, `CommandRejected` (with the reason), `RunEnded` (outcome, length, jumps, and whether it was a quick retry) and `PersistentChanged`. The M5 report will read them to give attempts per run and failure reasons.

On the dev server (`npm run dev`, not the PR preview), `window.trainRobber.sim` is the live sim, for poking at state from the browser console.
