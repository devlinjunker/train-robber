# Phase 1 Implementation Plan

> Exported from the live [Phase 1 implementation plan](https://claude.ai/code/artifact/9022cfb0-a7f8-4e10-8233-00026aae534e) on 2026-10-11, after Phase 1 finished (milestone PRs #4 to #9 merged). This copy is the final record and the live doc is no longer updated. Task checkboxes were never ticked in the live doc; the milestone PRs show what shipped, and the technical design's build order holds the final state of each item.

Oct 9, 2026 · @Devlin

## Overview

Phase 1 delivers one map, one blank train, a rideable horse and the timing-meter jump with its failure and cancel rules, and ends on the requirements' gate: riding and boarding is fun before any loot exists.

Scope comes from the build order and the "Phase 0 and 1 starting spec" in [docs/technical-design.md](https://github.com/devlinjunker/train-robber/blob/main/docs/technical-design.md) on `main`, checked against [docs/requirements.md](https://github.com/devlinjunker/train-robber/blob/main/docs/requirements.md) (Riding and boarding phase, Approach and boarding section).

**In scope:** finishing the Tiled map, horse riding (steer plus throttle), the train looping on a stadium route, commit and `startRun`, boarding rules and meter, failure stun and damage, minimal health and death, cancel, the separate-mode `WorldModel` and camera transition, a blank walkable interior, a minimal HUD, and logging of boarding attempts and run outcomes.

**Out of scope (phase 2 or later):** countdown and heat (`countdown.enabled` stays false), loot, whistle and extraction, wanted level changes, persistence, the continuous-world implementation, guards and combat, quick-time prompts.

## Starting point

Phase 0 merged to `main` in [PR #2](https://github.com/devlinjunker/train-robber/pull/2), and Phase 1 builds on what it shipped:

| Area | What is on `main` | What Phase 1 adds |
| --- | --- | --- |
| Config | `base/game.json` already holds every Phase 1 starting value: `horse`, `commit`, `boarding`, `health`, `world`, `countdown`, `trains.blank`, `outcomePolicy`; derive turns `xSec` into ticks and `turnRateDegPerSec` into `turnRateCosPerTick`/`SinPerTick`; preset `alpha-default`, variant group `boardingFailure` | Widen the sim's `SimConfig` type to read these sections; add keys for the open questions below |
| Sim | `createSim`/`restoreSim` with a structural `SimConfig`; commands `move`, `startRun`, `cancelRun`; events `RunStarted`, `RunCancelled`; a player dot moved by `player.speedTilesPerSec` | Track, trains, horse, boarding, health, phases, the `WorldModel` |
| Map | `maps-src/alpha-flats.tmj` placeholder: 400 × 200, stadium route of 731 tiles (240-tile straights, radius-40 U-turns), slow, blocked and water zones including a pond, one playerSpawn at (200, 170) (the horseSpawn marker is dropped in PR #4); `tools build-maps` with smoothing, samples and checks; `npm run maps:check` in CI | Adjust the map in Tiled if needed; scenery layers and a watch script are not done |
| Logs | Command and event logs, IndexedDB (newest 20 sessions), ring buffer, Export logs button (L), `tools replay`, checked-in golden replay with `npm run golden:update` | New events and an updated allowlist in `logging.events` |
| Client | Pixi scene and debug overlay in `apps/game` (fps, tick time, seed, config hash, state hash, preset, variants); no `packages/client` yet | The isometric renderer, input mapper and HUD |
| CI and hosting | `npm run check` runs typecheck, lint, dependency check, validate, maps check, tests; GitHub Pages deploys `main` and a preview per PR | Nothing new; playtests can use the PR previews |

Naming is settled: commands use a `type` field (`t` is the tick in log lines), the seed and `trainId` are strings, and the repo uses npm workspaces.

## Workstreams and tasks

The work splits into five milestones, each ending on something you can run or test; M1 and M2 can start in parallel, M3 needs both, and M4 can start once M2's train is moving.

### M1. Map and track (in review: PR #4)

- [ ] Review the placeholder `alpha-flats.tmj` in Tiled and decide whether to keep its 240-tile straights and radius-40 U-turns or redraw to the design's 220 and 45 (see Q10)
- [ ] Check the spawn against the train's approach: playerSpawn at (200, 170) sits 30 tiles below the bottom straight. There is no separate horse spawn; the player spawns mounted (decided in the M1 thread, PR #4)
- [ ] A watch script that rebuilds the map on save, and `?map=alpha-flats` selection
- [ ] Debug overlay draws routes, samples, tangents and zones

[Draft PR #4](https://github.com/devlinjunker/train-robber/pull/4) covers all M1 tasks: the map was verified unchanged, `npm run maps:watch` and `?map=` loading were added, and the debug overlay draws zones and the track (O key, on by default). Note for tuning: the smoothed track deviates up to about 0.85 tiles near the ends of each straight, and only the middle 110 tiles of each straight are exactly straight, which matters if boarding is meant to happen on a true straight.

### M2. Sim: trains and riding

- [ ] `world/track.ts`: position and tangent lookup by arc length on a closed route (in review in PR #4 as trackAt())
- [ ] Train entity: `trains.blank` is an engine plus 3 cars at 9 tiles/s, looping, cars as rigid 16 × 6 rectangles placed by distance along the route
- [ ] Train scheduler system: spawn the one blank train at load; pin a committed train
- [ ] Riding system: steering per the steering variant (screen- or heading-relative) (`move.x`), throttle on `move.y` with accel 8, brake 12, top speed 14, holding W reaches and holds top speed, and release behaviour follows the throttleModel variant (hold, coast or cruise); terrain zones slow or block
- [ ] Horse vs car collision: cars are solid, the horse stops or slides along a car's side
- [ ] Entry points in world space (car position plus offset across the track), one function shared by the boarding rule and the markers

### M3. Sim: commit, boarding, health and run end

- [ ] Commands `jump` and `interact` added to the `Command` union; commit query ("which train can I commit to") and `startRun` validation: within `commit.rangeTiles` and the train is free; run enters `approach`
- [ ] Boarding eligibility: within 2 tiles of an entry point on the riding side and within 1.5 tiles/s of train speed; rejected `jump` emits `CommandRejected` with too far, too fast or too slow
- [ ] Meter: sweeps continuously while eligible (`sweepPeriodTicks` from the derived config), resets on losing eligibility, one Space press samples it on that tick; perfect 10%, good 25%, else fail
- [ ] Landing results: perfect arrives clean, good arrives with a short stumble, fail throws the player clear, stuns the horse for `stunTicks` and deals `damageFraction` of max health
- [ ] Minimal health (`health.max` 100); death ends the run with outcome `died` under `outcomePolicy.died`
- [ ] `world/separate.ts` implementing `WorldModel`: `enterTrain` moves the placement into the car frame at the entry cell, horse becomes abstract while aboard
- [ ] Blank interior: walls plus floor per car, walkable in the car frame at `player.speedTilesPerSec` (the existing key, 8 tiles/s)
- [ ] Cancel: Esc in any phase but `ended`; the player returns to playerSpawn, mounted, the train keeps looping. Quick retry (R, config switch playtest.quickRetry, on in Phase 1) also ends the run but puts the player on the horse, stopped, about 60 tiles behind the train on the same side
- [ ] Run phases `idle`, `approach`, `boarding`, `aboard`, `ended`, with `RunPhaseChanged` events

### M4. Client: render, input, HUD

- [ ] Create `packages/client`; move Pixi code out of `apps/game`
- [ ] `projection.ts`: 2:1 isometric, 64 × 32 px tiles, zoom steps
- [ ] Terrain and track drawing, train cars as flat-shaded boxes drawn in 2-tile slices for depth sorting
- [ ] Interpolation buffer between the last two ticks
- [ ] Keyboard input mapper: A/D steer, W/S throttle, Space jump, E commit, Esc cancel, Q/Z and `-`/`=` zoom
- [ ] Look-ahead camera; edge arrows with distance for off-screen trains
- [ ] Entry markers (dim, ring, highlighted) and the too fast / too slow / matched readout
- [ ] Camera ease into the interior scene (about 0.5 s) into one plain walled car with a simple striped backdrop (minimal by decision; scenery art and multi-car interiors wait for Phase 2)
- [ ] HTML HUD: commit prompt, jump rejection reasons, health (the meter is drawn in the world above the horse, beside the speed readout)

### M5. Logging, tests and the playtest

- [ ] Events: `RunPhaseChanged`, `BoardingAttempt`, `CommandRejected`, `RunEnded` (outcome, duration, boarding attempts); decide whether `RunEnded` with outcome `cancelled` replaces the current `RunCancelled`; add them to `logging.events`
- [ ] Extend the golden replay with a scripted Phase 1 run (commit, two failed jumps, a good landing, cancel) and rerun `npm run golden:update`
- [ ] Headless bots over 1,000 seeds: idle and random-walk riders, checking no crashes and no horse inside a car
- [ ] Tick-time benchmark in CI
- [ ] Playtest on the Pages preview against the gate and record results in the doc

## Decided values

These come straight from the design doc's starting spec and scale placeholders; numbers are placeholders for tuning, but changing them is a design-doc edit, not a plan edit.

| Value | Placeholder | Config key |
| --- | --- | --- |
| Tick rate | 60 Hz | `sim.tickRateHz` |
| Commit range | 12 tiles | `commit.rangeTiles` |
| Boarding range from an entry point | 2 tiles | `boarding.rangeTiles` |
| Speed match tolerance | 1.5 tiles/s | `boarding.speedToleranceTilesPerSec` |
| Meter sweep period | 1.2 s | `boarding.meter.sweepPeriodSec` |
| Meter zones (perfect, good) | 10%, 25% of the track | `boarding.meter.zoneWidths` |
| Failure stun | 1.5 s | `boarding.failure.stunSec` |
| Failure damage | 25% of max health | `boarding.failure.damageFraction` |
| Max health | 100 | `health.max` |
| Horse top speed | 14 tiles/s | `horse.maxSpeed` |
| Horse accel, brake | 8, 12 tiles/s² | `horse.accel`, `horse.brake` |
| Horse turn rate | 120°/s | `horse.turnRateDegPerSec` |
| Walk speed aboard | 8 tiles/s | `player.speedTilesPerSec` |
| Train | engine plus 3 `blank-car`, 9 tiles/s, on route `main` | `trains.blank` |
| Map | 400 × 200 tiles | `alpha-flats` MapDef |
| Route | stadium, about 731 tiles: 240-tile straights, radius-40 U-turns | MapDef `routes.main` |
| Countdown | off in Phase 1 | `countdown.enabled: false` |

All of these except the route are already in `base/game.json` on `main`.

Decided rules: the run starts at commit (U1), the separate train map comes first (U8), cars are solid, damage on failure is a toggle via the `boardingFailure` variant group, and steering ships as a variant group with both models, screen-relative by default (decided in review).

## Testing and acceptance

Phase 1 is done when every check below passes in CI and a playtest says riding and boarding is fun without loot.

**Automated (CI)**

- [ ] Unit tests: track lookup on the baked samples (position and tangent at known distances, wrap-around), riding (top speed reached, braking, coast to stop, turn per tick), boarding eligibility (each rejection reason), meter zones, landing outcomes, cancel from each phase
- [ ] Collision: no tick where the horse's position is inside a car rectangle, over the bot runs
- [ ] Golden replay with the Phase 1 run matches its stored hashes; snapshot mid-boarding, restore and continue matches an uninterrupted run
- [ ] `npm run check` stays green: validate passes for `alpha-default` and both `boardingFailure` variants, and `maps:check` finds no stale map
- [ ] Tick-time benchmark under its threshold

**By hand**

- [ ] 60 fps in Chrome and Safari on the reference 2019 MacBook Pro with the full train on screen
- [ ] A rider starting about 60 tiles behind catches the train in roughly 12 s and can match speed before jumping
- [ ] A missed train comes back in about 80 s
- [ ] Switching `?v=boardingFailure:time-only` changes failure damage with no rebuild

**Playtest gate**

Riding and boarding is fun before any loot exists (requirements, phase 1). Log every session and read boarding attempts per run, failure rate by reason, time from commit to boarding and cancels. The design doc proposes these metrics without pass thresholds, so the gate stays a judgement call (decided in review).

**Gate playtest, 2026-10-10** (Devlin, defaults, 2019 MacBook Pro in Chrome, on the [PR #9 preview](https://devlinjunker.github.io/train-robber/pr-preview/pr-9/); answers in the [playtest comment](https://github.com/devlinjunker/train-robber/pull/9#issuecomment-6105000195))

- **Verdict:** "kinda fun" and a little challenging, but it needs more going on to really be fun, and single player only goes so far. That reads as the gate passing for riding and boarding, with the fun expected to come from what Phase 2 adds.
- **Catching the train:** too long from the spawn; about right from a quick retry. Waiting a lap is fine, but riding to catch up is faster.
- **Matching speed and the meter:** fiddly on the curves. Boarding usually takes 1 jump on a straight and about 3 on a curve, 1 to 3 overall.
- **Failing:** 15 damage per fail is a fair cost, and a fail makes you want to try again. The stun is hard to gauge.
- **Landing:** perfect and good don't feel different enough in this build. They start to feel better in PR #12.
- **Steering:** heading-relative by a clear margin; screen-relative is tough.
- **Readability:** easy to read, but Devlin doesn't love the TOO FAST / TOO SLOW / MATCHED readout.
- **Bugs:** none.
- **Changed while playing:** turned off the boarding zone circles, which made more sense.

Numbers from the session's event log (`tools report`): 6 runs, 5 boarded (83%); 4 cancelled (3 of them quick retries) and 1 death. 16 jumps, 2.67 per run: 1 perfect, 4 good, 11 fails (69%). Median 8.0 s from commit to aboard, median run 11.0 s. Rejections were rare: 2 commits out of range, 2 jumps too far, 1 jump while stunned.

## Decisions from review

All of these were settled in the plan review on 2026-10-09; the table keeps each question with its decision so the reasoning stays findable.

| # | Question | Proposed default |
| --- | --- | --- |
| Q1 | What happens after death in Phase 1: respawn at spawn like cancel, or a results screen first? | A short "you died" notice, then the same reset as cancel (player back to playerSpawn, mounted, train keeps looping, no results screen). Health refills to max at each run start. Decided |
| Q2 | How long and how strong is the good-landing stumble? | Decided: 0.5 s at 50% walk speed, as new keys `boarding.landing.stumbleSec` and `stumbleSpeedScale` |
| Q3 | What is the horse's coast drag when the throttle is released? | Decided: 4 tiles/s², new key `horse.dragTilesPerSec2`, used by the coast throttle model |
| Q4 | Does the meter sweep back and forth or wrap, and where do the zones sit? | Decided: back and forth sweep; the zones (perfect centred in good) move to a random position each attempt, drawn from the misc RNG stream so replays match; zones re-roll only after a jump resolves, and losing eligibility only restarts the sweep |
| Q5 | Where are the `engine` and `blank-car` templates, and their entry points, defined? `trains.blank` names them but nothing defines them yet | Decided: no doors on the engine. Generate both in code for Phase 1 (16 × 6 cells, a side door mid-car on both sides) and leave `tools build-cars` for Phase 2 |
| Q6 | How does the player walk inside the car? | Decided: Screen-relative WASD at the existing `player.speedTilesPerSec` (8 tiles/s) |
| Q7 | Does Phase 1 include the screen-relative steering variant? | Decided: build both in Phase 1 as a `steering` variant group (screen-relative and heading-relative), with screen-relative as the default |
| Q8 | Keep the slow, blocked and water zones the merged map already has (including the pond)? | Decided: Keep them, since they exercise the riding zone path, as long as none sits on the approach to the bottom straight |
| Q9 | What makes the playtest gate pass, and who plays? | Decided: no hard threshold. Play it on the Pages preview and judge whether it is fun; the boarding metrics are context, not a pass mark |
| Q10 | The merged map uses 240-tile straights and radius-40 U-turns; the design's scale placeholders say 220 and 45. Which wins? | Decided: keep the merged map; the design doc's placeholders are updated to 240 and 40 in PR #3 |
| Q11 | What speed does the horse have after a failed jump? | Decided: it drops to half speed during the stun, new key boarding.failure.horseSpeedScale = 0.5 |
| Q12 | Where is the boarding meter drawn? | Decided: in the world above the horse, next to the speed readout, not in the HTML HUD |
| Q13 | What does releasing W do? | Decided: try them all as a throttleModel variant group. hold (default): release keeps current speed. coast: release slows under horse drag (Q3). cruise: W/S raise and lower a target speed. In every model holding W reaches and stays at top speed (14). |
| Q14 | How are variants switched during playtests? | Decided: URL parameters only for Phase 1; the in-game variant panel waits until it is needed |
| Q15 | How does a playtester get back to boarding quickly? | Decided: quick retry on R, placing the player on the horse about 60 tiles behind the train; switchable off for later phases |
| Q16 | How much of the aboard side does Phase 1 build? | Decided: minimal. Camera ease, landing on the entry cell and the good-landing stumble; one plain walled car and a striped backdrop |
