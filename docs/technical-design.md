# Train Robber: Alpha Technical Design

Oct 8, 2026 · @Devlin

## Overview and principles

The alpha is one deterministic TypeScript simulation package, a thin PixiJS client, and a validated config layer that holds every tunable value and playtest variant.

This design follows `train-robber-game-requirements.md` (Oct 8, 2026). Gaps and conflicts in that document are flagged in the next section as C1–C5 (conflicts) and U1–U12 (unclear). Every later section assumes the proposed default for each flag, so you can accept or overrule them one at a time.

**Principles**

- **The sim is pure.** No DOM, no PixiJS, no `Date.now`, no `Math.random`. Time arrives as ticks and randomness as seeded streams.
- **Commands in, events out.** Input is a list of intent commands per tick. The sim emits events, and the renderer, HUD, audio, logger and later the network all read that one stream.
- **State is plain data.** JSON-serializable, entities referenced by integer id, no classes, no `Map`, no cycles. A snapshot can be taken or restored at any tick.
- **Config over code.** Every value in the requirements' tuning list lives in config. Variants are overlays that switch without a rebuild.
- **Run state and persistent state are separate.** One small rules function turns a run outcome into a change to persistent state, so the roguelike and standard structures are both presets.
- **The world is an interface.** Continuous and separate-map modes share one state shape and differ in a few marked places (see World model).
- **Projection belongs to the renderer.** The sim is logical 2D plus layers (interior, roof). Isometric, and later 3D, are views of it.

**Decisions made in this draft** (comment on any you want changed)

- TypeScript (strict), pnpm workspaces, Vite, Vitest.
- 60 Hz fixed sim tick, configurable per run and recorded in every log (flag U9).
- Plain floating-point math, with no `sin`, `cos`, `pow` or `exp` in sim code. Multiplayer later is server-authoritative with client prediction, not lockstep.
- JSON config files validated by zod.
- PixiJS for the world, an HTML/CSS overlay for the HUD and menus.

## Flags: conflicts and unclear requirements

Five requirements conflict with each other and twelve are too open to build against. Each has a proposed default so the design can proceed; none of these defaults is locked in.

### Conflicts

| ID | Issue | Where it conflicts | Proposed default |
| --- | --- | --- | --- |
| C1 | Downed state vs loot loss | The structure section says dying or being downed loses all run loot. The on-board section gives a downed player a short window to recover. | Downed loses loot only if the recovery window expires. Otherwise the downed variant is the health bar with extra steps. Config: `health.downedLosesLootImmediately`, default false. |
| C2 | "Wanted level is the only persistence" | The alpha also tracks banked loot per run and in total for a leaderboard, and a standard-structure death may cost banked loot. | Persist three values: wanted level, spendable bank, and lifetime earned. Lifetime earned never decreases, and the leaderboard uses it (or best single run), so a death penalty cannot lower a score. Confirmed for the alpha; more values come later. |
| C3 | Pillar vs optional mechanic | "Heavy loot slows you down" is a design pillar, but the carry limit and weight slowdown "may be cut" after playtests. | Build both as independent config flags, on by default in the alpha. If playtests cut them, reword the pillar. |
| C4 | Any approach on any train vs the bank | The bank's core verb is the vault minigame, and its alternatives (dynamite, key hunt) are later. Combat or stealth has nothing to do on that train. | Define an approach as how you handle guards and reach the loot (fight, sneak, rush). The vault stays mandatory for the top prize, and other bank loot is open to every approach. Confirmed. |
| C5 | Mobile | Mobile is "not an initial target", yet stack choices must "keep mobile browsers working". | Treat mobile as constraints, not goals: intent-based input, no hover-only UI, a performance budget. No mobile testing in the alpha. |

### Unclear

| ID | Question | Why it blocks the design | Proposed default |
| --- | --- | --- | --- |
| U1 | When does a run start, and when does the countdown start? | A failed boarding "loses time", which implies the clock runs before boarding. The core loop also has you choosing a train before the run is defined. | A run starts when the player commits to a train. The clock starts then (confirmed in review). Config: `countdown.startsAt` = `commit` or `boarding`. |
| U2 | How does heat shorten the countdown? | No formula. Time spent is also a heat source, but time already drains the countdown, so it counts twice. | Heat runs 0–100. Drain rate is `1 + heatDrainFactor × heat/100`. Per-second heat from time spent defaults to 0. Heat decay defaults to 0 in the alpha. |
| U3 | What counts as "already jumping off" for the grace window? | The grace window cannot be implemented without a trigger. | Grace applies once the player has started the mount action. Window length is config, with 3 s as a placeholder. |
| U4 | Horse extraction details | Can you whistle again? What if you miss the pacing window? Does mounting use a timing meter? Is the arrival time shown? | One whistle arms the horse. Arrival delay is drawn from a seeded range at whistle time. The horse paces for a set window, then drops away, and a re-whistle is allowed after a cooldown. Mounting reuses the boarding meter at its own difficulty. Delay is hidden by default. |
| U5 | Death and wanted level | Expiry adds a wanted level and cancel adds none. Death is not stated. | Death adds none by default. Each outcome has its own `wantedDelta` in config. |
| U6 | Cancel loophole | Cancel loses loot but adds no wanted level, so cancelling just before expiry dodges the penalty. The doc defers this to playtests. | Keep the requirement, but log cancels with countdown remaining so abuse is measurable. Config: `cancelWantedDelta` and a `cancelPenaltyBelowSec` threshold, both off. |
| U7 | Run-length variant scope | Short (2–5 min) vs medium (8–15 min) could be global or per train, and countdown is also per train. | A global profile scales each train's base countdown and loot density. Per-train values stay overridable. The minute ranges are test outcomes, not inputs. |
| U8 | What is a "separate train map"? | The alpha map already holds the train and its interior, so the variant needs a definition. | See World model: the interior runs in a train-local frame, and the world becomes a lightweight backdrop. Confirmed: build the separate map first. |
| U9 | Sim tick rate | A fixed timestep is required, but no rate is given, and the floor is 30 fps. | 60 Hz, so timing windows resolve to about 17 ms. A 30 fps device runs two ticks per frame. |
| U10 | Combat data model | Knock-outs, ammo and healing items are open, but they shape the state schema. | Reserve the fields now: `incapacitated` on actors, nullable `ammo` (null means unlimited), and healing as a weighted loot category. Alpha default: unlimited ammo, no knock-outs. |
| U11 | Wanted level scale | "A few levels" and decay are undefined. | Levels 0–5, with a config table of extra guards per level. Decay is off. |
| U12 | Logging vs replay | Seeded runs must be replayable, but the logged events listed are only summary events. | Log two streams: commands (for exact replay) and events (for analysis). The log header holds the seed, config hash and persistent state at start. |

Not flagged as blockers, but still open: baseline hardware for the 30/60 fps targets (needs picking before phase 2), the timetable's absence from the alpha (trains are simply visible on the map, and the schedule data model leaves room), and when loot is cashed out (default: the moment the extraction mount completes).

## Package structure and repo layout

The repo is a pnpm monorepo with five packages, and one rule matters most: `sim` and `config` never import anything from the browser or from PixiJS.

&#91;embedded content: package dependencies · five packages and a later server\]

Arrows point from a package to what it depends on. `apps/game` also loads `config` and `content` directly, and the later server runs the same `sim` build.

### Layout

```
train-robber/
  apps/
    game/        Vite app: loop host, persistence, variant picker, debug overlay
  packages/
    sim/         pure simulation, zero DOM
    config/      zod schemas, overlay merge, validation, resolve + hash
    content/     data only: base/, trains/, maps/, variants/, presets/
    client/      PixiJS renderer, input sources, HUD, audio, log sinks
    tools/       CLI: validate, headless run, replay, bot batches
  docs/          requirements, this design
```

```
packages/sim/src/
  index.ts       public API: createSim, restoreSim, types
  core/          tick, state types, commands, events, serialize, hash
  rng/           seeded streams and helpers
  world/         frames, WorldModel interface, continuous.ts, separate.ts, track, collision
  systems/       one file per system, run in a fixed order
  verbs/         train-specific logic (inspect, vault, search), registered by id
  rules/         outcome policy, wanted level, scoring: pure functions
```

### Dependency rules (enforced in CI, not by habit)

- `packages/sim` compiles without the DOM lib, so `window` and `document` are type errors. It may not import `pixi.js`, `node:*` or any I/O.
- Lint bans `Date`, `Math.random` and the transcendental (sin, cos, pow, exp and similar; sqrt, abs, min, max and floor stay allowed) `Math` functions inside `packages/sim`.
- `client` imports `sim` only through its public `exports`, never deep paths.
- `content` is JSON only. `tools validate` checks every file on each CI run.
- A dependency-graph check (dependency-cruiser) fails on cycles and on any edge not shown in the drawing above.

### Tooling

TypeScript strict with project references, Vite for the app, Vitest for tests, ESLint, and the dependency check above. `tools` runs under Node and imports the same `sim` build as the browser, which is what makes headless balancing runs trustworthy.

## Simulation core

The sim is a function of three inputs, `(config, seed, commands per tick)`, and the same inputs always produce byte-identical state. The host owns the clock; the sim only counts ticks.

### Public API

```ts
interface SimOptions {
  config: ResolvedConfig;        // validated, frozen, hashed (see Configuration)
  seed: string;                  // run seed; all randomness derives from it
  persistent: PersistentState;   // wanted level, bank, lifetime earned
  players?: PlayerId[];          // defaults to one player; array exists for multiplayer
}

interface Sim {
  step(inputs: TickInput[]): TickResult;   // advance exactly one tick
  readonly state: Readonly<GameState>;     // live view for the renderer and HUD
  snapshot(): SerializedState;             // deep copy, JSON-safe
  hash(): string;                          // canonical state hash
}

declare function createSim(opts: SimOptions): Sim;
declare function restoreSim(snap: SerializedState, config: ResolvedConfig): Sim;

type TickInput = { player: PlayerId; commands: Command[] };
type TickResult = { tick: number; events: SimEvent[] };
```

### Fixed timestep

- The tick length is `1 / config.sim.tickRateHz`, default 60 Hz (flag U9). It is fixed for a run and written into the log header.
- The accumulator lives in the host (`apps/game` or the future server), not in the sim. The host calls `step` zero or more times per frame and caps catch-up at 5 ticks to avoid a spiral of death.
- The renderer interpolates between the last two ticks using the accumulator remainder. A 30 fps device runs two ticks per frame and stays correct.
- Pause, single-step and slow motion are host features: they just change how often `step` is called.

### Commands

Commands are intents, not key presses. That keeps keyboard, gamepad and touch interchangeable and keeps replays small.

```ts
type Command =
  | { t: 'move'; x: number; y: number }       // axes quantized to -127..127
  | { t: 'aim'; x: number; y: number }        // world-space direction, quantized
  | { t: 'fire' } | { t: 'melee' }
  | { t: 'interact'; held: boolean }          // loot, inspect, hold up, crack vault
  | { t: 'jump' }                             // boarding and mounting meter press
  | { t: 'whistle' }
  | { t: 'qte'; key: number }                 // only when quick-time prompts are enabled
  | { t: 'useItem'; slot: number }
  | { t: 'startRun'; trainId?: string }       // commit to a train (flag U1)
  | { t: 'cancelRun' };
```

The sim validates every command against current state (a `jump` outside the boarding phase is ignored and emits `CommandRejected`). Quantizing axes means two inputs either match exactly or differ, which makes replay comparison and later network compression simple.

### State

```ts
interface GameState {
  version: number;                 // snapshot schema version
  tick: number;
  rng: RngState;                   // all stream states, so restore continues the same sequence
  world: WorldState;               // track, trains, car frames, horse(s)
  run: RunState | null;            // null between runs
  players: Record<PlayerId, PlayerState>;
  entities: EntityTables;          // actors, guards, passengers, projectiles, loot, doors
  nextEntityId: number;
  persistent: PersistentState;     // copy in, written back only by rules/applyOutcome
}
```

Entities live in flat arrays inside `EntityTables`, ordered by integer id, and reference each other by id. Plain objects, arrays, numbers, strings and booleans only.

### Systems and tick order

Each system is a function `(state, ctx) => void` where `ctx` carries `config`, the RNG streams, `emit(event)` and the fixed `dt`. Systems mutate state in place for speed; only `snapshot()` copies. The order is fixed because it decides who sees whose changes:

1. Apply commands: validate and write intents onto actors.
2. Train scheduler: spawn, advance and loop trains along the track.
3. Riding: horse movement, speed matching, obstacles.
4. Boarding and mounting: timing meter, success and failure.
5. Movement and collision: on-board actors in car frames.
6. Perception: sight cones and noise.
7. AI behaviour: patrol, react, call for help.
8. Combat: shots, melee, damage, health and downed state.
9. Interaction and train verbs: looting, inspect, hold-up, vault.
10. Heat.
11. Countdown and run end: grace window, expiry, death, extraction complete.
12. Outcome rules: apply the run outcome to persistent state.

### Determinism rules

- No `Date`, `Math.random`, async code or I/O inside `step`. Lint enforces it.
- Floating point is allowed. `sin`, `cos`, `pow`, `exp` and friends are banned in sim code because browsers can disagree on them. Where angles matter, such as sight cones, the cosine threshold is precomputed once when config is resolved, and checks use dot products.
- Randomness comes only from the seeded streams (see Randomness and logging). Each system uses its own stream so adding a draw in one place does not shift every other sequence.
- Iteration is always by array order or ascending id. Nothing depends on object-key order beyond integer keys.

### Serialization and tests

- `snapshot()` is a `structuredClone` plus a version field. `restoreSim` migrates older versions.
- `hash()` is FNV-1a over a canonical JSON form (sorted keys, fixed number formatting). The host can log it every N ticks to catch drift.
- Golden-run tests: a fixed seed plus a scripted command list must end on a stored hash. A second test snapshots mid-run, restores, continues, and must match an uninterrupted run.

## Game systems

Each requirement maps to one system that owns its state and reads its tuning from config. Train-specific behaviour lives in small verb modules, so the core systems never name a train.

### Run lifecycle

| Phase | Starts when | Ends when | Next |
| --- | --- | --- | --- |
| `idle` | No run is active (`run` is null) | Player sends `startRun` | `approach` |
| `approach` | Run created, train chosen, countdown started (U1) | Player attempts the boarding jump | `boarding` |
| `boarding` | Jump pressed beside the train | Success, or failure which costs time and health | `aboard`, or back to `approach` |
| `aboard` | Player's placement moves into a car frame | Player whistles | `extracting` |
| `extracting` | Whistle sent | Mount succeeds, or the horse drops away and the player re-whistles after a cooldown | `ended`, or back to `aboard` |
| `ended` | Any outcome fires | Outcome applied to persistent state | `idle` |

Outcomes are `extracted`, `expired`, `died` and `cancelled`. `cancelRun` is accepted in every phase except `ended`. Expiry is checked after the grace window (U3).

### Run state and persistent state

```ts
interface RunState {
  runId: number; trainId: string; phase: RunPhase;
  countdownSec: number; heat: number;
  players: Record<PlayerId, PlayerRunState>;   // health, downed timer, carried loot, weight
  horse: HorseState;                           // physical or abstract (see World model)
  stats: RunStats;                             // counters the log and rules read
}

interface PersistentState {
  version: number;
  wantedLevel: number;
  bank: number;             // spendable
  lifetimeEarned: number;   // never decreases; leaderboard source (C2)
  upgrades?: Record<string, number>;   // reserved for later progression
}
```

The only code that writes `PersistentState` is `rules/applyOutcome(persistent, outcome, summary, policy)`, a pure function driven by an `outcomePolicy` block in config:

```json
"outcomePolicy": {
  "extracted": { "bankRunLoot": true,  "wantedDelta": 0 },
  "expired":   { "bankRunLoot": false, "wantedDelta": 1 },
  "died":      { "bankRunLoot": false, "wantedDelta": 0, "bankLossFraction": 0, "reset": [] },
  "cancelled": { "bankRunLoot": false, "wantedDelta": 0 }
}
```

The alpha default is the simplest rule from the requirements: death loses the run's loot and nothing else. A roguelike preset fills `died.reset` with the things that wipe, and a standard preset sets `bankLossFraction`. Both are placeholders until the structure decision is made, and neither needs a code change.

### Systems

| System | Owns | How it works | Main config keys |
| --- | --- | --- | --- |
| Run generation | Seeded train layout | At run start, builds the train from its template: cars, guard count (base + wanted level bonus), passengers, loot placement drawn from the `gen` stream. | `trains.<id>`, `wanted.guardBonus` |
| Riding | Horse position, velocity, stamina | Arcade handling steers a velocity vector toward the input, with a precomputed per-tick rotation instead of trig. Stamina and speed tiers are variants of `handlingModel`. Rocks and rivers are map zones that slow or block. | `horse.*` |
| Boarding | Meter state | A meter oscillates; `jump` samples it on that tick. Zones give perfect, good or fail. Failure costs time and health, and the train keeps moving. Quick-time prompts are a variant. | `boarding.meter.*`, `boarding.qte.*` |
| Trains and cars | Track position, car frames | Trains advance along the track by arc length. Each car has an interior grid, entry points and a roof flag. | `trains.<id>.cars`, `track.*` |
| Perception and AI | Sight, noise, alert state | Guards patrol, notice by sight cone and noise radius, escalate from suspicious to alert, and call for help, which raises an alarm. | `ai.*` |
| Combat and health | Health, downed timer, ammo | Projectiles are entities with swept-circle hits. Melee is a range-and-facing check using dot products. Health bar by default, downed state as a variant. | `combat.*`, `health.*` |
| Loot and carry | Loot entities, carried stacks, weight | The carry limit and weight slowdown are two separate flags (C3). Speed multiplier falls linearly from 1 to a minimum as weight approaches the limit. | `carry.*`, `items.*` |
| Extraction | Horse call, mount | Whistle draws an arrival delay (U4). The horse paces for a window, then drops away. Mounting uses the boarding meter at its own difficulty. | `extraction.*` |
| Heat and countdown | Heat, countdown | Heat sources add fixed amounts per event. Drain rate is `1 + heatDrainFactor × heat/100` (U2). | `heat.*`, `countdown.*` |
| Wanted level | Persistent level | Read at run generation only. It never changes mid-run. | `wanted.*` |

Heat sources are a config map from event to amount, so the playtest question "how much heat does each action add" is answered by editing numbers:

```json
"heat": {
  "maxHeat": 100,
  "heatDrainFactor": 1.0,
  "decayPerSec": 0,
  "sources": {
    "shotFired": 2, "alarmRaised": 15, "playerSpotted": 5,
    "actorKilled": 8, "lootTaken": 1, "timeAboardPerSec": 0
  }
}
```

Those numbers are placeholders to show the shape.

### Train verbs

A verb is a small module registered by id. A train's config lists which verbs it uses and their parameters.

```ts
interface TrainVerb {
  id: string;
  init(state: GameState, ctx: Ctx, car: CarRef, params: unknown): void;       // run generation
  onInteract(state: GameState, ctx: Ctx, actor: ActorId, target: EntityId): void;
  tick?(state: GameState, ctx: Ctx): void;
}
```

Verbs change state only through shared helpers (`addLoot`, `raiseHeat`, `emit`), so logging and heat stay consistent.

| Train | Favoured style | Alpha content | Verb |
| --- | --- | --- | --- |
| Mail/express | Speed and stealth | Short run, many small items, light guards | `search` (find items, no decoys yet) |
| Military payroll | Combat | Heavy guards, big payout, drives the health-variant test | none; core combat only |
| Passenger | Stealth and judgment | Visual cues, timed inspect, armed passengers and undercover lawmen | `inspect` |
| Bank/gold | Vault under pressure | Vault progress pauses while a guard sees the player, and drains at a config rate | `vault` (top prize only, per C4) |

Cargo and tycoon trains need no new core code: cargo adds a decoy mode to `search`, and the tycoon train is guard and loot config plus a boss actor.

## World model: continuous or separate map

Both modes share one state shape. Every position is a placement in a named frame, and the mode changes only how the horse behaves while the player is aboard and which scene the renderer draws. This design reads "separate train map" the way flag U8 proposes, and that reading is confirmed. The alpha builds the separate mode first.

### Frames and placements

```ts
type FrameId = 'world' | { car: EntityId };      // serialised as 'world' or 'car:12'
interface Placement {
  frame: FrameId;
  x: number; y: number;                          // tiles, logical top-down
  layer: 'ground' | 'interior' | 'roof';
}
```

- The sim is logical 2D plus layers. Height is a layer, not a coordinate, and isometric projection exists only in the renderer.
- Riding, boarding and extraction work in the `world` frame. On-board systems (movement, perception, combat, loot) work only in car frames and never read world coordinates.
- A car frame is placed in the world by the train's arc-length position on the track. Track segments store a unit tangent at load time, so no trig runs per tick.
- Boarding moves the player's placement from the world frame to a car frame at an entry point. Mounting moves it back.
- The train and track simulate in both modes. Countdown, train speed and horse timing are therefore identical, which keeps the two variants comparable.

### WorldModel interface

```ts
interface WorldModel {
  trainAnchor(trainId: EntityId): { pos: Vec2; vel: Vec2; entryPoints: EntryPoint[] };
  toWorld(p: Placement): Vec2;
  walkable(p: Placement): boolean;                         // collision in the placement's own frame
  enterTrain(state: GameState, player: PlayerId, entry: EntryPoint): void;
  leaveTrain(state: GameState, player: PlayerId): void;    // used by mounting
  readonly horseWhileAboard: 'physical' | 'abstract';
}
```

`world/continuous.ts` and `world/separate.ts` each implement it in well under a few hundred lines, and `config.world.mode` selects one when the sim is created.

### What differs between the modes

| Aspect | Continuous world | Separate train map |
| --- | --- | --- |
| Player while aboard | Placement in a car frame; the train visibly moves through the world | Same |
| Horse while aboard | Physical body riding beside the train, obstacles and all | Abstract state: `away`, `approaching`, `alongside`, `leaving`, driven by timers |
| Boarding and mounting | World ↔ car frame transform at an entry point | Same |
| Renderer scene | One scene; camera follows the player across the map; roofs fade | Interior scene with cars laid end to end; a scrolling backdrop stands in for scenery |
| Extra content | None | Interior scene layout per train, plus a backdrop loop |
| Main cost | Horse and obstacle simulation continues while aboard; more occlusion cases | Extraction feels less physical; backdrop art |
| What the test answers | Is one world more fun? | Is it easier to build and tune? |

The map file is the same for both. The separate mode simply stops drawing terrain once the player boards.

### Cost of adding continuous later

The alpha starts with the separate map, and the continuous world is more work than it. It does not need a redesign, because the train, track, car frames, on-board systems and config schema are shared. The extra work is in four places:

- **A physical horse while aboard.** Today the horse is a timer state while the player is on the train. Continuous needs a real body that paces beside the train, collides with terrain, and can later be hurt. The extraction timings (arrival delay, pace window) then need retuning.
- **Real terrain along the whole track.** Rocks, rivers and slow zones only matter near the approach in separate mode. In continuous they matter for the entire run, so the map needs finished content and collision along the full loop.
- **A second renderer scene.** One large scene with a camera that follows the player, the train moving through scenery, and culling so only nearby terrain is drawn. Roof fading is no longer the only occlusion case.
- **Tuning and tests twice.** Golden runs and balance checks must cover both modes, because the horse timing differs between them. The world-structure playtest only works once both exist.

### Map and schedule data

- **MapDef** holds the tile size, a terrain grid of zone ids (open, slow, blocked, water), a closed track polyline with an arc-length table, spawn points for the player and horse, and render-only scenery.
- **Trains** are entities with a type id, an arc-length position and a speed. A train that a run has targeted is pinned: it cannot despawn or leave the loop until the run ends.
- **Schedule** is a deterministic function of the `schedule` RNG stream and three config values (`frequencySec`, `maxConcurrent`, `typeWeights`). A missed train comes back around because the track is a loop. A future timetable is a read-only view over the upcoming schedule, so the data model already supports it.

### Deliberately not supported

The requirements have no way to leave a moving train except mounting the horse, so walking on the ground mid-run is out. The frame model would allow it later by calling `leaveTrain` without a mount.

## Map design

The alpha map is drawn in Tiled and converted to our own `MapDef` format: a tile grid for terrain, one or more curved track routes, and a few markers. Decided so far: Tiled for authoring, a tile grid plus polyline tracks, a flat approach area for phase 1, and a stadium-shaped first route that is mostly straight (more curves, then hills, later).

### Authoring pipeline

- The Tiled file lives in `packages/content/maps-src/`. Its `terrain` tile layer sets a `zone` property per tile (`open`, `slow`, `blocked`, `water`). A `track` object layer holds one polyline per route, and a speedZones layer holds rectangles that slow the train. A `markers` layer holds points such as `playerSpawn` and `horseSpawn`. Scenery layers are render-only and ignored by the sim.
- `tools build-maps` converts the Tiled file into `base/maps/<id>.json`, validated by the config schemas. The game never reads Tiled files at runtime, so the sim does not depend on Tiled's format. CI runs the conversion.

### Tiled workflow in detail

Tiled is only an editor. You draw, save a `.tmj` file, and the converter writes the map file the game reads. Layer names matter because the converter finds layers by name.

**One-time setup**

1. Create `alpha-flats.tmj` in `packages/content/maps-src/`, orthogonal (top-down) orientation, 400 × 200 tiles, fixed size (not infinite). Use a 32 px tile for editing only; one Tiled tile is one sim tile.
2. Add a placeholder tileset `zones` with four coloured tiles. Give each tile a custom string property `zone` set to `open`, `slow`, `blocked` or `water`.
3. Add the layers: `terrain` (tile layer), `track` (object layer), `speedZones` (object layer), `markers` (object layer), and any number of render-only layers whose names start with `scenery`.

**What you draw**

- **Terrain.** Paint the `terrain` layer with the zone tiles. An unpainted tile counts as `open`.
- **Track.** On `track`, use the Insert Polyline tool and click control points. The curve passes through them, so the line you draw is roughly the track. Fewer points give a smoother curve. Add custom properties `route` (string, for example `main`) and `closed` (boolean).
- **Speed zones.** On `speedZones`, draw rectangles with a float property `speedScale` between 0 and 1. Any stretch of track inside a rectangle runs at that fraction of normal speed.
- **Markers.** On `markers`, place point objects named `playerSpawn` and `horseSpawn`.

**What `tools build-maps` does**

1. Reads the `.tmj` and checks that every required layer exists and has the right type.
2. Converts `terrain` to zone ids through the tileset property and run-length encodes the grid.
3. Converts each polyline from pixels to tile units. Both Tiled and the sim have y pointing down, so no flip is needed. The renderer does the isometric projection later.
4. Smooths each route with a Catmull-Rom curve (wrapping around for closed routes) and samples it into segments about half a tile long. Each sample stores its position, distance along the route, unit tangent and speed scale (the lowest value of any overlapping zone). These baked samples are what the sim reads, so no spline maths runs in the game.
5. Copies the markers, and copies the `scenery` layers into a separate render-only file.
6. Runs the checks below and writes `base/maps/alpha-flats.json` with a hash of the source file, so a stale output is detectable.

**Checks (errors unless noted)**

- Every route has at least two points, or three if closed, and every sample is inside the map.
- No sample lies on a `blocked` or `water` tile.
- Both spawns are inside the map on `open` tiles.
- `speedScale` is greater than 0 and at most 1.
- Warning: the curve's radius is smaller than the longest car. Cars are rigid rectangles along the track, so a very tight bend would make them cut corners.

**Edit loop.** A watch command (`pnpm maps:watch`) rebuilds on save and the dev server reloads the map. Loading `?map=alpha-flats` selects it. The debug overlay can draw routes, samples, tangents, zones and speed zones, so you can check what the converter produced against what you drew.

**Notes**

- Author in Tiled's orthogonal mode. Its isometric mode uses a different coordinate unit for objects, which would complicate the converter for no gain.
- Tiled cannot attach properties to individual polyline vertices, which is why slow stretches use rectangles.
- For hills later, add an `elevation` tile layer with a numeric value per tile. The converter would sample it into a height per route sample, and the alpha ignores it.

### MapDef (sketch, placeholder values)

```json
{
  "schemaVersion": 1,
  "id": "alpha-flats",
  "size": { "cols": 400, "rows": 200 },
  "zoneLegend": ["open", "slow", "blocked", "water"],
  "zones": "run-length encoded grid, one legend index per tile",
  "routes": [
    { "id": "main", "closed": true, "smoothing": "catmull-rom",
      "points": [ { "x": 12, "y": 30 }, { "x": 40, "y": 22 }, { "x": 75, "y": 35 } ] }
  ],
  "speedZones": [ { "x": 30, "y": 15, "w": 20, "h": 14, "speedScale": 0.8 } ],
  "markers": { "playerSpawn": { "x": 60, "y": 40 }, "horseSpawn": { "x": 58, "y": 42 } }
}
```

### Track model

- Each route is a list of points. At build time the tool smooths it into a curve and samples it into short straight segments with an arc-length table and a precomputed unit tangent per segment. The sim therefore does no spline math per tick, and curves work from phase 1.
- A map can hold several routes. A route is a closed loop or an open line. A train type names the route it runs on in its config, so trains do not have to share one oval. The alpha uses one shared route (see Map decisions).
- Tight bends are a tuning lever. An optional `speedScale` in a speed zone rectangle slows the train over that stretch, which makes boarding on a curve harder than on a straight.
- Hills later: each point may carry an optional `elevation`. The alpha ignores it. It could later drive train speed (slower uphill) and rendered height without changing the sim's 2D model. Walking over hills or vertical gameplay belongs with 3D.

### Cell types and car templates

A car interior is a grid of cells, one cell per world tile so the continuous mode can reuse it unchanged, with x along the car's length and y across it, and what each cell does comes from one shared catalog in game config, not from a legend inside each template. Walls and floors are the dull part. The catalog also covers cover, windows, furniture and noisy boards, so a car's layout shapes where fights and stealth routes happen.

`base/cell-types.json` (placeholder values):

```json
{
  "schemaVersion": 1,
  "cellTypes": [
    { "id": "floor",         "blocksMove": false, "blocksSight": false, "cover": 0,   "noise": 1.0 },
    { "id": "wall",          "blocksMove": true,  "blocksSight": true,  "cover": 1.0 },
    { "id": "door",          "blocksMove": false, "blocksSight": true,  "cover": 0,   "opensOnInteract": true, "noise": 1.5 },
    { "id": "window",        "blocksMove": true,  "blocksSight": false, "cover": 0,   "shootThrough": true },
    { "id": "crate-stack",   "blocksMove": true,  "blocksSight": false, "cover": 0.5 },
    { "id": "barrel",        "blocksMove": true,  "blocksSight": false, "cover": 0.4 },
    { "id": "bench",         "blocksMove": false, "blocksSight": false, "cover": 0.25, "noise": 1.0 },
    { "id": "rug",           "blocksMove": false, "blocksSight": false, "cover": 0,   "noise": 0.5 },
    { "id": "creaky-boards", "blocksMove": false, "blocksSight": false, "cover": 0,   "noise": 2.0 }
  ]
}
```

Each field feeds one system: `blocksMove` feeds movement, `blocksSight` and `shootThrough` feed perception and combat, `cover` feeds combat as a fraction from 0 to 1 of ranged damage absorbed (0.5 halves it; walls are 1.0), and `noise` is a footstep multiplier that feeds the noise and heat rules. Changing how loud a rug is becomes a config edit, with no car to rebuild.

A car template then holds only layout and placements (sketch):

```json
{
  "schemaVersion": 1,
  "id": "mail-car-a",
  "carType": "mail-car",
  "size": { "cols": 16, "rows": 6 },
  "cells": "run-length encoded grid of cell-type indices",
  "entryPoints": [
    { "id": "side-left",  "cell": [4, 0], "side": "left" },
    { "id": "side-right", "cell": [4, 5], "side": "right" }
  ],
  "lootSlots":   [ { "cell": [2, 1], "tags": ["small"] }, { "cell": [5, 2], "tags": ["small", "hidden"] } ],
  "guardSpawns": [ { "cell": [4, 2], "facing": "left", "patrol": "car-loop" } ],
  "roof": { "accessFrom": [] }
}
```

Entry point ids are the ones a train's config lists under `boarding.entryPoints`. Loot slots carry tags, and the run generator fills them from the seeded `gen` stream using the train's loot table. A train can mix several layouts of one car type (for example `mail-car-a` and `mail-car-b`), picked from the same stream, so repeat runs on one train type do not look identical.

**Authoring cars.** Interiors are drawn in Tiled with the same pipeline as the map. Each car is a small `.tmj` in `packages/content/cars-src/`, with a `cells` tile layer painted from a `cars` tileset whose tiles carry a `cellType` property. Object layers hold entry points, loot slots and guard spawns. `tools build-cars` converts them and checks that:

- every cell type used exists in the catalog;
- every entry point sits on a floor or door cell;
- every loot slot and guard spawn can be reached from an entry point (a flood fill over cells that don't block movement);
- a car is not one unbroken corridor, unless it is explicitly marked as one.

The reachability check matters most, since an unreachable loot slot is a bug that only shows up in play.

### Car Tiled workflow in detail

Cars use the same approach as the map: Tiled is only the editor, and a converter turns each `.tmj` into data the game reads.

**One-time setup**

1. Create `packages/content/cars-src/` with one `.tmj` per layout, for example `mail-car-a.tmj`. Use orthogonal orientation, a 32 px tile, and a fixed size equal to the car's cells. Add a map property `carType` (for example `mail-car`). A train's config picks cars by `carType`, and the seeded `gen` stream picks one of that type's layouts.
2. Add the `cars` tileset with one tile per cell type, each with a string property `cellType` equal to a catalog id, and coloured placeholder art. `tools sync-car-tileset` generates this tileset from `cell-types.json`, so the tileset cannot drift from the catalog. Adding a new cell type is therefore one catalog entry and one sync.
3. Add the layers: `cells` (tile layer), and object layers named `entryPoints`, `lootSlots`, `guardSpawns` and `patrol`. A `seats` object layer is reserved for the passenger car in phase 4.

**What you draw**

- **Cells.** Paint every cell on `cells`: walls around the edge, floor inside, then props (crates, barrels, benches, rugs, windows, doors). An unpainted cell is an error, unlike the map, because a hole in a car is never intended.
- **Entry points.** Point objects on `entryPoints`. The object name is the id (`side-left`), and an enum property `side` is `left`, `right`, `front` or `rear`. Each sits on a floor or door cell on the car's edge.
- **Loot slots.** Point objects on `lootSlots` with a string property `tags`, comma separated (`small,hidden`). The tags decide which items from the train's loot table can land there.
- **Guard spawns.** Point objects on `guardSpawns` with an enum property `facing` (`left`, `right`, `up`, `down`) and an optional string property `patrol`.
- **Patrol routes.** Optional polylines on `patrol`, named by the id a guard spawn refers to. The converter turns each into a list of cells. A guard with no patrol stands watch.
- **Roof.** An optional map property `roofAccess`: a comma-separated list of entry point ids that lead to the roof (empty by default).

Place points near the middle of a cell. The converter divides pixel positions by the tile size and rounds down.

**What `tools build-cars` does**

1. Reads each `.tmj`, checks the layers exist with the right types, and reads each tile's `cellType` through the tileset.
2. Converts the `cells` layer into a grid of catalog indices, rejecting any unknown `cellType`.
3. Converts the points into cell coordinates, splits the `tags`, and resolves patrol names to cell lists.
4. Runs the checks below.
5. Writes all cars into `base/car-templates.json` (generated, marked do-not-edit) with a hash of each source file so stale output can be detected.

**Checks (errors unless noted)**

- Every cell is painted and its cell type exists in the catalog.
- Each entry point is on a floor or door cell on the car's edge.
- Loot slots and guard spawns are not on cells that block movement, and no two share a cell.
- Every loot slot and guard spawn is reachable from at least one entry point, using a flood fill over cells that don't block movement (doors count as passable).
- Every patrol route lies on walkable cells.
- Warning: a tag on a loot slot that no loot table uses.
- Warning: no loot slots at all, or fewer slots than the train config's loot density could fill.
- Train-level check in `tools validate`: all cars in one train have the same number of rows, so they line up end to end.

**Edit loop.** `pnpm cars:watch` rebuilds on save. Loading `?car=mail-car-a` opens a debug scene with just that car, so you can walk it, shoot across it and test sight lines without a full run. The debug overlay colours cells by type and can show cover values, noise values, the reachable area from each entry point, and the loot slots and spawns.

**Notes**

- Never edit `car-templates.json` by hand. The source of truth is the `.tmj` files and the catalog.
- Keep cars of a type the same size unless you want trains with uneven cars, which would need a rule for the joins.
- Interiors are authored in orthogonal mode like the map. The renderer does the isometric view.

### Separate-mode transition

- **Sim:** a successful boarding moves the player's placement from the world frame to the car frame at the entry point, and the phase changes from `boarding` to `aboard` on that tick. The sim never pauses.
- **Client:** the camera eases from the world view to the train scene over a short placeholder duration (about half a second). The train scene lays the cars end to end, and a backdrop scrolls past at the train's speed using its progress along the route. Bends may tilt or shift the backdrop as a visual touch only.
- **Extraction** reverses this: mounting moves the placement back to the world frame, and the camera eases back out.

### Scale placeholders

These live in config and get tuned in phase 1: a map of about 400 × 200 tiles, a stadium-shaped main route of roughly 720 tiles (two 220-tile straights joined by two U-turns of radius 45), a train about 62 tiles long at 9 tiles per second (a loop in about 80 seconds), and a horse top speed of 14 tiles per second. That closes on the train at about 5 tiles per second, so a rider starting 60 tiles away catches up in roughly 12 seconds and has room to match speed before the jump. A missed train returns in about 80 seconds. Map size is the hardest value to change later because it is authored in Tiled, so check the feel early in phase 1.

### Map decisions

1. Alpha: all trains share one route. Longer term, selectable and less predictable routes are wanted, and the model already supports several routes per map.
2. The first route is a stadium shape, two long straights joined by two wide U-turns (a closed loop has to turn back), so boarding mostly happens on straights and the first test isolates boarding feel. More curves come after that, and complex tracks with hills are a long-term goal.

## Configuration format

Config is JSON in `packages/content`: one base layer, one overlay file per playtest variant, and named presets that pick a variant from each group. Every file is validated, merged, frozen and hashed before the sim ever sees it.

### Files

```
packages/content/
  base/
    game.json          tick rate, heat, countdown, horse, boarding, combat, ai, carry, outcomePolicy
    items.json         loot types: value, weight, category
    loot-tables.json   weighted tables referenced by trains
    cell-types.json    shared cell definitions: movement, sight, cover, noise
    car-templates.json built from Tiled: layout, entry points, loot slots, guard spawns
    trains/*.json      one file per train type
    maps/*.json        MapDef files
  variants/*.json      one overlay per variant
  presets/*.json       named bundles, e.g. alpha-default
```

### Train definition (example)

Values are placeholders to show the shape. Keys carry units in their names (`Sec`, `Tiles`, `PerSec`).

```json
{
  "schemaVersion": 1,
  "id": "mail-express",
  "name": "Mail Express",
  "favoredStyle": "speed-stealth",
  "speedTilesPerSec": 9,
  "cars": [
    { "template": "engine" },
    { "template": "mail-car", "count": 3 },
    { "template": "caboose" }
  ],
  "countdown": { "baseSec": 150 },
  "guards": { "base": 3, "perWantedLevel": 1, "types": ["guard-light"], "patrol": "car-loop" },
  "passengers": { "count": 0 },
  "loot": { "table": "mail-small-items", "density": 0.6 },
  "verbs": [ { "id": "search", "params": { "searchTimeSec": 1.2 } } ],
  "boarding": { "entryPoints": ["rear-platform", "side-doors"] }
}
```

### Why variants exist, and how config reaches game state

The requirements list playtests (run length, health model, world mode, loot carrying) that must switch without code changes. A variant is a small JSON file holding only the values that differ for one test option, so each test option is a file rather than a code branch.

Config is not part of `GameState`. The sim receives the resolved config as a separate read-only input, and state holds only values that change during play. Config values reach state in three ways:

- **Copied at run start.** `trains.<id>.countdown.baseSec` × `countdown.scale` becomes `run.countdownSec`, and guard counts and loot density decide which entities are created in `entities`. After that, state is the source of truth.
- **Read every tick, never copied.** Heat amounts, meter speed, horse acceleration and drain factors are looked up from config when a system runs. They are not in state because they never change mid-run.
- **Not in state at all.** Train art, car interior layouts and item definitions are templates. Entities refer to them by id.

So most fields in the examples below never appear in `GameState`; the state keeps only counters, positions and ids. A snapshot stores the config hash, not the config, so restoring needs the same config files.

The examples below show the file shapes.

### Variant overlay and preset (examples)

```json
{
  "schemaVersion": 1,
  "id": "health-downed",
  "group": "healthModel",
  "label": "Downed state",
  "question": "Which health model suits the arcade tone?",
  "patch": { "health": { "model": "downed", "downedWindowSec": 6, "downedLosesLootImmediately": false } }
}
```

```json
{
  "schemaVersion": 1,
  "id": "alpha-default",
  "variants": {
    "runLength": "medium", "boardingInput": "meter", "healthModel": "bar",
    "worldMode": "separate", "lootCarry": "limit-and-slowdown", "graceWindow": "medium"
  }
}
```

A preset chooses exactly one variant per group, so two options from the same test can never be active together.

### Variant groups

| Group | Options | What the patch changes |
| --- | --- | --- |
| `runLength` | `short`, `medium` | `countdown.scale` and `loot.densityScale` (U7) |
| `boardingInput` | `meter`, `meter-qte` | `boarding.qte.enabled` |
| `healthModel` | `bar`, `downed` | `health.model`, `health.downedWindowSec` |
| `worldMode` | `continuous`, `separate` | `world.mode` |
| `lootCarry` | `limit-and-slowdown`, `unlimited` | `carry.limitEnabled`, `carry.slowdownEnabled` |
| `graceWindow` | `small`, `medium`, `large` | `countdown.graceSec` |

Additional groups (horse handling, structure preset) follow the same pattern.

### Where each requirement's tuning value lives

| Requirement | Config key |
| --- | --- |
| Boarding meter difficulty | `boarding.meter.speed`, `boarding.meter.zoneWidths` (quick-time prompts, `boarding.qte.*`, come later) |
| Horse handling | `horse.handling`, `horse.maxSpeed`, `horse.accel`, `horse.turnRate` |
| Horse arrival delay | `extraction.arrivalDelaySec` as `[min, max]`, `extraction.paceWindowSec` |
| Countdown length | `trains.<id>.countdown.baseSec` × `countdown.scale` |
| Heat rate | `heat.sources.*`, `heat.heatDrainFactor`, `heat.decayPerSec` |
| Grace window | `countdown.graceSec` |
| Guard counts per wanted level | `wanted.guardBonus` (array indexed by level) and `trains.<id>.guards.perWantedLevel` |
| Loot density | `trains.<id>.loot.density` × `loot.densityScale` |
| Death consequences | `outcomePolicy.*` |
| Tick rate | `sim.tickRateHz` |

### Resolve pipeline

1. Load files and check each `schemaVersion`.
2. Merge `base`, then the chosen variants, then run-time overrides. Objects deep-merge, arrays replace, and a key set to `null` is removed. Two variants from different groups that patch the same path are an error.
3. Validate with strict zod schemas. Unknown keys fail, which catches typos. Cross-references are checked: every train's loot table, car template and verb id must exist, ranges must be ordered, and weights must be positive.
4. Derive values: seconds become integer ticks (timers count whole ticks, so no float drift), cone half-angles become cosine thresholds, and turn rates become per-tick rotation constants.
5. Freeze deeply and compute a hash of the canonical JSON.

The result is a `ResolvedConfig`. Its hash, the preset, the chosen variants and any overrides go into every log header. Config only changes between runs, never during one.

### Selecting a setup

- URL parameters set it for a session: `?preset=alpha-default&v=healthModel:downed&seed=abc123`.
- A debug panel in `apps/game` lists each variant group and its question, and edits individual values as overrides.
- `tools validate` runs steps 1 to 5 on every preset and fails CI on any error.

## Randomness and event logging

One seed string drives every random choice through separate named streams, and each session records both the commands and the events, so any run can be replayed exactly and compared with another.

### Seeded streams

- **Algorithm.** sfc32, a 32-bit generator built only from integer operations, so every JavaScript engine gives the same sequence. The seed string is hashed into four 32-bit words and warmed up for a few rounds.
- **Streams.** `gen` (run generation and loot placement), `schedule` (train spawns), `ai`, `combat`, `horse` and `misc`. Each stream's state is derived from the seed plus the stream name and stored in `GameState.rng`, so snapshots resume mid-sequence.
- **Run seeds.** At each run start the `gen` stream is re-derived from `seed` and the run number. Layout and loot therefore depend only on those two values, not on how earlier runs were played. A `retrySameLayout` option restarts a run with the same run seed so variants can be compared on identical trains.
- **Draw timing.** The horse arrival delay is drawn from the `horse` stream at whistle time, so the Nth whistle on a seed always gets the same delay regardless of what else happened.

```ts
interface Rng {
  next(): number;                        // [0, 1)
  int(min: number, max: number): number; // inclusive
  pick<T>(items: readonly T[]): T;
  weighted<T>(items: readonly T[], weights: readonly number[]): T;
  shuffle<T>(items: T[]): void;          // in place, Fisher-Yates
}
```

### Two logs

1. **Command log, for replay.** Only ticks that have commands are written. Replaying the header plus these lines through `createSim` reproduces the run exactly.
2. **Event log, for analysis.** Every `SimEvent`, filtered by an allowlist in `logging.events`.

Both go to one NDJSON stream. The first line is a header; hashes are interleaved so drift is visible.

```json
{"k":"header","logVersion":1,"gameVersion":"0.1.0","configHash":"9f2c…","preset":"alpha-default",
 "variants":{"healthModel":"downed"},"overrides":{},"seed":"abc123","tickRateHz":60,
 "persistentAtStart":{"wantedLevel":1,"bank":120,"lifetimeEarned":450},"startedAt":"2026-10-09T02:11:40Z"}
{"k":"cmd","t":212,"p":1,"c":[{"t":"move","x":127,"y":0}]}
{"k":"ev","t":640,"e":"BoardingAttempt","result":"good","attempt":1}
{"k":"hash","t":600,"h":"41ab…"}
```

The wall-clock `startedAt` exists only in the header, written by the host. The sim never reads time.

### Alpha events

| Event | Key payload | Used for |
| --- | --- | --- |
| `RunStarted` | run id, train, seed, countdown, wanted level | Grouping and comparing runs |
| `RunPhaseChanged` | from, to | Time spent per phase |
| `BoardingAttempt` | result, attempt number, meter position | Boarding failures, meter difficulty |
| `ShotFired`, `DamageDealt` | actor, target, amount | Combat feel |
| `PlayerSpotted`, `AlarmRaised` | by, car | Stealth success, heat causes |
| `HeatChanged` | heat, delta, cause | Heat tuning |
| `LootPickedUp` | item, value, weight | Loot density, carry tradeoff |
| `ActorDowned`, `ActorKilled` | actor, by | Deaths and retries |
| `HorseWhistled`, `HorseArrived`, `HorseDeparted` | delay drawn, pace window | Extraction tension |
| `RunEnded` | outcome, duration in ticks, countdown left, heat, loot value, boarding attempts, kills | Run length, completion, cancels (with time left, for flag U6) |
| `PersistentChanged` | before, after | Wanted level and bank effects |
| `CommandRejected` | command, reason | Input and UX bugs |

The sim returns events from `step`, and the host forwards them to a sink asynchronously, so logging never runs inside the tick.

### Sinks and reports

- **Sinks.** An in-memory ring buffer for the debug overlay, IndexedDB for sessions that survive a reload (localStorage is too small), and an export button that downloads NDJSON.
- **Replay.** `tools replay log.ndjson` re-runs the commands and checks every logged hash. A game-version or config-hash mismatch is a warning, not a silent pass.
- **Reports.** `tools report` groups logs by the variants in their headers and prints run length, completion rate, boarding failures per run, deaths and retries, cancels with time left, time to first loot and heat at end. These are the candidates for the "playtest criteria" still undefined in the requirements; this design proposes them without setting pass thresholds.

## Renderer, input and UI

The client turns sim state into pixels and device input into commands, and does nothing else. It never decides an outcome: even the boarding meter is sim state that the client only draws.

### Render pipeline

- **Inputs to the renderer.** The live read-only `sim.state`, plus the `SimEvent[]` from each tick for one-shot effects such as muzzle flashes, hit flashes, screen shake and sounds.
- **Interpolation.** After each tick the client copies positions of visible actors into a small typed-array buffer and keeps the previous one. Each frame draws a lerp between them using the accumulator remainder. The client never clones whole state.
- **Projection.** One pure module, `projection.ts`, with `worldToScreen(x, y, layer)` and `screenToWorld`. The default is 2:1 isometric with placeholder 64×32 px tiles, and both functions take the camera zoom.
- **Draw order.** Sort by depth (`x + y`, plus a per-layer offset) using Pixi's sortable containers. In continuous mode, roof sprites fade out while the player's layer is `interior` inside that car. Occlusion is a list of rules in client config, so more can be added after the roof fade: the first extra is an x-ray silhouette for the player behind walls.
- **Placeholder art.** Shapes drawn once into textures through a `DrawableFactory` keyed by entity kind. Pixel art swaps in by changing the manifest. A 3D renderer implements the same factory idea.
- **Camera.** Fixed angle, zoom levels from config (for example three steps), smoothed follow on the player. In separate mode it follows the car frame.

### Trains and boarding cues on the world map

In separate mode the player is never inside a car in the world view, so cars there are always drawn closed. The roof fade belongs to the continuous mode only.

- **Placement.** The sim gives each car a distance along the route. The client looks up the position and unit tangent for that distance and projects them through `projection.ts`, so cars follow the bends and stay rigid. Positions are interpolated between ticks like any actor.
- **Placeholder look.** Each car is a flat-shaded box with a top face and two visible sides, tinted by car type, with a small mark for the front. Cars are about 16 × 6 tiles, so the engine plus three cars is about 62 tiles long.
- **Depth sorting.** A long car sorted by one centre point can draw in front of or behind the horse wrongly. Each car is therefore drawn as slices about two tiles long, and the slices sort individually against the horse and other objects.
- **Entry markers.** The sim computes each entry point's world position (the car's place on the route plus an offset across the track), and the boarding check and the markers both use that value, so what you see is what the rule tests. Only the side you are riding on shows markers, and a train that restricts boarding shows only its allowed entry points.
  - dim when out of range
  - a ring when in range but the speed is off
  - highlighted when the jump is allowed
- **Speed readout.** A small indicator beside the player shows too fast, too slow or matched. It gives the same reasons the HUD shows when `jump` is rejected.
- **Off-screen trains.** About 45 tiles are visible across and 56 deep at default zoom (placeholder 64 × 32 px tiles on a laptop screen), and the starting gap is about 60 tiles. Edge arrows with a distance point to trains that are off screen, with the committed train highlighted.
- **Look-ahead camera.** The camera leads the horse along its velocity, scaled by speed, clamped and smoothed, so at 14 tiles per second the player sees more road than a few seconds. The zoomed-out level is set to show most of the approach.
- **Boarding transition.** On a successful jump the camera starts at the marker's screen position and eases into the interior scene at the matching entry cell. On failure the world view stays, the horse is stunned and the train pulls ahead.
- **Later.** Pre-drawn sprites for a set of directions per car type, using the nearest direction on bends. A 3D renderer would place models from the same distance and tangent data.

### Input

```ts
interface InputSource {
  poll(): InputSnapshot;      // devices report state; no game logic here
}
// InputMapper: InputSnapshot[] + renderer.screenToWorld → Command[] for this tick
```

- Keyboard and mouse are the only sources in the alpha, and a laptop touchpad counts as a mouse. To keep the touchpad playable, every action has a keyboard binding, nothing requires right-click, middle-click or the scroll wheel (zoom has keys too), no core action needs click-and-drag, and aim uses the absolute pointer position, never pointer lock. Gamepad and touch later implement `InputSource` and produce the same commands.
- Aim is a world-space direction computed from the mouse through `screenToWorld`. The sim never sees the screen.
- Bindings live in client settings, not sim config.
- Hold actions (inspect, vault, search) use `interact` with `held: true`, so they also work with a touch press-and-hold.
- Pointer Events are used instead of mouse events, and nothing essential depends on hover.

### HUD and menus

The HUD, variant picker and debug panels are an HTML/CSS overlay above the canvas, driven from sim state. This keeps text sharp, makes scaling and accessibility easier, and suits small screens later. In-world markers (sight cones in debug mode, interaction prompts) stay in Pixi.

### Minimum feedback so countdown and heat read clearly

This addresses an open item in the requirements. The proposal is deliberately small:

- A countdown bar with colour steps and a per-second tick sound that speeds up below 20 percent of the time.
- A heat meter with three bands, a pulsing red screen edge and an alarm sting when an alarm is raised.
- Distinct sounds for shots, boarding success and failure, whistle, horse arrival and extraction.
- A small text notice for each heat gain, so playtesters can see what raised it.

Sounds are synthesized placeholders behind an `AudioBus` that maps events to sound ids.

### Performance and debugging

- Pool projectiles and particles, batch sprites into atlases, and keep per-frame allocations near zero.
- When a frame runs long, the client drops effects before it drops ticks. A quality tier setting controls particles and shadows.
- A debug overlay shows fps, tick time, entity counts, heat, countdown, seed and config hash. It also draws sight cones and collision shapes, and offers pause, single-step and 0.25× speed (the unflagged baseline-hardware item needs a reference machine to tune against).

## Keeping multiplayer, 3D and mobile open

The alpha builds none of these features, but a small set of structural choices keeps each one a later addition instead of a rewrite. Each choice below costs little now.

### Multiplayer (gang play)

**Do now**

- Every command and every player-owned entity carries a `PlayerId`. State has `players: Record<PlayerId, PlayerState>` with one entry, and the run state is split into shared parts (countdown, heat, train) and per-player parts (health, carried loot).
- `createSim` returns an instance with no globals, so a server can host many.
- Commands are tick-stamped and the host owns the clock, which is exactly what a server needs.
- State is flat and plain, so snapshots are cheap enough for client-side prediction: the client rewinds to the last server snapshot, then replays its own pending commands.
- The model is server-authoritative with prediction, not lockstep. Small float differences between browsers then only cause minor corrections, and that is why plain floats are acceptable.

**Deferred:** transport, lobbies, lag compensation, anti-cheat, accounts and per-player saves, and the design questions of how loot splits and whose heat counts.

### 3D

**Do now**

- The sim is logical 2D plus layers. A 3D renderer maps `(x, y, layer)` to a position in 3D space and uses the same events.
- The renderer sits behind a narrow interface (`init`, `applyView`, `handleEvents`, `resize`, `dispose`) plus `screenToWorld`. The Pixi implementation is the first; a Three.js one can be added in `client` or a sibling package.
- Aim commands are world-space directions, so camera rotation does not affect the sim. The input mapper asks the active renderer for `screenToWorld`.
- Animation timing belongs to the renderer. The sim exposes an action state and the tick it started, and melee hit timing never depends on an animation frame.

**Deferred:** vertical movement, 3D collision, camera rotation and the occlusion problems that come with it, and 3D art.

### Mobile browsers

**Do now**

- Commands are intent-based: an analog move vector, an aim direction, and buttons. Nothing requires a mouse pointer or hover.
- Hold actions use `interact` with `held`, and the boarding meter needs only a single press.
- HUD sizes use relative units and respect safe areas. Required information is never in a hover tooltip.
- Pointer Events replace mouse events. The host pauses on `visibilitychange`.
- Texture atlases stay within 2048 px per side, and draw calls and overdraw are budgeted from the start (the exact budget needs the reference device).

**Deferred:** touch controls and layout, tuning quick-time prompts for touch, thermal and battery behaviour, audio unlock flows and any native wrapper. A wrapper such as Capacitor would only need to host the same game loop, because the sim is plain TypeScript.

### Tripwires to review in code review

Any of these appearing in a pull request breaks one of the three openings:

- A class instance, `Map`, `Set` or function stored in `GameState`.
- A sim import of `window`, `document`, `pixi.js` or `node:*`.
- A screen-space coordinate or a key code inside a `Command`.
- A system that reads `Date`, `Math.random`, or the wall clock.
- A module-level mutable variable in `packages/sim`.
- Logic that depends on a sprite frame or animation length.

## Persistence, build order and testing

The build follows the requirements' five phases, preceded by a foundation phase that makes every later playtest comparable. Each phase is playable and ends on the gate the requirements already set.

### Persistence

- The host owns saving through a `PersistentStore` interface (`load`, `save`, both async). The alpha uses a `LocalStorageStore`; an account-backed store replaces it later.
- Stored under a versioned key: `wantedLevel`, `bank`, `lifetimeEarned` (C2), plus a local leaderboard list holding score, seed, config hash, variants and date.
- The sim never does I/O. It receives `PersistentState` at creation and emits `PersistentChanged` at run end, and the host saves on that event.
- An unreadable or newer-version save is backed up under a second key and replaced with defaults, with a visible notice.

### Build order

| Phase | What gets built | Gate |
| --- | --- | --- |
| 0. Foundation | Monorepo and CI rules, sim skeleton with tick loop, RNG, snapshot and hash, config pipeline with `tools validate`, command and event logging with replay, debug overlay, blank Pixi scene | A golden replay passes in CI and a variant can be switched from the URL. This phase is new; the requirements don't list it. |
| 1. Riding and boarding | One map, one blank train, horse, boarding meter, failure and cancel rules, `WorldModel` with the separate-map implementation | Riding and boarding is fun before any loot exists |
| 2. Mail/express | Countdown, heat, loot, carry flags, extraction with horse delay, wanted level, outcome policy, persistence, the continuous-world implementation (so the world-structure test can run), run-length variants | Compare short and medium runs and pick a target length |
| 3. Military payroll | Perception and AI, combat, health bar and the downed variant | Combat feels good and the health variants are compared |
| 4. Passenger hold-up | `inspect` verb, passenger behaviour, armed passengers | Judging passengers is a decision, not a chore |
| 5. Bank | `vault` verb, guard interruptions | The minigame holds up under time pressure, and each train favours a style while other approaches still work |

After the prototype come the cargo and tycoon trains, the later trains, progression, 3D and online multiplayer, in that order. The reference machine is a 2019 MacBook Pro (6-core Intel i7, integrated Intel UHD 630 graphics, 16 GB RAM). Record a baseline in both Chrome and Safari before phase 2, because the 30 fps floor needs one. Integrated graphics make overdraw and fill rate the main rendering risk, so the performance budget should be set on this machine first.

### Testing

- **Unit tests** for pure systems and for `applyOutcome`, using a table of outcome and policy cases.
- **Golden runs**: one scripted run per train, with its final state hash stored. A changed hash is a deliberate update or a bug.
- **Snapshot equality**: snapshot, restore, continue must match an uninterrupted run.
- **Config tests**: every preset resolves, and malformed fixtures fail with the expected file and path.
- **Headless bots** from `tools`: an idle bot (must expire), a random-walk bot, and a scripted looter, each over 1,000 seeds. They check invariants such as heat in range, carried weight within the limit when it is enabled, and no crashes. They also give a first read on expiry rates.
- **Performance**: a tick-time benchmark in CI with a threshold. Frame time is checked by hand on the reference machine.
- **Playtest loop**: choose a preset, play, export the log, and compare variants with `tools report`.

### Decisions needed first

1. U1 is decided: the run and countdown start when you commit to a train, not at boarding.
2. U8 is decided: the alpha starts with the separate train map as defined in the World model section, and the continuous world stays supported.
3. C2 is decided for the alpha: persist wanted level, bank and lifetime earned. More values are expected later, and the reserved upgrades field and the versioned save format leave room for them.
4. C1 can wait for playtests: whether a downed player who recovers keeps their loot is a config flag (downedLosesLootImmediately, default off). C4 is decided: the bank's top prize requires the vault minigame, and the rest of the bank's loot is open to any approach.
5. The reference machine for the performance targets is decided: a 2019 MacBook Pro (2.6 GHz 6-core Intel Core i7, Intel UHD Graphics 630 with 1536 MB, 16 GB RAM). Browsers: Chrome and Safari.

## Phase 0 and 1 starting spec

This section turns the decisions so far into what to build first: the foundation (phase 0) and riding and boarding (phase 1). Numbers are placeholders for tuning.

### Decisions

- **Committing to a train.** Ride toward a train. When one is within `commit.rangeTiles`, a prompt appears, and pressing the interact key sends `startRun` with that train's id. The sim validates the range and that the train is free, and the run and countdown start (U1). The rule lives in the sim, so the client only asks it which train, if any, can be committed.
- **Boarding jump rules.** The jump is allowed only when the player is within `boarding.rangeTiles` of an entry point on the right side and within `boarding.speedToleranceTilesPerSec` of the train's speed. Otherwise `jump` is rejected and the HUD says why (too far, too fast, or too slow). When allowed, the meter decides the landing.
- **Failure cost.** A failed jump always costs time, and damage is a toggle. A failed player is thrown clear and the horse is stunned for `boarding.failure.stunSec`, so the train pulls ahead before a retry. Damage is `boarding.failure.damageFraction` of max health. A variant group `boardingFailure` has `time-and-damage` and `time-only` (damage fraction 0). Phase 1 includes a minimal health value so the failure and death paths are real; the full health system waits for phase 3.
- **No countdown in phase 1.** The countdown and heat arrive in phase 2, so `countdown.enabled` is false until then. Cancel works from the start.

* **Horse and train collision.** Cars are solid. The horse stops or slides along a car's side, so it cannot ride through a train. The riding system collides the horse against each car's rectangle, computed from the car's place on the route.
* **Boarding meter use.** While the player is eligible (in range and speed matched), the meter sweeps continuously and a single Space press samples it on that tick. Losing eligibility resets the meter.
* **Ending a phase 1 run.** After boarding, the player can walk the blank interior. Esc cancels the run and puts the player and horse back at the spawn while the train keeps looping.
* **Repo.** A new repository using the monorepo layout from Package structure, with this document moved into `docs/`.

### Riding controls

Steering plus throttle, because a keyboard cannot otherwise hold a speed of 9 when the horse tops out at 14. The `move` command's x axis steers relative to the horse's heading, not the screen, so it works the same on a straight, a U-turn or any track direction, and its y axis is throttle: positive accelerates, negative brakes, and releasing coasts to a stop under drag. The `handlingModel` variants (stamina, speed tiers) can reinterpret the same commands later. A screen-relative steering variant, where direction keys set the target heading on screen and throttle is separate, is worth playtesting because heading-relative steering can feel odd in an isometric view.

| Input | Action |
| --- | --- |
| A / D | Steer |
| W / S | Accelerate / brake |
| Space | Boarding jump (and mount jump later) |
| E | Commit to a train, interact |
| F | Whistle (phase 2) |
| Esc | Cancel run |
| Q / Z or keys `-` / `=` | Zoom out / in |

Mouse aim and fire arrive with combat in phase 3. A touchpad needs only the keys above, in line with the input rules earlier.

### Starting values

| Value | Placeholder | Config key |
| --- | --- | --- |
| Commit range | 12 tiles | `commit.rangeTiles` |
| Boarding range from an entry point | 2 tiles | `boarding.rangeTiles` |
| Speed match tolerance | 1.5 tiles/s | `boarding.speedToleranceTilesPerSec` |
| Meter sweep period | 1.2 s | `boarding.meter.sweepPeriodSec` |
| Meter zone widths (perfect, good) | 10%, 25% of the track | `boarding.meter.zoneWidths` |
| Failure stun | 1.5 s | `boarding.failure.stunSec` |
| Failure damage | 25% of max health | `boarding.failure.damageFraction` |
| Max health | 100 | `health.max` |
| Horse top speed | 14 tiles/s | `horse.maxSpeed` |
| Horse acceleration, braking | 8 and 12 tiles/s² | `horse.accel`, `horse.brake` |
| Horse turn rate | 120°/s (converted to a per-tick rotation at resolve) | `horse.turnRateDegPerSec` |
| Train | engine plus 3 cars, 9 tiles/s | `trains.blank` |
| Tick rate | 60 Hz | `sim.tickRateHz` |

Landing results: a perfect landing arrives clean, a good landing arrives with a short stumble (a brief slowdown), and anything else is a failure.

### RngState

The state that snapshots store for the seeded streams (see Randomness and logging):

```ts
type StreamName = 'gen' | 'schedule' | 'ai' | 'combat' | 'horse' | 'misc';
type RngState = Record<StreamName, [number, number, number, number]>;  // sfc32: four uint32 words per stream
```

### Implementation status (2026-10-08)

Repo: `devlinjunker/train-robber`, branch `phase-0-scaffold`. Legend: `[x]` done, `[~]` partly done, `[ ]` not started. This repo copy of the document is now the source of truth; the earlier live Claude Doc is a snapshot.

### Phase 0 checklist

- [x] Monorepo, TypeScript project references, and the lint rules that ban `Date`, `Math.random` and transcendental `Math` in `packages/sim`
- [~] Dependency check and CI running lint, tests and `tools validate` (CI runs typecheck, lint, tests and build; dependency check and `tools validate` still to do)
- [x] Sim skeleton: tick loop, state types, command and event types, RNG streams, snapshot and hash (minimal; grows with phase 1)
- [~] Config pipeline: schemas, merge, resolve, hash, `tools validate` (stub tuning schema with merge, strict validation and hash; resolve step and `tools validate` still to do)
- [ ] Command and event log with header, an IndexedDB sink, and `tools replay`
- [x] Golden-run test and snapshot round-trip test (golden is a hash snapshot; replace with a checked-in replay once the log exists)
- [~] Blank PixiJS scene with the debug overlay (fps, tick time, seed, config hash) (shows tick, fps, state hash; seed, config hash and tick time still to add)
- [ ] Minimal `tools build-maps` for the phase 1 map

### Phase 1 checklist

- [ ] Phase 1 Tiled map: flat terrain, one stadium-shaped route, spawn markers
- [ ] Horse riding with steering, throttle and drag
- [ ] Train and track simulation: an engine plus three blank cars moving along the route, looping
- [ ] Commit prompt and `startRun`
- [ ] Boarding rules, meter, success and failure, and the stun
- [ ] Minimal health, death outcome, and cancel
- [ ] Separate-mode train scene and the camera transition
- [ ] HUD: commit prompt, jump rejection reasons, meter, health
- [ ] Logging of boarding attempts and run outcomes
- [ ] Playtest against the gate: riding and boarding is fun before any loot exists
