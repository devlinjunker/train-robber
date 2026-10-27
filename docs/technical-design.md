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

- TypeScript (strict), npm workspaces, Vite, Vitest.
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
| U3 | What counts as "already jumping off" for the grace window? | The grace window cannot be implemented without a trigger. | Grace applies while the horse is alongside and the player is within reach of a door on its side (decided 2026-10-11 in the Phase 2 plan review: the mount jump resolves on the tick Space is pressed, so "started the mount action" would almost never apply). Expiry then waits up to the window, so the player gets a last try or two. Window length is config, with 3 s as a placeholder. |
| U4 | Horse extraction details | Can you whistle again? What if you miss the pacing window? Does mounting use a timing meter? Is the arrival time shown? | One whistle arms the horse. When the player boards, the riderless horse runs off away from the track and is removed from the world once out of view (decided 2026-10-11 in the PR #14 review, replacing the scripted lane horse). The whistle puts it back in the world as a physical body behind the train, on the player's side, at a seeded distance that takes 5 to 20 s to close; it then rides up beside the player's car, steering around rocks, water and slow ground like any rider. The horse paces for a set window, then drops away, and a re-whistle is allowed after a cooldown. Mounting reuses the boarding meter at its own difficulty. The delay is not shown as a number by default, but the horse is visible riding up from behind the train with hoofbeats when close (no arrival timer: G11, confirmed in the M4 playtest). The horse comes up on the side of the car the player is nearest when they whistle; pressing the whistle again while it is on its way or alongside sends it to the other side if the player has moved there, and it crosses behind the last car to get there. Mount results: perfect mounts clean; good mounts but spills loot (`mountSpill`); a failure leaves the player on the train, stumbling with the usual failure damage, free to retry while the horse is alongside (all decided 2026-10-11). |
| U5 | Death and wanted level | Expiry adds a wanted level and cancel adds none. Death is not stated. | Death adds none by default. Each outcome has its own `wantedDelta` in config. |
| U6 | Cancel loophole | Cancel loses loot but adds no wanted level, so cancelling just before expiry dodges the penalty. The doc defers this to playtests. | Keep the requirement, but log cancels with countdown remaining so abuse is measurable. Config: `cancelWantedDelta` and a `cancelPenaltyBelowSec` threshold, both off. |
| U7 | Run-length variant scope | Short (2–5 min) vs medium (8–15 min) could be global or per train, and countdown is also per train. | A global profile scales each train's base countdown and loot density. Per-train values stay overridable. The minute ranges are test outcomes, not inputs. The profile is the plain value `countdown.scale` (with `loot.densityScale`), not a named variant. Train length (car count) and search pace (search time, hidden loot) are separate values, so a playtest can tell which change made a run better (decided 2026-10-11). |
| U8 | What is a "separate train map"? | The alpha map already holds the train and its interior, so the variant needs a definition. | See World model: the interior runs in a train-local frame, and the world becomes a lightweight backdrop. Confirmed: build the separate map first. |
| U9 | Sim tick rate | A fixed timestep is required, but no rate is given, and the floor is 30 fps. | 60 Hz, so timing windows resolve to about 17 ms. A 30 fps device runs two ticks per frame. |
| U10 | Combat data model | Knock-outs, ammo and healing items are open, but they shape the state schema. | Reserve the fields now: `incapacitated` on actors, nullable `ammo` (null means unlimited), and healing as a weighted loot category. Alpha default: unlimited ammo, no knock-outs. |
| U11 | Wanted level scale | "A few levels" and decay are undefined. | Levels 0–5, with a config table of extra guards per level. Decay is off. Phase 2 has no way for wanted level to come down (Reset save while playtesting); a way down, such as a clean getaway lowering it by one or decay, is required before progression (decided 2026-10-11). A `wanted.forceLevel` option (preset or `?wanted=`) sets the level a run uses; such runs are practice and save nothing. |
| U12 | Logging vs replay | Seeded runs must be replayable, but the logged events listed are only summary events. | Log two streams: commands (for exact replay) and events (for analysis). The log header holds the seed, config hash and persistent state at start. |

Not flagged as blockers, but still open: baseline hardware for the 30/60 fps targets (needs picking before phase 2), the timetable's absence from the alpha (trains are simply visible on the map, and the schedule data model leaves room), and when loot is cashed out (default: the moment the extraction mount completes).

## Package structure and repo layout

The repo is an npm workspaces monorepo with five packages, and one rule matters most: `sim` and `config` never import anything from the browser or from PixiJS.

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
  | { type: 'move'; x: number; y: number }       // axes quantized to -127..127
  | { type: 'steer'; x: number; y: number }      // world-space heading target for screen-relative steering, quantized
  | { type: 'aim'; x: number; y: number }        // world-space direction, quantized
  | { type: 'fire' } | { type: 'melee' }
  | { type: 'interact'; held: boolean }          // loot, inspect, hold up, crack vault
  | { type: 'jump' }                             // boarding and mounting meter press
  | { type: 'whistle' }
  | { type: 'qte'; key: number }                 // only when quick-time prompts are enabled
  | { type: 'useItem'; slot: number }
  | { type: 'drop'; slot: number }                // drop a carried item, to swap for another (phase 2)
  | { type: 'startRun'; trainId?: string }       // commit to a train (flag U1)
  | { type: 'switchTrain'; trainId?: string }    // move the run to another free train, keeping its timer
  | { type: 'cancelRun' }
  | { type: 'quickRetry' };                      // playtest only (`playtest.quickRetry`): end the run, wait behind the train
```

The sim validates every command against current state (a `jump` outside the boarding phase is ignored and emits `CommandRejected`). Quantizing axes means two inputs either match exactly or differ, which makes replay comparison and later network compression simple. The discriminant is `type`, because `t` means the tick in log lines.

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
5. Movement and collision: on-board actors in car frames; then 5a, roofs (ladders, roof walking, gap jumps and slips), and 5b, trackside rocks on a ledge.
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
| Extraction | Horse call, mount | The whistle places the physical horse behind the train at a seeded catch-up distance, and it rides alongside the player's car on the player's side, steering around terrain (U4). The horse paces for a window, then drops away. Mounting uses the boarding meter at its own difficulty. | `extraction.*` |
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
    "actorKilled": 8, "lootTaken": 1, "timeAboardPerSec": 0.33
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
| Horse while aboard | Physical body riding beside the train, obstacles and all | Was planned as an abstract timer state. Since M4 the client draws the world aboard, and a horse ignoring rocks would look wrong there, so phase 2 makes it physical whenever it is in the world: it runs off and is removed after boarding, and the whistle places it behind the train to ride up (`horseWhileAboard: 'physical'`, decided 2026-10-11) |
| Boarding and mounting | World ↔ car frame transform at an entry point | Same |
| Renderer scene | One scene; camera follows the player across the map; roofs fade | Interior scene with cars laid end to end; a scrolling backdrop stands in for scenery |
| Extra content | None | Interior scene layout per train, plus a backdrop loop |
| Main cost | Horse and obstacle simulation continues while aboard; more occlusion cases | Extraction feels less physical; backdrop art |
| What the test answers | Is one world more fun? | Is it easier to build and tune? |

The map file is the same for both. The separate mode simply stops drawing terrain once the player boards.

### Cost of adding continuous later

The alpha starts with the separate map, and the continuous world is more work than it. It does not need a redesign, because the train, track, car frames, on-board systems and config schema are shared. The extra work is in four places:

- **A physical horse while aboard.** Built in phase 2 for the separate mode as well (see Phase 2 starting spec), so this cost is paid early. Being hurt comes with combat.
- **Real terrain along the whole track.** Rocks, rivers and slow zones only matter near the approach in separate mode. In continuous they matter for the entire run, so the map needs finished content and collision along the full loop.
- **A second renderer scene.** One large scene with a camera that follows the player, the train moving through scenery, and culling so only nearby terrain is drawn. Roof fading is no longer the only occlusion case.
- **Tuning and tests twice.** Golden runs and balance checks must cover both modes, because the horse timing differs between them. The world-structure playtest only works once both exist.

### Map and schedule data

- **MapDef** holds the tile size, a terrain grid of zone ids (open, slow, blocked, water, deep), a track polyline with an arc-length table (a closed loop, or since G3 an open line), spawn points for the player and horse, and render-only scenery.
- **Trains** are entities with a type id, an arc-length position and a speed. A train that a run has targeted is pinned: it cannot despawn or leave the loop until the run ends. On an open line a pinned train is never removed either; if it reaches the end of the line, the run ends (see Open line).
- **Schedule** is a deterministic function of the `schedule` RNG stream and three config values (`frequencySec`, `maxConcurrent`, `typeWeights`). A missed train comes back around because the track is a loop. A future timetable is a read-only view over the upcoming schedule, so the data model already supports it.

### Deliberately not supported

The requirements have no way to leave a moving train except mounting the horse, so walking on the ground mid-run is out. The frame model would allow it later by calling `leaveTrain` without a mount.

## Map design

The alpha map is drawn in Tiled and converted to our own `MapDef` format: a tile grid for terrain, one or more curved track routes, and a few markers. Decided so far: Tiled for authoring, a tile grid plus polyline tracks, a flat approach area for phase 1, and a stadium-shaped first route that is mostly straight (more curves, then hills, later).

### Authoring pipeline

- The Tiled file lives in `packages/content/maps-src/`. Its `terrain` tile layer sets a `zone` property per tile (`open`, `slow`, `blocked`, `water`, `deep`). A `track` object layer holds one polyline per route, and a speedZones layer holds rectangles that slow the train. A `markers` layer holds named points such as `playerSpawn`. Scenery layers are render-only and ignored by the sim.
- `tools build-maps` converts the Tiled file into `base/maps/<id>.json`, validated by the config schemas. The game never reads Tiled files at runtime, so the sim does not depend on Tiled's format. CI runs the conversion.

### Tiled workflow in detail

Tiled is only an editor. You draw, save a `.tmj` file, and the converter writes the map file the game reads. Layer names matter because the converter finds layers by name.

**One-time setup**

1. Create `alpha-flats.tmj` in `packages/content/maps-src/`, orthogonal (top-down) orientation, 400 × 200 tiles, fixed size (not infinite). Use a 32 px tile for editing only; one Tiled tile is one sim tile.
2. Add a placeholder tileset `zones` with five coloured tiles. Give each tile a custom string property `zone` set to `open`, `slow`, `blocked`, `water` or `deep`.
3. Add the layers: `terrain` (tile layer), `track` (object layer), `speedZones` (object layer), `markers` (object layer), and any number of render-only layers whose names start with `scenery`.

**What you draw**

- **Terrain.** Paint the `terrain` layer with the zone tiles. An unpainted tile counts as `open`.
- **Track.** On `track`, use the Insert Polyline tool and click control points. The curve passes through them, so the line you draw is roughly the track. Fewer points give a smoother curve. Add custom properties `route` (string, for example `main`) and `closed` (boolean).
- **Speed zones.** On `speedZones`, draw rectangles with a float property `speedScale` between 0 and 1. Any stretch of track inside a rectangle runs at that fraction of normal speed.
- **Markers.** On `markers`, place a point object named `playerSpawn`. The player starts there already mounted (see Map decisions).
- **Scenery.** On any object layer whose name starts with `scenery`, give each object a class (or a `kind` property). A point is one `tree`, `pine`, `bush` or `flowers`; a rectangle, ellipse or polygon scatters them over the tiles inside it (an optional `density` in items per tile, and several kinds separated by commas). Trees and pines only go on `blocked` tiles and bushes and flowers only on `open` ones, so the terrain still decides where the horse can go. A `bridge` rectangle draws a plank deck over the open tiles where a river meets the track (`along` is `x` or `y`, the way you cross). Shallow `water` is wadeable and `deep` water is not, so paint a lake or river with a shallow edge and a deep core, and leave shallow fords where the horse should cross.
- **Ground cover.** Grass tufts and scrub brush are not in the map: the iso view scatters them over open ground, away from the track, from a new random seed on each load (`?groundSeed=` repeats one, `?groundCover=off` drops them). A few thick patches grow denser and taller. They never slow the horse. Trees in front of the horse fade while they cover it, and a lone tree is drawn bigger so it reads as an obstacle. The minimap and debug panel start hidden (`?minimap=on`, `?debug=on`, or M and `).

**What `tools build-maps` does**

1. Reads the `.tmj` and checks that every required layer exists and has the right type.
2. Converts `terrain` to zone ids through the tileset property and run-length encodes the grid.
3. Converts each polyline from pixels to tile units. Both Tiled and the sim have y pointing down, so no flip is needed. The renderer does the isometric projection later.
4. Smooths each route with a Catmull-Rom curve (wrapping around for closed routes) and samples it into segments about half a tile long. Each sample stores its position, distance along the route, unit tangent and speed scale (the lowest value of any overlapping zone). These baked samples are what the sim reads, so no spline maths runs in the game.
5. Copies the markers, and builds the `scenery` layers into a separate render-only file, `base/scenery/<id>.json` (`SceneryDef`: items as columns and bridges), with the same source hash. Area scatter is a fixed hash of the object and tile, so a rebuild places the same items.
6. Runs the checks below and writes `base/maps/alpha-flats.json` with a hash of the source file, so a stale output is detectable.

**Checks (errors unless noted)**

- Every route has at least two points, or three if closed, and every sample is inside the map.
- No sample lies on a `blocked` or `water` tile.
- `playerSpawn` is inside the map on an `open` tile.
- `speedScale` is greater than 0 and at most 1.
- A scenery point sits on a tile its kind allows; a bridge covers no `blocked` or `water` tile; every kind is known.
- Warning: the curve's radius is smaller than the longest car. Cars are rigid rectangles along the track, so a very tight bend would make them cut corners.

**Junctions (segments and services).** Track that two loops share is drawn once, as segments, and each loop is a service that lists them. A map can mix this with ordinary routes.

- On `track`, draw each segment as an open polyline with a string property `segment` (its id). Ends that should join go within half a tile of each other; every place where segment ends meet is a junction. Draw the first and last points of each branch roughly in line with the track it joins (within 25 degrees).
- Add an object layer `services` with one point object per service: `route` (its id), `path` (segment ids in order, for example `main-north west-cut`), and optionally `trains`, `trainType` and `trainOffset` (tiles from the start of the path for the first train).
- The build gives each junction one tangent (the trunk's direction where one track splits into two or two join), bakes each segment once along it, and joins each service's segments into a closed route with `legs` (segment, start, length, from and to junction). Errors name the segment or junction: a path that doesn't join up or close, an unknown or unused segment, an end that meets nothing, or a branch too far off its junction's direction.
- In the sim a train always runs on one service. One tile before a split, with every car still on the shared segment, it picks a branch with a seeded draw from the `schedule` stream and moves onto a service through it, so its cars never jump and replays stay exact. It skips a branch that would bring it within 12 tiles of another train (`JUNCTION_GAP_TILES`) where that branch next rejoins shared track, falling back to the roomiest branch. There are no signals and every train keeps its speed (decided 2026-10-11; signals and speed changes come later).

**Edit loop.** `npm run maps:watch` rebuilds every map when a `.tmj` or tileset in `maps-src` is saved, and the dev server (`npm run dev`) reloads the page. Loading `?map=alpha-flats` selects a map (the default); the game validates it with `MapDefSchema` and shows its id in the debug overlay. The map overlay (toggle with O, zoom with the mouse wheel) draws zones, speed zones, markers, route control points, the baked samples and a tangent tick every eighth sample, in the top-down debug view (V switches to it; the isometric view has its own copy of the overlay, off until O), so you can check what the converter produced against what you drew.

**Notes**

- Author in Tiled's orthogonal mode. Its isometric mode uses a different coordinate unit for objects, which would complicate the converter for no gain.
- Tiled cannot attach properties to individual polyline vertices, which is why slow stretches use rectangles.
- Elevation (added 2026-10-12, view only): an optional `elevation` tile layer painted with the `elevation.tsj` tileset (levels 0 to 8, 0.6 tiles of height each) becomes `MapDef.elevation`. The sim never reads it. A step of one level is a slope you can ride; two or more is a cliff, and the converter blocks the tile on top of it so the flat sim keeps riders off the edge. The track and six tiles either side must stay at level 0 for now, so rails and cars are not lifted and a car swinging wide on a curve never cuts into a slope. In the iso view, raised ground with a cliff all round is drawn as a mesa (rounded outline, banded cliffs, a see-through hole when it hides the horse). Height that changes riding (slopes, ledges, track grades) is on the wiki Ideas page.

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
  "markers": { "playerSpawn": { "x": 60, "y": 40 } }
}
```

### Track model

- Each route is a list of points. At build time the tool smooths it into a curve and samples it into short straight segments with an arc-length table and a precomputed unit tangent per segment. The sim therefore does no spline math per tick, and curves work from phase 1.
- A map can hold several routes. A route is a closed loop or an open line. A train type names the route it runs on in its config, so trains do not have to share one oval. The alpha uses one shared route (see Map decisions). A map can also place its own trains: a track object's `trains` property (a count) and optional `trainType` (default `mail-express`) become a `trains` list in the MapDef, each entry a type, a route and a starting distance, and the sim starts those trains instead of the one mail train. Trains never change route; junctions are not designed yet.
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

**As built in phase 2 M2.** `base/car-templates.json` is `{ schemaVersion, generatedBy, cars: { <id>: template } }`. Each template stores `legend` (the cell type ids it uses, in catalog order) and `cells` as `[count, legendIndex]` runs, so a reordered catalog never changes a car. It also stores `entryPoints`, `lootSlots`, `guardSpawns`, `patrols` (name to cell list), `roofAccess`, `corridor` and `source` (file and hash). End doors are entry points with side `front` or `rear` on rows 2 to 4, and walking through one carries the player into the next car's frame, so the whole train is one interior. Only `left` and `right` entry points are boarding doors. The starter set (28 × 7 since sneaking PR 1) is `mail-car-a` (side doors on both sides), `mail-car-b` (left side only), `mail-car-c` (end doors only), a 16-column `engine` with no doors, a 12-column `caboose` with a front end door, and a `blank-car` with doors mid-car on both sides and no loot. The older 16 × 6 set is kept as `small-*` layouts (car types `small-mail-car` and `small-blank-car`), used by `?preset=small-cars`. Loot slots use the tags `small` and `large`, plus `hidden`; an item fits a slot when one of its `slotTags` is among the slot's tags. Cell types also carry a `colour` for the tileset and the placeholder renderer.

### Car Tiled workflow in detail

Cars use the same approach as the map: Tiled is only the editor, and a converter turns each `.tmj` into data the game reads.

**One-time setup**

1. Create `packages/content/cars-src/` with one `.tmj` per layout, for example `mail-car-a.tmj`. Use orthogonal orientation, a 32 px tile, and a fixed size equal to the car's cells. Add a map property `carType` (for example `mail-car`). A train's config picks cars by `carType`, and the seeded `gen` stream picks one of that type's layouts.
2. Add the `cars` tileset with one tile per cell type, each with a string property `cellType` equal to a catalog id, and coloured placeholder art. `tools sync-car-tileset` generates this tileset from `cell-types.json`, so the tileset cannot drift from the catalog. Adding a new cell type is therefore one catalog entry and one sync.
3. Add the layers: `cells` (tile layer), and object layers named `entryPoints`, `lootSlots`, `guardSpawns` and `patrol`. A `seats` object layer is reserved for the passenger car in phase 4.

**What you draw**

- **Cells.** Paint every cell on `cells`: walls around the edge, floor inside, then props (crates, barrels, benches, rugs, windows, doors). An unpainted cell is an error, unlike the map, because a hole in a car is never intended.
- **Entry points.** Point objects on `entryPoints`. The object name is the id (`side-left`), and a string property `side` is `left`, `right`, `front` or `rear`. Each sits on a floor or door cell on the car's edge.
- **Loot slots.** Point objects on `lootSlots` with a string property `tags`, comma separated (`small,hidden`). The tags decide which items from the train's loot table can land there.
- **Guard spawns.** Point objects on `guardSpawns` with a string property `facing` (`left`, `right`, `up`, `down`) and an optional string property `patrol`.
- **Patrol routes.** Optional polylines on `patrol`, named by the id a guard spawn refers to. The converter turns each into a list of cells. A guard with no patrol stands watch.
- **Roof.** An optional map property `roofAccess`: a comma-separated list of entry point ids that lead to the roof (empty by default).
- **Corridor.** A bool map property `corridor` set to true when a car is meant to be one unbroken corridor; otherwise that is an error.

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
- Train-level check in `tools validate`: all cars in one train have the same number of rows, so they line up end to end. Since M2 it also checks that the end doors of every pair of layouts a train can pick line up, and that `requireSideDoors` can be met from the train's layout pool.

**Edit loop.** `npm run cars:watch` rebuilds on save. Loading `?car=mail-car-a` opens a debug scene with just that car, so you can walk it, shoot across it and test sight lines without a full run. The debug overlay colours cells by type and can show cover values, noise values, the reachable area from each entry point, and the loot slots and spawns. As built in M2 (`packages/client/src/carScene.ts`): WASD or the arrows walk, keys 1 to 5 pick the overlay (cell types, cover, noise, reachable area, slots and spawns; 4 again steps through the entry points, 0 hides it), and an unknown id lists the car ids. Shooting and sight lines come with M3 and phase 3. `npm run cars:check` runs in `npm run check` and fails when the generated file is stale.

**Notes**

- Never edit `car-templates.json` by hand. The source of truth is the `.tmj` files and the catalog.
- Keep cars of a type the same size unless you want trains with uneven cars, which would need a rule for the joins.
- Interiors are authored in orthogonal mode like the map. The renderer does the isometric view.

### Separate-mode transition

- **Sim:** a successful boarding moves the player's placement from the world frame to the car frame at the entry point, and the phase changes from `boarding` to `aboard` on that tick. The sim never pauses.
- **Client:** the camera eases from the world view to the train scene over a short placeholder duration (about half a second). The train scene lays the cars end to end, and a backdrop scrolls past at the train's speed using its progress along the route. Bends may tilt or shift the backdrop as a visual touch only.
- **Extraction** reverses this: mounting moves the placement back to the world frame, and the camera eases back out.

### Scale placeholders

These live in config and get tuned in phase 1: a map of about 400 × 200 tiles, a stadium-shaped main route of about 731 tiles (two 240-tile straights joined by two U-turns of radius 40, matching the merged `alpha-flats` map), a train about 62 tiles long at 9 tiles per second (a loop in about 81 seconds), and a horse top speed of 14 tiles per second. That closes on the train at about 5 tiles per second, so a rider starting 60 tiles away catches up in roughly 12 seconds and has room to match speed before the jump. A missed train returns in about 81 seconds. Map size is the hardest value to change later because it is authored in Tiled, so check the feel early in phase 1.

### Generated maps (G1 spike)

A spike toward procedural maps (see the "Procedural infinite maps: options" doc, milestone G1). `?map=gen` builds a map from the run seed (`?seed=`, random when absent) instead of loading a file; the sim reads it like any other map and is unchanged. The generator lives in `packages/mapgen` and writes an ordinary `MapDef` and `SceneryDef`: a closed loop through an ellipse bent by a few low harmonics (curves under the minimum radius are eased locally so the other bends keep their shape, and no two parts of the loop come within `selfGapTiles`), baked into half-tile samples like `build-maps` does, then zones from layered value noise (mud, rocks, forest, lakes), rivers that each cross the track once on a bridge and have shallow fords every so often along them, elevation with the same cliff rule as Tiled maps (gentle hills, plus sandstone mesas that rise by a cliff all round: noise clumps, long thin ridges, ridges running beside the track, and now and then a cut where the track runs between two mesa walls), a spawn on the open side, and scenery. Each map picks a theme (balanced, forest, rocks, mesas, water or mud) that gets more of its feature and less of the others, and a busyness that makes everything a little denser or sparser; the debug panel shows both. Anything the sim reads is built with deterministic maths only (`+ - * /`, `Math.sqrt`, `floor`, `imul`, its own `dsin`/`dcos`); a test scans the package for `Math.sin`, `Math.pow`, `Math.random` and friends, and pins one seed's output so drift on another engine fails CI.

Its numbers are in `base/map-gen.json` (track size, curviness, corridor, noise thresholds, rivers, mesas, hills). `?set=mapGen.<path>=<value>` overrides one for a run: the config's optional `mapGen` tree carries it, so it is in the log header and the config hash, and a replay rebuilds the same map from the logged seed and overrides. Runs without overrides keep their config hash. The corridor rules match the map checks: nothing but open ground or mud within 4.5 tiles of the centre line, an open lane out to 7 tiles on at least one side, and stretches of 50-150 tiles that each keep their obstacles (sometimes a mud bank or a broken rock line) on one side, with both sides open where they switch and round bridges. The checks shared with the hand-made maps (`packages/tools/src/maps/checks.ts`) run over 300 seeds in the tests, and `npm run tools -- gen-map <seed>...` writes a layout PNG for any seed.

### Open line (G3)

Milestone G3 of the procedural maps plan, and the Stage 2 gate: does an open line with towns feel better than a loop? `?map=line&seed=` builds one railway running east across a long map instead of a loop, with the G1 terrain rules, themes, mesas, rivers and fords around it. Everything the sim reads is built with the same deterministic maths as G1, and one seed is pinned in the tests.

- **Track, piece by piece** (`packages/mapgen/src/line.ts`). `growLine` yields pieces forever. Each piece is 160-240 tiles (`line.pieceTiles`), from its own seeded stream (`<seed>/line/<index>`) and the end of the piece before. It picks a target heading within `maxHeadingDeg` (100) of east, pulled back toward the middle of the map by `centrePull`, sometimes adds a swing out and back, turns over part of the piece (`bendShare`) and runs straight for the rest. Control points are `stepTiles` (16) apart, and the heading turns at most `stepTiles / (2.8 x minRadiusTiles)` per point, which keeps every curve at or above `minRadiusTiles` (19) after smoothing. Within 40 tiles of the margin the heading stops pointing further out. Past 90 degrees the line runs north or south and a little back west, so before each control point it looks `3 x selfGapTiles` straight ahead and, if that would come within `selfGapTiles` (40) of older track, steers east; the line never crosses itself (a test checks 40 grown lines keep more than 40 tiles from their older track).
- **Baking.** `bakeOpen` runs the same centripetal Catmull-Rom curve as the loops through the control points and samples it every half tile from its start. A sample depends only on the points before it, so a longer line starts with exactly the samples of a shorter one (a test checks this). That is what lets G4 and G5 keep growing the line ahead as chunks arrive. The line starts `leadInTiles` (24) off the west edge and ends that far past the east edge.
- **Map.** `line.lengthTiles` x `line.widthTiles`, 4,000 x 800 by default (480 until Devlin's PR #34 playtest found the edge too close). `line.direction: west` mirrors the whole generated map, so the route starts off the east edge and trains run right to left; the client finds the next town by distance along the line, not by x. Rivers, mesa cuts and mesas beside the track scale with the line's length (`featureTilesPerLoop`, 850), and ridges with the map's area, so a line has the density of a G1 loop. The west and east edges are not blocked, since the track runs off them. The spawn picks lie between 10% and 25% of the way along (`spawnAlong`). `source.file` is `line:<seed> <theme> <busyness>`, which the debug panel shows.
- **Towns** (placeholders until G6). One or two town spots (`towns.count`) between 30% and 90% of the way along, at least `minGapTiles` (1,200) apart, each a flat clearing of radius `clearingRadiusTiles` (18) on one side of the track, kept `gapTiles` (8) clear of it. A clearing has no rivers, mesas, scenery or hills, and the stretch of track beside it keeps both sides open. `MapDef.towns` lists them (`id`, `route`, `d`, `x`, `y`, `side`, `radiusTiles`), each also a marker (`town1`, `town2`). The iso view draws a ring and a signboard, the top-down view and the minimap a ring.
- **MapDef.** `openLine: { headwayTiles }` marks an open line; every route on it must be open, and `towns` must name existing routes. `mapHash` includes `openLine` only when present, so loop hashes are unchanged.
- **Open routes in the sim.** A train's distance never wraps on an open route. `trackAt` past either end runs straight on along the end tangent, so cars entering or leaving stay rigid. At the start, trains are placed about `headwayTiles` (600) apart from half a headway in. A new train enters at the start once the nearest one is a gap along, each gap `headwayTiles` plus or minus up to `headwaySpreadTiles` (200, `line.trainHeadwaySpreadTiles`) from a hash of the seed and the train ahead (no rng stream, no extra state), and an unpinned train is removed once its last car is 10 tiles past the end. A run whose train reaches the end of the line ends as expired (`RunEnded.endOfLine`), as the clock would; towns replace this in G6. Quick retry and the whistled horse keep to the part of the line inside the map (12 tiles in).
- **Line clock** (Devlin, PR #34 playtest). On an open line the run's clock is the committed train's time to reach the next town at least `LINE_CLOCK_MIN_SEC` (30 s) ahead of it, or the end of the line (`RunState.clockTo` names it), instead of the train's `countdown.baseSec`, and heat does not speed it up: the clock is set by where you board. Heat still does everything else it did; making it change how guards behave is left for Phase 3's guard AI. An in-place cancel and recommit works the clock out again from where the train is now. The HUD shows `to TOWN 1` in place of the drain rate, and expiry says the train pulled into town. `countdown.lineClock: fixed` (`?set=countdown.lineClock=fixed`) brings back the loop clock; loops never use the line clock. `MapDef.towns` is now read by the sim and part of `mapHash` when present.
- **Map checks.** The shared checks run on open lines too: an open line's main route must start and end off the map, corridor checks skip the samples off the map, and reachability only counts track on the map. In the tests 200 line seeds pass the map checks, three seeds keep trains coming and going without touching, and six seeds play a whole scripted run: approach, commit, board, loot, guards aboard, whistle and extract (`lineRunProblems`, which retries a run that ends another way, up to three). `npm run tools -- gen-map --line <seed>...` writes a layout PNG at one pixel per tile.
- **Client.** Built whole, the iso view of a 4,000-tile line took about 5 GB and never finished loading, so on maps over 800 x 400 tiles (`LAZY_AREA_TILES` in `iso/cells.ts`) the static layers (zones, sand spots, mud, ground cover, forest floor, bridges, bushes, trees, boulders, hills and mesas) are built in 48-tile regions (mesas one per plateau) as they come near the view: regions on screen at once, regions within 24 tiles of it 4 ms a frame nearest first, and regions more than 72 tiles away are destroyed (`LazyChunks`). Every hand-made map and G1 loop is smaller, so it builds whole at load in one region, as before. Measured in headless Chromium with software WebGL: the 4,000-tile line loads in about 5 s and holds about 270-340 MB after a minute of riding, and rides at about the frame rate of a G1 loop. The top-down debug view (V) draws its map the first time it is shown. Off the train on a line with towns, the edge arrows point at the next town with its distance, a countdown as you ride (a label over its clearing once it is on screen), and only at the committed train and the switch candidate; `?edgeArrows=both` adds the four nearest other trains and `?edgeArrows=trains` drops the town arrow (the loop default, also capped at four trains). The minimap on a map more than three times longer than wide shows a window 1.5 times its width, following the rider, with a bar under it for the whole line: the window shaded, each town a sand post and the rider a dot (made bigger after the PR #34 playtest). On the 4,000 x 800 line, headless Chromium reaches a picture in about 4 s with about 330 MB, against about 3 s and 245 MB at 480 wide. G5 replaces this with chunks streamed from the generator.
- **Also fixed.** The height layer worked out each mesa's corner heights over the whole map, once per mesa, so its cost grew with the square of the map's area: an 800 x 400 G1 map loaded in 39 s and 2.5 GB, now 6 s and 0.8 GB (same picture).

Settings live under `line` in `base/map-gen.json` and override with `?set=mapGen.line.<path>=`. The loop generator ignores them, so G1 maps and their source hashes are unchanged; a line's source hash leaves out the loop's `track` settings, so tuning loops does not change lines.

**What comes next** (decided in the options review, written into requirements.md under World structure): a run becomes a day on an endless line, inside a career. G4 moves terrain into chunks looked up by position and makes `mapHash` a hash of the seed, generator version and settings instead of every tile; G5 streams chunks in the client; G6 adds towns as places with seeded timetables and the countdown to the next town as a variant. Those change MapDef and the map size here, and each comes with its own design diff.

### Map decisions

1. Alpha: all trains share one route. Longer term, selectable and less predictable routes are wanted, and the model already supports several routes per map.
2. The first route is a stadium shape, two long straights joined by two wide U-turns (a closed loop has to turn back), so boarding mostly happens on straights and the first test isolates boarding feel. More curves come after that, and complex tracks with hills are a long-term goal.
3. No separate horse spawn (decided 2026-10-09). The player starts every run already mounted at `playerSpawn`, and cancel puts the mounted player back there, so a second marker for the horse did nothing. The `horseSpawn` marker was removed from the map, the schema and the converter. If a run ever starts on foot (for example walking to the horse in a town), add a marker back then.

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
  "engine": "engine",
  "carType": "mail-car",
  "carCount": 3,
  "layouts": ["mail-car-a", "mail-car-b", "mail-car-c"],
  "caboose": "caboose",
  "requireSideDoors": "both",
  "countdown": { "baseSec": 150 },
  "guards": { "base": 3, "perWantedLevel": 1, "types": ["guard-light"], "patrol": "car-loop" },
  "passengers": { "count": 0 },
  "loot": { "table": "mail-small-items", "density": 0.6 },
  "verbs": [ { "id": "search", "params": { "searchTimeSec": 1.2 } } ]
}
```

As built in phase 2 M2, trains live under `trains` in `game.json` (not one file each), with `route`, `speedTilesPerSec`, `engine`, `carType`, `carCount`, optional `layouts` (default: every layout of the car type) and `caboose`, `requireSideDoors` (`both`, `one` or `off`), `countdown.baseSec`, optional `loot { table, density }` and `verbs` (ids; the search parameters are under `verbs.search`). Each car's layout is picked from the `gen` stream of the seed `<run seed>/<train id>` for the run the train will be committed in, so the doors on a train's outside are the ones the run gets, and the same seed and run number give the same cars. With `requireSideDoors: both`, picks are swapped until the train has a side door on each side. `density` is the share of the train's eligible small-item slots that get an item (scaled by `loot.densityScale`, capped at all of them), after the loot table's `prizes.count` prizes go on slots that fit them. Hidden slots join only with `verbs.search.hiddenLoot`. Entry points come from the layouts, so there is no `boarding.entryPoints`. Guards arrived with M3 (`trains.<id>.guards.base`, spawned on the layouts' `guardSpawns` and walking their `patrols`); passengers come with phase 4.

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
    "boardingInput": "meter", "healthModel": "bar",
    "worldMode": "separate", "lootCarry": "limit-and-slowdown"
  }
}
```

A preset chooses exactly one variant per group, so two options from the same test can never be active together. Since phase 2 M1 a preset may also name a preset it builds on with `extends` (its variants and values apply first) and carry plain config values in `values`, a partial `game.json` tree, for example `medium-run`: `{ "extends": "alpha-default", "variants": {}, "values": { "countdown": { "scale": 4 }, "loot": { "densityScale": 4 } } }`.

### Variant groups

| Group | Options | What the patch changes |
| --- | --- | --- |
| `boardingInput` | `meter`, `meter-qte` | `boarding.qte.enabled` |
| `healthModel` | `bar`, `downed` | `health.model`, `health.downedWindowSec` |
| `worldMode` | `continuous`, `separate` | `world.mode` |
| `lootCarry` | `limit-and-slowdown`, `unlimited` | `carry.limitEnabled`, `carry.slowdownEnabled` |
| `steering` | `screen`, `heading` | `horse.steering` (phase 1, see Riding controls) |
| `throttleModel` | `hold`, `coast`, `cruise` | `horse.throttleModel` (phase 1, see Riding controls) |
| `guardCatch` | `heat-only`, `thrown-off` | whether an alert guard chases and throws the player off the train, landing back on the horse stunned as after a failed boarding (phase 2) |
| `mountSpill` | `random`, `heaviest`, `share` | what a good mount spills: one random item, the heaviest item, or a share of carried value (phase 2) |
| `trainMix` | `map`, `all-mail`, `mixed`, `mostly-blank` | which trains are mail trains and which are empty decoys. The mix is normally set by config: each map track's `trains` count and `trainType`. `mixed` is the default (Devlin 2026-10-14); `map` uses exactly that; the other options are overlay files for testing that override it with all mail, about half blank, or mostly blank (phase 2) |
| `handlingModel` | `arcade-boost`, `arcade` | whether the horse has a short boost above top speed with a cooldown (phase 2, on by default); stamina and speed tiers join later |

Additional groups (stamina and speed-tier handling, structure preset) follow the same pattern.

**Numbers are values, not variants** (decided 2026-10-11). A playtest knob that is really a number is a plain config value rather than a named variant group: run length is `countdown.scale` (and `loot.densityScale`), the grace window is `countdown.graceSec`, train length is the train's car count, and search pace is `verbs.search.searchTimeSec` plus a hidden-loot flag. This replaces the earlier `runLength`, `graceWindow`, `trainLength` and `searchPace` groups. Presets may carry values as overrides, and the URL sets any value with `set` (see Selecting a setup). Named groups stay for behaviour choices.

### Where each requirement's tuning value lives

| Requirement | Config key |
| --- | --- |
| Boarding meter difficulty | `boarding.meter.speed`, `boarding.meter.zoneWidths` (quick-time prompts, `boarding.qte.*`, come later) |
| Horse handling | `horse.handling`, `horse.maxSpeed`, `horse.accel`, `horse.turnRate` |
| Horse arrival delay | `extraction.arrivalDelaySec` as `[min, max]` (turned into a spawn distance behind the train), `extraction.paceWindowSec` |
| Countdown length | `trains.<id>.countdown.baseSec` × `countdown.scale` |
| Heat rate | `heat.sources.*`, `heat.heatDrainFactor`, `heat.decayPerSec` |
| Grace window | `countdown.graceSec` |
| Guard counts per wanted level | `wanted.guardBonus` (array indexed by level) and `trains.<id>.guards.perWantedLevel` |
| Loot density | `trains.<id>.loot.density` × `loot.densityScale` |
| Death consequences | `outcomePolicy.*` |
| Tick rate | `sim.tickRateHz` |

### Resolve pipeline

1. Load files and check each `schemaVersion`.
2. Merge `base`, then the chosen variants, then the preset's `values` (inherited ones first), then run-time overrides. Objects deep-merge, arrays replace, and a key set to `null` is removed. Two variants from different groups that patch the same path are an error.
3. Validate with strict zod schemas. Unknown keys fail, which catches typos. Cross-references are checked: every train's loot table, car template and verb id must exist, ranges must be ordered, and weights must be positive.
4. Derive values: seconds become integer ticks (timers count whole ticks, so no float drift), cone half-angles become cosine thresholds, and turn rates become per-tick rotation constants.
5. Freeze deeply and compute a hash of the canonical JSON.

The result is a `ResolvedConfig`. Its hash, the preset, the chosen variants and any overrides go into every log header. Config only changes between runs, never during one.

### Selecting a setup

- URL parameters set it for a session: `?preset=alpha-default&v=healthModel:downed&set=countdown.scale=4&seed=abc123`. Each `set=<path>=<value>` becomes a run-time override (step 2 of the resolve pipeline), recorded in the log header's `overrides` like the variants are (phase 2). Built in phase 2 M1 (`overridesFromSet` in `packages/config`): the value is read as JSON (numbers, `true`/`false`, `null`, arrays) and otherwise kept as a string, a later `set` for the same path wins, and a value that fails validation stops the page with the path, like a bad variant. The replay viewer and `tools replay` rebuild the overrides from the header, and the Playtests page counts them as part of the setup.
- A debug panel in `apps/game` lists each variant group and its question, and edits individual values as overrides.
- `tools validate` runs steps 1 to 5 on every preset and fails CI on any error.

## Randomness and event logging

One seed string drives every random choice through separate named streams, and each session records both the commands and the events, so any run can be replayed exactly and compared with another.

### Seeded streams

- **Algorithm.** sfc32, a 32-bit generator built only from integer operations, so every JavaScript engine gives the same sequence. The seed string is hashed into four 32-bit words and warmed up for a few rounds.
- **Streams.** `gen` (run generation and loot placement), `schedule` (train spawns), `ai`, `combat`, `horse` and `misc`. Each stream's state is derived from the seed plus the stream name and stored in `GameState.rng`, so snapshots resume mid-sequence.
- **Run seeds.** At each run start the `gen` stream is re-derived from `seed` and the run number. Layout and loot therefore depend only on those two values, not on how earlier runs were played. A `retrySameLayout` option restarts a run with the same run seed so variants can be compared on identical trains.
- **Draw timing.** The horse arrival delay is drawn from the `horse` stream at whistle time, so the Nth whistle on a seed always gets the same delay regardless of what else happened. The ride up is then plain simulation.

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

Each log is its own NDJSON stream (exported as `<session>.commands.log` and `<session>.events.log`, since GitHub refuses `.ndjson` attachments) and starts with the same header. Besides the fields below, the header carries `config`, the resolved values `configHash` was taken from, and `url`, the page's query string. A `note` line (`{"k":"note","t":640,"text":"…"}`) holds a playtester's comment and goes into both logs; replay skips it. The commands log interleaves a state hash every `logging.hashEverySec` so drift is visible, and both logs close with an `end` line holding the final tick and hash. A `cmd` line at tick `t` holds the commands for the step that advances the sim from `t` to `t + 1`; a `hash` line at `t` is the hash when the sim's tick counter equals `t`.

```json
{"k":"header","log":"commands","logVersion":1,"gameVersion":"0.1.0","configHash":"9f2c…","preset":"alpha-default",
 "variants":{"healthModel":"downed"},"overrides":{},"seed":"abc123","tickRateHz":60,"playerIds":[1],
 "persistentAtStart":{"wantedLevel":1,"bank":120,"lifetimeEarned":450},"startedAt":"2026-10-09T02:11:40Z"}
{"k":"cmd","t":212,"p":1,"c":[{"type":"move","x":127,"y":0}]}
{"k":"hash","t":600,"h":"41ab…"}
{"k":"end","t":1800,"h":"77c0…"}
```

```json
{"k":"header","log":"events", …same fields…}
{"k":"ev","t":640,"e":"BoardingAttempt","result":"good","attempt":1}
```

The wall-clock `startedAt` exists only in the header, written by the host. The sim never reads time.

### Alpha events

| Event | Key payload | Used for |
| --- | --- | --- |
| `RunStarted` | run id, train, seed, countdown (`countdownSec`, null with the countdown off), wanted level | Grouping and comparing runs |
| `RunPhaseChanged` | from, to | Time spent per phase |
| `TrainSwitched` | from, to | How often players change their mind about a train |
| `BoardingAttempt` | result, attempt number, meter position | Boarding failures, meter difficulty |
| `ShotFired`, `DamageDealt` | actor, target, amount | Combat feel |
| `PlayerSpotted`, `AlarmRaised` | by, car | Stealth success, heat causes |
| `HeatChanged` | heat, delta, cause (a `heat.sources` event, `timeAboard`, or `debug` for the playtest key) | Heat tuning |
| `LootPickedUp` | item, value, weight, car, loot id | Loot density, carry tradeoff |
| `LootRefused`, `LootRevealed`, `LootDropped`, `SearchCancelled` | item and reason; item found in a hidden stash; item dropped; loot, reason (`released` or `moved away`) and progress lost (phase 2 M2) | Carry limits, swaps, how often searches are abandoned |
| `ActorDowned`, `ActorKilled` | actor, by | Deaths and retries |
| `HorseWhistled`, `HorseArrived`, `HorseDeparted`, `HorseSideChanged`, `HorseBlocked` | horse distance and side, pace window | Extraction tension |
| `RunEnded` | outcome, duration in ticks, countdown left, heat, loot value, boarding attempts, kills | Run length, completion, cancels (with time left, for flag U6) |
| `PersistentChanged` | before, after | Wanted level and bank effects |
| `CommandRejected` | command, reason | Input and UX bugs |

The sim returns events from `step`, and the host forwards them to a sink asynchronously, so logging never runs inside the tick.

### Sinks and reports

- **Sinks.** An in-memory ring buffer for the debug overlay, IndexedDB for sessions that survive a reload (localStorage is too small), and an export button that downloads NDJSON.
- **Playtests page.** The client also keeps one summary row per run in IndexedDB (a `runs` store, never pruned): tester, setup, seed, map, train, outcome, length, boarding results, furthest phase, damage, commit-to-aboard time, rejections and notes. `playtests.html` groups them by setup, filters, exports CSV or JSON, imports other testers' JSON and prefills a GitHub issue. A row is written when a run starts (as `abandoned`) and replaced when it ends, so a closed tab still counts.
- **Replay.** `tools replay <commands log>` re-runs the commands and checks every logged hash. A game-version or config-hash mismatch is a warning, not a silent pass; when the header carries `config`, the warning lists each parameter that differs. Notes in the log are printed.
- **Replay viewer.** The game page watches a commands log instead of the keyboard: `?replay=<session>` reads a session still stored in IndexedDB (the Playtests page's Watch button, which adds `&t=<tick>` to open at the run's commit), and dropping a `.commands.log` file onto the game page opens it (the file is kept in sessionStorage and the page reloads as `?replay=file`). The config is rebuilt from the header's preset, variants and overrides on this build's content, and the map, seed, players and persistent state come from the header; the normal client draws it, with the logged `url` supplying client options such as `runZoom` (the page's own `view` and `runZoom` win). View keys still work; game keys do nothing, and nothing is logged or recorded. Controls: play/pause, speed 0.5x to 8x, a seek bar over the whole log, previous/next note, one-tick steps, a tick and time readout and the notes list. A background pass replays the whole log once, compares every logged hash ("in sync" or "desync at tick N") and keeps a snapshot every 5 s; seeking back restores the nearest snapshot (`restoreSim`) and re-simulates forward. The same header warnings as `tools replay` (config hash with each differing parameter, tick rate, game version, map hash) show in the panel.
- **Reports.** `tools report` groups logs by the variants in their headers and prints run length, completion rate, boarding failures per run, deaths and retries, cancels with time left, time to first loot and heat at end. These are the candidates for the "playtest criteria" still undefined in the requirements; this design proposes them without setting pass thresholds.

## Renderer, input and UI

The client turns sim state into pixels and device input into commands, and does nothing else. It never decides an outcome: even the boarding meter is sim state that the client only draws.

### Render pipeline

- **Inputs to the renderer.** The live read-only `sim.state`, plus the `SimEvent[]` from each tick for one-shot effects such as muzzle flashes, hit flashes, screen shake and sounds.
- **Interpolation.** After each tick the client copies positions of visible actors into a small typed-array buffer and keeps the previous one. Each frame draws a lerp between them using the accumulator remainder. The client never clones whole state.
- **Projection.** One pure module, `projection.ts`, with `worldToScreen(x, y, layer)` and `screenToWorld`. The default is 2:1 isometric with placeholder 64×32 px tiles, and both functions take the camera zoom.
- **Draw order.** Sort by depth (`x + y`, plus a per-layer offset) using Pixi's sortable containers. Static pieces that sort (hills, mesas, boulders, trees) sit in their own sorted render group under the moving things, so Pixi packs them once; where one is in front of a moving thing, a copy clipped to that thing's screen box is drawn over it (`packages/client/src/iso/overdraw.ts`). In continuous mode, roof sprites fade out while the player's layer is `interior` inside that car. Occlusion is a list of rules in client config, so more can be added after the roof fade: the first extra is an x-ray silhouette for the player behind walls.
- **Placeholder art.** Shapes drawn once into textures through a `DrawableFactory` keyed by entity kind. Pixel art swaps in by changing the manifest. A 3D renderer implements the same factory idea.
- **Camera.** Fixed angle, zoom levels from config (for example three steps), smoothed follow on the player. In separate mode it follows the car frame.

### Trains and boarding cues on the world map

In separate mode the player is never inside a car in the world view, so cars there are always drawn closed. The roof fade belongs to the continuous mode only.

- **Placement.** The sim gives each car a distance along the route. The client looks up the position and unit tangent for that distance and projects them through `projection.ts`, so cars follow the bends and stay rigid. Positions are interpolated between ticks like any actor.
- **Placeholder look.** Each car is a flat-shaded box with a top face and two visible sides, tinted by car type, with a small mark for the front. Cars are 28 × 7 tiles since sneaking PR 1 (16 × 6 before), so the engine, three cars and the caboose are about 112 tiles long. In 3D they are about 5 tiles tall (visual only, `?carHeight=` to try others), with person-sized side doors.
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
| 2. Mail/express | Countdown, heat, loot, carry flags, light guards (patrol, sight, noise, alarm; no combat), extraction with a physical horse that is placed behind the train on the whistle, rides up around terrain and can switch sides, wanted level, outcome policy, persistence, run-length variants. With the world view aboard (phase 1 M4) and a physical horse, phase 2 plays much like the continuous world; what the world-structure test still compares is revisited before the prototype ends | Compare short and medium runs and pick a target length |
| 3. Military payroll | Perception and AI, combat, health bar and the downed variant | Combat feels good and the health variants are compared |
| 4. Passenger hold-up | `inspect` verb, passenger behaviour, armed passengers | Judging passengers is a decision, not a chore |
| 5. Bank | `vault` verb, guard interruptions | The minigame holds up under time pressure, and each train favours a style while other approaches still work |

**Phase 2 progress.** M1 (countdown, heat and run end), M2 (mail train and loot), M3 (light guards and the horse boost) and M4 (extraction) are built; see the Phase 2 checklist at the end of this document for what each milestone actually built.

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
- **Switching trains.** While approaching (or stunned after a failed jump), Tab sends `switchTrain` with the nearest other free train within `commit.switchRangeTiles`, which the prompt names. The sim unpins the old train and pins the new one; the run, its start tick (so the run timer and countdown), health, jump count and meter zones carry on (Devlin, extra-maps playtest, 2026-10-11). Aboard it is refused. The train a commit or switch lands on flashes gold for a moment, with no lasting highlight, and the Tab target's roofs are outlined pale blue, with matching edge arrows (Devlin, switch-train playtests, 2026-10-12 and 13). Variant group `trainSwitch`: `key` (the default, Tab only) and `auto` (`commit.autoSwitch`: riding within `commit.rangeTiles` of another free train and `commit.autoSwitchMarginTiles` closer to it than to the committed one switches with no key; Tab still works).
- **Boarding jump rules.** The jump is allowed when the player is within `boarding.rangeTiles` of an entry point on the side they are riding; out of range, `jump` is rejected and the HUD says so. Speed matching (within `boarding.speedToleranceTilesPerSec` of the train) no longer gates the jump: after the M3 playtest on 2026-10-09 Devlin chose to let a mismatched rider try on a faster meter, so matching makes the jump easier rather than possible. The HUD still reads too fast, too slow or matched. The meter decides the landing.
- **Failure cost.** A failed jump always costs time, and damage is a toggle. A failed player is thrown clear and the horse is stunned for `boarding.failure.stunSec`, so the train pulls ahead before a retry. Damage is `boarding.failure.damageFraction` of max health. A variant group `boardingFailure` has `time-and-damage` and `time-only` (damage fraction 0). Phase 1 includes a minimal health value so the failure and death paths are real; the full health system waits for phase 3.
- **No countdown in phase 1.** The countdown and heat arrive in phase 2, so `countdown.enabled` is false until then. Cancel works from the start.

* **Horse and train collision.** Cars are solid. The horse stops or slides along a car's side, so it cannot ride through a train. The riding system collides the horse, a circle of radius 0.5 tiles, against each car's rectangle, computed from the car's place on the route. Each car is rigid: its front and rear sit on the track and its body is the chord between them. Contact lowers the horse's speed to the distance it actually covered, so a head-on hit stops it and a glancing one slides it along the car. Blocked and deep water tiles and the map edge collide the same way. Slow tiles cap the horse at `horse.slowZoneSpeedScale` of top speed, reining it in at its braking rate; shallow water caps it at `horse.waterSpeedScale` and drops it to that speed at once.
* **Collision damage** (Devlin's playtest feedback, 2026-10-10 and 2026-10-11). On a run, touching a train car or blocked ground can cost health, emitted as `DamageDealt` with cause `collision`, `against` `train` or `obstacle`, `kind` `crash` or `scrape`, and the `impact`. The impact is the closing speed along the contact: the horse's velocity relative to what it hit (a car moves at its train's speed), along the direction the collision pushed it. So riding head-on into a rock or a car side, or a train running into a standing horse, hits hard, while scraping along a car at a shallow angle barely closes. Below `collision.minImpactTilesPerSec` a car touch is a scrape costing `collision.scrapeDamageFraction` of max health and a rock touch is free; from there the damage scales linearly up to `collision.damageFraction` for a car, or `collision.obstacleDamageFraction` for blocked ground, at `collision.fullImpactTilesPerSec`, in whole health points. Train hits are kept separate from rocks so a train can hurt much more (Devlin's playtest, 2026-10-12). After a hit, contacts for `collision.cooldownSec` only cost what they exceed that hit by, so a long scrape costs about 1 a second and a crash right after a scrape still costs its full amount in total. Water, slow ground and the map edge never hurt, and with no run there is no health to lose. Variant group `collisionDamage`: `on` and `off` (all three fractions 0).
* **Boarding meter use.** In boarding range the meter sweeps continuously: at `boarding.meter.matchedSweepPeriodSec` when speed matched, and at the faster `boarding.meter.sweepPeriodSec` when not (changed after the 2026-10-09 playtest, see Boarding jump rules). The marker keeps its place when the speed changes, a single Space press samples it on that tick, and leaving range parks it at the start.
* **Ending a phase 1 run.** After boarding, the player can walk the blank interior. Esc cancels the run and puts the mounted player back at `playerSpawn` while the train keeps looping.
* **Repo.** A new repository using the monorepo layout from Package structure, with this document moved into `docs/`.

### Riding controls

Steering plus throttle, because a keyboard cannot otherwise hold a speed of 9 when the horse tops out at 14. Steering ships as the `steering` variant group with two options. The Phase 1 review chose screen-relative as the default; after the first playtests on 2026-10-09 Devlin switched the `alpha-default` preset to heading-relative steering and the coast throttle model:

- **Screen-relative** (`screen`): the arrow keys give a direction on screen, diagonals included, and the horse turns toward it at the turn rate; releasing the arrows keeps the current heading. W/S are the throttle, so direction and speed sit under separate hands. The client turns the screen direction into a world direction and sends it as a `steer` command, so the sim never sees the screen. In the top-down debug view that is the identity. In the isometric view (M4) a single arrow follows the inverse projection exactly, and a two-key diagonal follows the tile axis on that diagonal (`keyDirToWorld` in `packages/client/src/projection.ts`): keys only make 45° diagonals while an axis is 26.6° from horizontal on a 2:1 screen, so the exact inverse would leave no way to ride straight along a track or a car. Walking aboard uses the same mapping.
- **Heading-relative** (`heading`, default): the `move` command's x axis (A/D) turns the horse relative to its heading, the same on a straight, a U-turn or any track direction.

The `move` command's y axis is the throttle in both. Axes are in screen sense, so W sends y = -127 and the sim treats -y as throttle: W accelerates at `horse.accel` and S brakes at `horse.brake`. What releasing W does is the `throttleModel` variant group (decided in review): `hold` keeps the current speed, `coast` (default since the 2026-10-09 playtests) slows under `horse.dragTilesPerSec2`, and `cruise` makes W and S raise and lower a target speed at `horse.cruiseTargetRateTilesPerSec2` that the horse then accelerates or brakes to. In every model holding W reaches and holds top speed. The `handlingModel` variants (stamina, speed tiers) can reinterpret the same commands later.

| Input | Action |
| --- | --- |
| A / D | Steer, heading-relative (default) |
| Arrow keys | Steer, screen-relative |
| W / S | Accelerate / brake (throttle under cruise) |
| Space | Boarding jump (and mount jump later) |
| E | Commit to the train the commit prompt names, interact; hold to search loot aboard |
| X | Drop the last carried item (phase 2 M2) |
| Tab | Switch the run to the nearest other free train in range, keeping the run timer |
| F | Whistle (phase 2) |
| H / Shift+H | Raise heat by `playtest.debugHeatStep` / raise an alarm's worth (`heat.sources.alarmRaised`), playtest only (phase 2 M1) |
| U | Mute the placeholder sounds (`?mute=1` starts muted) |
| Esc | Cancel run |
| R | Quick retry (playtest only, `playtest.quickRetry`) |
| Shift | Run aboard (walking is the default) |
| Q / Z or keys `-` / `=` | Zoom out / in (steps 0.35, 0.5, 0.7, 1, 1.4, 2; the wheel zooms smoothly; locked from commit to the end of the run, at 1 in iso and 1.75 top-down; `?runZoom=` overrides) |
| V | Switch between the isometric view and the top-down debug view |
| O / B / backquote | Map debug overlay / boarding range circles (off by default since the Phase 1 gate playtest) / debug readout |

Mouse aim and fire arrive with combat in phase 3. A touchpad needs only the keys above, in line with the input rules earlier.

### Starting values

| Value | Placeholder | Config key |
| --- | --- | --- |
| Commit range | 12 tiles | `commit.rangeTiles` |
| Commit prompt timer: staying in range of the same train this long commits with no key (null: E only, 0: at once, the old auto-commit). Replaces `commit.auto` (Devlin, 2026-10-17: check trains for loot without committing by accident) | 2 s (placeholder) | `commit.timerSec` |
| Riding this close to the prompted train commits at once (null: off) (Devlin, 2026-10-17) | 4 tiles (placeholder) | `commit.closeRangeTiles` |
| During a run that can switch, another free train within `commit.rangeTiles` and closer than the committed one gets the same prompt ("Switch to this train?"): Tab, the switch timer or the close range switch (Devlin, 2026-10-18) | on | `commit.promptSwitch` |
| Switch prompt timer (Devlin, PR #30 playtest, 2026-10-18: a bit longer than committing) | 3 s | `commit.switchTimerSec` |
| Esc while still on the horse (approach, or stunned after a failed jump) ends the run where you are instead of at the spawn; the train left then only commits on E until you ride out of its commit range (`PlayerState.commitHold`). Recommitting to a train you cancelled from in place picks up that run's clock, heat, health, jump count and meter (`PlayerState.resumeRuns`, one per train, cleared when a run ends any other way), so Esc can't reset the clock or reroll the meter (Devlin, PR #30 playtest round 2). Aboard, Esc still goes back to the spawn. Later: cancelling should cost a little wanted level (Devlin, 2026-10-18), via `outcomePolicy.cancelled` once wanted level lands | on | `commit.cancelInPlace` |
| Switch range (Tab), nearest car body | 30 tiles (placeholder, 2026-10-11; Devlin found it fine, 2026-10-12) | `commit.switchRangeTiles` |
| Auto switch (trainSwitch `auto`), and how much closer the other train must be | off; 4 tiles (placeholder, 2026-10-12) | `commit.autoSwitch`, `commit.autoSwitchMarginTiles` |
| Boarding range from an entry point | 2 tiles | `boarding.rangeTiles` |
| Speed match tolerance | 2 tiles/s (1.5 until playtest tuning on 2026-10-09) | `boarding.speedToleranceTilesPerSec` |
| Meter sweep period, in range but speed off | 1.3 s (Devlin's 2D tuning, 2026-10-10) | `boarding.meter.sweepPeriodSec` |
| Meter sweep period, speed matched | 1.85 s (Devlin's 2D tuning, 2026-10-10) | `boarding.meter.matchedSweepPeriodSec` |
| Meter zone widths (perfect, good) | 3%, 15% of the track (Devlin's 2D tuning, 2026-10-10; was 10%, 25%) | `boarding.meter.zoneWidths` |
| Failure stun | 1.5 s | `boarding.failure.stunSec` |
| Failure damage | 15% of max health (Devlin's 2D tuning, 2026-10-10; was 25%) | `boarding.failure.damageFraction` |
| Horse speed after a failed jump, held during the stun | 50% | `boarding.failure.horseSpeedScale` |
| Walking aboard | half of `player.speedTilesPerSec` (4 tiles/s); Shift runs at the full 8 (client-side, after the 2026-10-09 playtest) | `player.speedTilesPerSec` |
| Good-landing stumble | 1.5 s at 33% walk speed (Devlin's isometric tuning, 2026-10-10; 2.5 s in his 2D tuning, 0.5 s at 50% before) | `boarding.landing.stumbleSec`, `boarding.landing.stumbleSpeedScale` |
| Good-landing stagger (Devlin, PR #35 playtest, 2026-10-20; distance Claude's pick) | a good landing staggers 2 tiles in from the side door, out where guards can see you; a perfect landing stays in the doorway | `boarding.landing.goodStumbleInTiles` |
| Collision damage | scrape 1% of max health; crash from 2 tiles/s of closing speed (Devlin, 2026-10-11; was 4), rising at 8 tiles/s to 45% for a train car (Devlin's playtest, 2026-10-12; was 10%) and 10% for blocked ground; 1 s cooldown (confirmed in Devlin's playtest, 2026-10-11) | `collision.scrapeDamageFraction`, `collision.minImpactTilesPerSec`, `collision.damageFraction`, `collision.obstacleDamageFraction`, `collision.fullImpactTilesPerSec`, `collision.cooldownSec` |
| Quick retry (R) | on, 60 tiles behind the last car | `playtest.quickRetry`, `playtest.quickRetryGapTiles` |
| Max health | 100 | `health.max` |
| Horse top speed | 14 tiles/s | `horse.maxSpeed` |
| Horse acceleration, braking | 7 and 12 tiles/s² (accel was 8 until playtest tuning on 2026-10-09) | `horse.accel`, `horse.brake` |
| Horse turn rate | 120°/s (converted to a per-tick rotation at resolve) | `horse.turnRateDegPerSec` |
| Horse drag, throttle released (coast) | 3 tiles/s² (4 until playtest tuning on 2026-10-09) | `horse.dragTilesPerSec2` |
| Cruise target rate | 10 tiles/s² | `horse.cruiseTargetRateTilesPerSec2` |
| Horse top speed on slow ground | 50% | `horse.slowZoneSpeedScale` |
| Horse top speed in shallow water | 25%, reached at once | `horse.waterSpeedScale` |
| Train | engine plus 3 cars, 9 tiles/s | `trains.blank` |
| Tick rate | 60 Hz | `sim.tickRateHz` |

Landing results: a perfect landing arrives clean, a good landing arrives with a short stumble (a brief slowdown), and anything else is a failure.

### RngState

The state that snapshots store for the seeded streams (see Randomness and logging):

```ts
type StreamName = 'gen' | 'schedule' | 'ai' | 'combat' | 'horse' | 'misc';
type RngState = Record<StreamName, [number, number, number, number]>;  // sfc32: four uint32 words per stream
```

### Implementation status (2026-10-09)

Repo: `devlinjunker/train-robber`, branch `phase-0-scaffold`. Legend: `[x]` done, `[~]` partly done, `[ ]` not started. This repo copy of the document is now the source of truth; the earlier live Claude Doc is a snapshot.

### Phase 0 checklist

Naming settled on 2026-10-09: commands use `type` as the discriminant (the doc's earlier `t` clashed with the tick field in log lines), the seed is a string hashed into the stream states, `trainId` is a string, and the repo uses npm workspaces rather than pnpm.

Phase 0 is complete. The gate holds: the checked-in golden replay passes in CI, and a variant switches from the URL (`?preset=alpha-default&v=boardingFailure:time-only&seed=abc123`).

- [x] Monorepo, TypeScript project references, and the lint rules that ban `Date`, `Math.random` and transcendental `Math` in `packages/sim`
- [x] Dependency check and CI running lint, tests and `tools validate` (dependency-cruiser in `.dependency-cruiser.cjs`; `npm run check` runs typecheck, lint, the dependency check, `tools validate`, `tools build-maps --check` and tests, and CI runs it plus the build)
- [x] Sim skeleton: tick loop, state types, command and event types, RNG streams, snapshot and hash (minimal; grows with phase 1). The sim takes the resolved config through a structural `SimConfig` type, and `GameState` holds the seed, config hash and run count, so `restoreSim(snapshot, config)` needs nothing else and refuses a different config
- [x] Config pipeline: schemas, merge, resolve, hash, `tools validate` (base `game.json` has the sections `sim`, `logging`, `player`, `world`, `horse`, `commit`, `boarding`, `health`, `countdown`, `trains` (the `blank` train) and `outcomePolicy` (`died`, `cancelled`), holding the phase 1 starting values; `sim.tickRateHz` replaced the old `TICK_RATE` constant; derive turns `xSec` into `xTicks`, `xPerSec` into `xPerTick`, `xHalfAngleDeg` into a cosine threshold `xCos` and `xDegPerSec` into a per-tick rotation `xCosPerTick`/`xSinPerTick`; first variant group is `boardingFailure`, first preset `alpha-default`)
- [x] Command and event log with header, an IndexedDB sink, and `tools replay` (the client keeps the newest 20 sessions in IndexedDB, an in-memory ring buffer feeds recent events to the overlay, and the Export logs button or L downloads both logs as `.log` files, after an optional comment, and N adds a note; `tools replay <commands log>` checks every logged hash and warns on a config-hash, tick-rate or game-version mismatch)
- [x] Golden-run test and snapshot round-trip test (golden is the checked-in replay `packages/tools/test/fixtures/golden.commands.ndjson`; `npm run golden:update` rewrites it after a deliberate change)
- [x] Blank PixiJS scene with the debug overlay (fps, tick time, seed, config hash, state hash, preset and variants)
- [x] Minimal `tools build-maps` for the phase 1 map (terrain, track routes with centripetal Catmull-Rom smoothing baked into samples about half a tile apart, speed zones, markers, and the checks above; `maps:watch` landed in phase 1, and scenery layers after it with the minimap)

### Phase 1 checklist

- [x] Phase 1 Tiled map: flat terrain, one stadium-shaped route, a spawn marker (`maps-src/alpha-flats.tmj`: 400 × 200, stadium route with 240-tile straights and radius-40 U-turns, a pond, `playerSpawn` at (200, 170) with open ground up to the bottom straight, checked by a test; the separate horse spawn was dropped, see Map decisions; the scale placeholders above match it). M1 also added `npm run maps:watch`, `?map=` loading validated through `MapDefSchema`, and the map debug overlay
- [x] Horse riding with steering, throttle and drag (`packages/sim/src/world/riding.ts`: the player starts mounted and stopped at `playerSpawn`; `steering` and `throttleModel` variant groups chosen by URL, for example `?v=steering:heading&v=throttleModel:coast`; slow tiles cap speed, blocked and water tiles and the map edge stop the horse; the sim receives the map through the structural `SimMap` type and snapshots record its hash, so `restoreSim(snapshot, config, map)` refuses a different map)
- [x] Train and track simulation: an engine plus three blank cars moving along the route, looping (`trackAt` in `packages/sim/src/world/track.ts` gives position and unit tangent at any distance along a route; `packages/sim/src/world/trains.ts` spawns the one blank train at load and advances it, with `pinTrain` as the hook for the committed train in M3; `packages/sim/src/world/cars.ts` generates the `engine` and `blank-car` templates in code (doors mid-car on both sides of a blank car, none on the engine), places cars as rigid 16 × 6 rectangles, and `entryPointWorld` gives entry points in world space for the boarding rule and the markers; horse against car collision is in, and the top-down debug view draws the cars, entry points and the horse with its heading)
- [x] Commit prompt and `startRun` (M3: `commitTarget` is the commit query the prompt reads and `startRun` validates `commit.rangeTiles`, measured to the nearest car body, and that the train is free; it pins the train, refills health and enters `approach`. `interact` while idle commits the same way, so E works without the client naming a train. After the gate playtest Devlin chose to commit by riding into range (`commit.auto`); on 2026-10-17 he swapped that for a commit prompt so a rider can check trains for loot without committing: with a free train in `commit.rangeTiles` the client flashes "Commit to this train?" and outlines it pale blue, E commits, and `autoCommitSystem` (after riding, before boarding) also commits once the rider has stayed in range of the same train for `commit.timerSec` (tracked in `PlayerState.commitTimer`, drawn as a filling bar) or rides within `commit.closeRangeTiles`. With `commit.promptSwitch` (Devlin, 2026-10-18) the same prompt, timer and close range switch a run that can still switch to another free train in `commit.rangeTiles` that is closer than the committed one, so it never offers the train just left)
- [x] Boarding rules, meter, success and failure, and the stun (M3, `packages/sim/src/world/boarding.ts` and `run.ts`: `boardingCheck` is the one rule, shared with the debug readout; in range the meter sweeps back and forth, slower when speed matched, and the zones re-roll from the `misc` stream only after a jump resolves. A failed jump holds the `boarding` phase for the stun with the horse at `horseSpeedScale` of its speed and deaf to the reins, then returns to `approach`)
- [x] Minimal health, death outcome, and cancel (M3: health refills at each run start; death ends the run as `died` through `rules/applyOutcome` and `outcomePolicy.died`, then resets like cancel; cancel and quick retry work from every phase but `ended`, and `ended` passes to `idle` on the same tick)
- [x] Separate-mode train scene and the camera transition (sim side in M3: `world/separate.ts` implements `WorldModel`; boarding moves the placement into the car frame `car:<trainId>:<index>` at the entry cell and the horse turns abstract (`mode: 'away'`); the blank interior is walkable with screen-relative WASD (walk at half `player.speedTilesPerSec`, Shift runs); `move` aboard is in the car's frame and the client maps the screen into it. M4: aboard, the client keeps the world view instead of a separate train scene (Devlin, 2026-10-10). The car you are in is drawn open, with a plank floor and low walls with door gaps and no roof, and the camera follows you on the moving train, so the client places the car-frame position back in the world with `carToWorld`. Where a car hides the horse and rider, or you aboard, a round hole is cut through the cars around them (an inverted Pixi mask per slice), so they and the ground around them show through (`packages/client/src/iso/occlusion.ts`), the first occlusion rule after the roof; Devlin preferred this to an x-ray silhouette, cutting away the whole car, or a darkened cutout. Committing locks the zoom until the run ends, aboard too: 1 in iso and 1.75 top-down, `?runZoom=` overrides (Devlin, 2026-10-10); the riding zoom comes back after)
- [x] Isometric renderer and input (M4, `packages/client`: the Pixi code moved out of `apps/game`; `projection.ts` is 2:1 isometric with 64 × 32 px tiles and zoom steps; terrain, zones and track are drawn once; cars are flat-shaded boxes in two-tile slices that depth-sort one by one against the horse; positions are interpolated between the last two ticks; a look-ahead camera leads the horse by up to 10 tiles; entry markers on the riding side are dim, ringed or highlighted by the sim's boarding verdict; edge arrows with distances point to trains off screen, the committed one in gold; `input.ts` holds the bindings and the `InputMapper`; the steering and throttle variants are unchanged and still chosen by URL; the top-down view stays as a debug view behind V)
- [x] HUD: commit prompt, jump rejection reasons, meter, health (M4: an HTML HUD with the phase, a health bar, the prompt for what to do next and the last rejection or jump result; the meter and the too fast / too slow / matched readout are drawn above the horse at a fixed size on screen; the debug readout is HTML too, toggled with the backquote key)
- [x] Logging of boarding attempts and run outcomes (M3 emits `RunPhaseChanged`, `BoardingAttempt`, `DamageDealt`, `CommandRejected`, `RunEnded` and `PersistentChanged` and allows them in `logging.events`. M5 dropped `RunCancelled`: a cancel is `RunEnded` with outcome `cancelled`, and `retry` marks a quick retry. `tools report <file>.events.log...` reads exported event logs and prints runs, boardings, outcomes, jumps per run, results, rejections by reason, and the median time from commit to aboard)
- [x] Phase 1 tests (M5): the golden run now commits, fails two jumps, lands the third as good, walks and cancels, and a test checks that sequence; `npm run bots` (`packages/tools/src/bots.ts`) runs an idle, a random and a chaser bot over 1,000 seeds, cycling the six steering and throttle combinations, for 90 s each, and after every tick checks the invariants (no crash, no physical horse inside a car, horse on the map with a finite unit heading and speed within `horse.maxSpeed`, health and meter in range in a live run, a pinned train exactly when a run is on, a player in a car frame only aboard and on a walkable cell). `npm run bench` times `step` for the chaser bot and fails above a 1 ms mean (the sim's share of a 16.7 ms frame); it runs about 5 µs. Both run in CI after `npm run check`. The snapshot taken mid-boarding was already covered in M3
- [ ] Playtest against the gate: riding and boarding is fun before any loot exists

## Phase 2 starting spec

Phase 2 builds the mail/express train and the first full run. The live plan is the [Phase 2 implementation plan](https://claude.ai/code/artifact/b87c9954-66b4-4b7d-b759-0f74a8eaf0fd); this section records the decisions from its review on 2026-10-11 that change or add to the design above.

- **Milestones.** M1 countdown and heat, M2 mail train and loot, M3 light guards and the horse boost, M4 extraction, M5 wanted level, saving and score, M6 tests and the run-length playtest.
- **What fills a medium run.** A longer train (more cars) and slower looting (longer search, hidden loot) are both tested, as plain values separate from `countdown.scale` (U7, and Numbers are values under Variant groups).
- **Horse.** Physical whenever it is in the world (changed 2026-10-11 in the PR #14 review; the scripted lane horse is dropped). When the player boards, the riderless horse turns away from the track and runs off, and is removed from the world after `horse.runOffSec`, by which time it is out of view at run zoom. On the whistle the sim draws an arrival delay and places the horse behind the last car on the player's side, at the distance that delay takes to close: delay × (`horse.maxSpeed` − train speed), measured back along the track and offset to the lane, moved to the nearest open tile if that spot is blocked. It then rides with the same physics as a ridden horse, driven by a small steering AI that aims at a lane beside the player's car and paths around blocked and water tiles on a coarse grid, so it collides with cars and terrain and is slowed by slow ground; terrain can therefore stretch the 5 to 20 s. It takes no crash damage while riderless. Whistling again while it is on its way or alongside sends it to the side the player is now nearest, crossing behind the last car. If it cannot reach the car, it keeps trying and the HUD says the horse is blocked. When the pace window ends it drops back and is removed again until the next whistle. Arrival, side and mount results are in U4. The horse boost is on by default (`handlingModel: arcade-boost`).
- **Guards.** Light guards in M3 with perception but no combat. `guardCatch` tests heat only against being thrown off.
- **Heat.** Only speeds up the countdown in phase 2; the countdown bar shows its drain rate (for example ×1.6) so the effect reads. Heat thresholds that change guard behaviour are on the wiki Ideas page.
- **Loot.** Mostly small items plus one or two heavy, valuable prizes per train; items can be dropped to swap (`drop` command).
- **Cars.** Drawn in Tiled with `tools build-cars` (see Car Tiled workflow); three starter mail car layouts are generated to edit.
- **Boarding.** Only some mail car layouts have side doors; entry points come from each layout's `entryPoints` layer in Tiled and are drawn on the car's outside in the world view. To compare with doors everywhere, a variant limits the train to layouts that have doors on both sides (the train config lists which layouts it may pick), so at least one starter layout has doors on both sides; there is no separate all-doors switch. The horse comes up on the player's side at extraction, so they may need to walk to a car with a door on that side. Roof access, including side ladders for boarding straight onto the roof from the horse, waits for phase 3.
- **Searching.** Hold E for the search time; the player can slow-walk at 30% speed meanwhile. Releasing E, or moving more than 1.5 tiles from the loot spot, cancels and loses the progress.
- **Carrying.** A hard max of 10 weight units, with slowdown from 6 units down to 50% speed at the max, and a separate cap of 20 items. Starting weights: letter 0.1, cash bundle 0.2, jewellery pouch 0.3, parcel 0.5, registered mail sack 4, strongbox 6.
- **Heat hooks.** `heat.sources.timeAboardPerSec` is 0.33 by default (Devlin's M1 playtest, 2026-10-13: lingering aboard should cost something; it was 0 with a 0.2 preset before). The `no-time-aboard-heat` preset, or `?set=heat.sources.timeAboardPerSec=0`, turns it off. `heat.boardingResistanceAt` (off by default) is the hook for guards shooting at the rider at high heat once combat exists.
- **Trains on the map.** Mail by default; blank trains can be mixed in as decoys (`trainMix`), and train names are hidden on the off-screen arrows by default (`hud.showTrainNames: false`, Devlin 2026-10-14; `?trainNames=on` shows them).
- **Grace window.** See U3.
- **Saving.** One shared save; `wanted.forceLevel` runs save nothing; no way for wanted level to come down yet (U11). A Reset save button in the debug overlay and `?resetSave=1` both confirm before wiping.
- **Playtesting.** Free play with ready-made presets for the main questions, linked from the wiki Playtesting page, instead of an in-game variant panel. Each preset builds on `alpha-default` and ships in the PR of the milestone that adds its switch:

| Preset | Sets | Question | Milestone |
| --- | --- | --- | --- |
| `medium-run` | `countdown.scale` 4, `loot.densityScale` 4 | Short vs medium run (the phase gate) | M1 |
| `no-time-aboard-heat` | `heat.sources.timeAboardPerSec` 0 | Does lingering aboard need to cost heat? (on at 0.33 by default) | M1 |
| `long-train` | mail train 6 cars with side doors on at most 2 (`maxSideDoorCars`), `loot.densityScale` 0.7; run length is left to `countdown.scale` (Devlin 2026-10-14) | Does a longer train fill a medium run? | M2 |
| `slow-search` | every search time × 2.5 (`verbs.search.timeScale`), with `countdown.scale` 4 | Does slower looting fill a medium run? | M2 |
| `no-carry-limit` | `lootCarry: unlimited` | Does carry weight make choices interesting? | M2 |
| `doors-both-sides` | the mail train picks only layouts with side doors on both sides | Restricted doors vs doors everywhere | M2 |
| `big-windows` | the mail train picks only the big-window layouts `mail-car-d` (doors both sides, six-wide windows at each end) and `mail-car-e` (right door only, near-continuous windows) | Whether being seen through windows reads better with big windows (Devlin, 2026-10-21) | Sneaking PR 2 |
| `map-trains` | `trainMix: map`, the map's own trains (mixed trains are the default since Devlin 2026-10-14; this replaced `mixed-trains`) | Are decoy trains interesting? | M2 |
| `heat-only` | `guardCatch: heat-only` | What should an alert guard do without combat? (thrown-off is the default since Devlin's M3 playtest, 2026-10-17) | M3 |
| `no-boost` | `handlingModel: arcade` | Is the horse boost worth it? | M3 |
| `spill-heaviest`, `spill-share` | `mountSpill: heaviest` or `share` | What should a good mount cost? | M4 |
| `wanted-3` | `wanted.forceLevel` 3 (saves nothing) | How does a high wanted level play? | M5 |

Presets combine with `?v=` and `?set=` on the URL, so `?preset=long-train&v=guardCatch:heat-only` tests two things at once.

### Phase 2 starting values

| Value | Starting value | Config key |
| --- | --- | --- |
| Mail countdown base | 150 s | `trains.mail-express.countdown.baseSec` |
| Countdown multiplier | 1 (a medium-run preset sets 4) | `countdown.scale` |
| Grace window | 3 s | `countdown.graceSec` |
| Mail cars | 3 (a preset sets 6) | `trains.mail-express.carCount` |
| Search time | 1.2 s by default; letters 0.8 s, mail sack and strongbox 2.2 s; the slow preset scales all by 2.5 (after the M2 playtest, Devlin 2026-10-14) | `verbs.search.searchTimeSec`, `items.<id>.searchTimeSec`, `verbs.search.timeScale` |
| Hidden loot | On, so a stash can be missed (after the M2 playtest, Devlin 2026-10-14). Searching a stash takes 1.8 s and only reveals its item, which then lies there to be searched at its own time | `verbs.search.hiddenLoot`, `verbs.search.hiddenSearchTimeSec` |
| Walk speed while searching | 30% | `verbs.search.walkSpeedScale` |
| Search cancel distance | 1.5 tiles | `verbs.search.cancelRangeTiles` |
| Horse arrival delay | 5 to 20 s, seeded; the horse is placed that far behind (25 to 100 tiles at 14 vs 9 tiles/s) | `extraction.arrivalDelaySec` |
| Horse run-off after boarding | 3 s, then removed | `horse.runOffSec` |
| Horse lane beside the car | 2 tiles out from the car's side | `extraction.laneOffsetTiles` |
| Horse alongside | 10 s; re-whistle after 5 s | `extraction.paceWindowSec`, `extraction.rewhistleCooldownSec` |
| Mount meter | zones 3% and 15%, 1.85 s sweep | `extraction.meter.*` |
| Carry max | 10 weight units, 20 items | `carry.maxWeight`, `carry.maxItems` |
| Slowdown | from 6 units to 50% speed at the max | `carry.slowdownFromWeight`, `carry.minSpeedScale` |
| Horse boost | 1.5 s at +40% top speed, 6 s cooldown | `horse.boost.*` |
| Blank train countdown base (Claude's pick in M1, matching the mail train) | 150 s | `trains.blank.countdown.baseSec` |
| Heat drain factor | 1.0 (heat 100 doubles the drain) | `heat.heatDrainFactor` |
| Debug heat step (H) | 10; 0 turns the key off | `playtest.debugHeatStep` |
| Guards on the mail train | About 2 for every 3 cars with guard spawns at wanted level 0 (Devlin, 2026-10-17), plus the wanted-level bonus from M5 | `trains.<id>.guards.perCar` (0.67), `trains.<id>.guards.base` (0) |
| Guard sight (M3; 10 tiles since Devlin's sneaking PR 1 playtest, 2026-10-20; cone widened in Devlin's PR #36 playtest, 2026-10-27) | 10 tiles, 55° half-angle (a 110° cone) | `ai.sight.rangeTiles`, `ai.sight.coneHalfAngleDeg` |
| Guard sight along a ledge (Devlin, 2026-10-21) | 30 tiles for a guard standing on a ledge, so he sees the whole length of a 28-tile car; inside, the normal range | `ai.sight.ledgeRangeTiles` |
| Guard hearing (Claude's pick in M3) | 1.5 tiles walking, 5 running, times the cell's noise | `ai.noise.walkRadiusTiles`, `ai.noise.runRadiusTiles` |
| Guard awareness (Claude's pick in M3) | alert after 1 s in view; suspicious calms after 4 s, alert after 6 s | `ai.alertAfterSec`, `ai.calmSec`, `ai.alertCalmSec` |
| Guard movement (Claude's pick in M3) | patrol 1.5 tiles/s with 1.5 s pauses, chase 4 tiles/s (Devlin, M3 playtest 2026-10-18), turn 240°/s, catch within 0.8 tiles | `ai.patrolSpeedTilesPerSec`, `ai.patrolPauseSec`, `ai.chaseSpeedTilesPerSec`, `ai.turnRateDegPerSec`, `ai.catchRangeTiles` |
| Loot lost when thrown off (Devlin asked for a loss in the M3 playtest 2026-10-18; all of it since Devlin's PR #36 playtest, 2026-10-27) | a guard throwing you off takes everything you carry, with an ALL LOOT LOST notice over your head; a fall (rock, jump or slip) loses half, rounded up, picked at random | `ai.thrownOffLootShare`, `ai.fellLootShare` |
| Boost acceleration (Claude's pick in M3) | 20 tiles/s² while boosting | `horse.boost.accelTilesPerSec2` |
| Car size (Devlin, 2026-10-17) | 28 × 7 mail and blank cars, a 16 × 7 engine and 12 × 7 caboose; the `small-cars` preset keeps the 16 × 6 set | layouts in `cars-src/`, `small-*` ids |
| Crouch speed (Claude's pick, sneaking PR 1) | a quarter of full speed (2 tiles/s, half a walk), however hard you push | `player.crouch.speedScale` |
| Crouch noise (Devlin, 2026-10-20: guards hear you sneak right behind them) | 1 tile, times the cell's noise | `ai.noise.crouchRadiusTiles` |
| Searching loot noise (Devlin, 2026-10-20: guards further away may hear you rummaging) | 3 tiles, crouched or not (between walking 1.5 and running 5) | `ai.noise.searchRadiusTiles` |
| Good-landing stumble noise (Devlin, PR #35 playtest, 2026-10-20: loud, like running) | 5 tiles while the stumble lasts (`boarding.landing.stumbleSec`), moving or not; the stumble after a failed mount makes it too | `ai.noise.stumbleRadiusTiles` |
| Cover that hides a crouched player (design doc) | a cell with cover 0.25 or more on the sight line (crates 0.5, barrels 0.4, benches 0.25; Devlin, 2026-10-20) | `ai.sight.crouchCoverMin` |
| Chase give-up (design doc) | 3 s without sight or sound: the guard stays alert, walks at patrol speed to where it last knew you were and looks one way and the other, catching no one | `ai.loseSightSec` |
| Car spacing (Claude's pick, sneaking PR 2; Devlin wanted a visible gap) | a half-tile end platform at each end of every car (Devlin, 2026-10-21; 1 tile before) and a 1-tile coupling gap, so car bodies sit 2 tiles of track apart; fractions of a tile allowed, any depth over 0 walkable (Devlin, 2026-10-21) | `outside.platformDepthTiles`, `outside.couplingGapTiles` |
| Coupling plate (Claude's pick, sneaking PR 2) | 3 tiles wide across the gap, centred on the car (the end door rows of a 7-row car; 2 on the 6-row small cars) | `outside.gangwayWidthTiles` |
| Side ledges (design doc; width Claude's pick) | on, 0.1 tiles wide so they barely show (Devlin, 2026-10-21; 0.33 earlier that day, 0.5 on 2026-10-20, 1 before) along both long sides and round the platform corners; still one row of grid cells, narrowed to the width out from the wall; any width over 0 works, since on a ledge you press flat against the wall (half the ledge width across), and platforms and the coupling plate of any depth over 0 can be walked too: the walker's body only bumps into car cells (walls, props), never open air, and only its centre has to stand on something (Devlin, 2026-10-21) | `outside.ledges`, `outside.ledgeWidthTiles` |
| Open doorways (Devlin, PR #35 playtest, 2026-10-20) | end and side doors in a car's outer wall do not block sight, so guards see you on a platform through the end door and on the ledge by a side door (and along the train through the end doors); the ledge between doors and windows is where you hide | `outside.seeThroughDoorways` |
| Outside speeds (design doc) | platforms and the coupling 4 tiles/s (walking, no running), ledges 1.2 tiles/s, crouched or not | `outside.platformSpeedTilesPerSec`, `outside.ledgeSpeedTilesPerSec` |
| Outside noise (platform Claude's pick; ledge Devlin, 2026-10-21) | platforms and coupling 1 (like floor); moving on a ledge carries 1.5 tiles at any pace, crouched or not, so only a guard just the other side of the wall hears you | `outside.platformNoise`, `outside.ledgeNoiseRadiusTiles` |
| Suspicious guards outside (Devlin, 2026-10-21) | a suspicious guard whose sighting or sound was outside the car walks out to look there | `ai.suspiciousStepOutside` |
| Suspicious guards approach (Devlin, 2026-10-21) | a suspicious guard walks toward where it saw or heard you, at patrol speed, instead of standing and staring; an alert one chases at chase speed as before | `ai.suspiciousApproach` |
| Trackside rocks on a ledge (design doc; probe Claude's pick) | blocked ground within 0.3 tiles outward of you scrapes (the collision scrape damage, 1 health, once per collision cooldown); blocked ground under you knocks you off onto the horse like being thrown off (failure damage, half the loot), but the train's doors stay open (Devlin, 2026-10-21) | `outside.scrape.glanceTiles`, `outside.scrape.knockOff`, `outside.scrape.closeDoors` |
| Roofs and ladders (design doc; Claude's pick, sneaking PR 3) | on; ladders on two of every three cars (Devlin's PR #36 playtest, 2026-10-27; which cars is a hash of the train's car list, at least one), at both ends of each, in its second row from the left (row 1), on the end platform; E within 1 tile of its foot (on the platform) or its top (on the roof) climbs, taking 1 s; no side ladders (Phase 3) | `outside.roof.enabled`, `outside.roof.ladderCarShare`, `outside.roof.ladderEnds` (`both`, `front`, `rear`), `outside.roof.ladderRow`, `outside.roof.ladderReachTiles`, `outside.roof.climbSec` |
| Roof speed (Claude's pick) | 5 tiles/s at full push (slower than the 8 inside), half that walking, crouched times `player.crouch.speedScale`; the long edges stop you, walking off an end drops you onto the platform below with a 0.6 s stumble | `outside.roof.speedTilesPerSec`, `outside.roof.dropStumbleSec` |
| Roof noise (Claude's pick) | heard only by a guard inside the car under you: walking 3 tiles, running 6, crouched 1.5; landing a jump thumps 6 tiles for 0.25 s | `outside.roof.noise.walkRadiusTiles`, `runRadiusTiles`, `crouchRadiusTiles`, `landRadiusTiles`, `landSec` |
| Seen on a roof (requirement; distances Claude's pick) | guards inside never see the roof; a guard out on a platform, the coupling or a ledge sees you up there when you are within 1.5 tiles of the edge on its side (crouched 0.5), in its range and cone; a guard on a roof sees you on the roofs in its cone out to 30 tiles, so the whole car and more (Devlin's PR #36 playtest, 2026-10-27) | `outside.roof.edgeSeenTiles`, `outside.roof.crouchEdgeSeenTiles`, `outside.roof.guardSightTiles` |
| Guards climb up (requirement) | a guard that hears or sees you on a roof goes to the nearest ladder in its car, climbs up and checks; an unaware guard on a roof climbs back down to its post; off, it only turns to the sound | `outside.roof.guardsClimb` |
| Gap jump (Claude's pick) | Space on a roof jumps the way you move: 0.5 s in the air, covering your speed for that time plus 0.75 tiles, so a full run from the edge clears the 2-tile gap and a walk drops you short onto the platform or coupling (stumble) or off the train (a fall, like a rock knock-off); the views lift you up to 0.6 tiles mid-jump so it reads as a jump (Devlin's PR #36 playtest, 2026-10-27) | `outside.roof.jump.airSec`, `outside.roof.jump.pushTiles`, `outside.roof.jump.liftTiles` |
| Slip on curves (Claude's pick; measured pull on the default maps up to about 2 tiles/s²) | the curve's pull (train speed squared times the track's curvature under the car) times your share of the top roof speed at 0.6 tiles/s² or more (was 1.2; lowered in Devlin's PR #36 playtest, 2026-10-27 so the open line's gentler curves slip too, and walking can slip on the tight ones) starts a slip toward the outside of the bend at 3 tiles/s; pushing the other way for 0.3 s recovers, off the edge is a fall; 1 s before the next slip | `outside.roof.slip.enabled`, `thresholdTilesPerSec2`, `slideTilesPerSec`, `leanSec`, `cooldownSec` |
| Falling off alerts guards (Devlin's PR #36 playtest, 2026-10-27) | a fall off a roof alerts the guards in that car and 1 car either side: an unaware one turns suspicious, and each walks out to the ledge where you went over and looks for at least 8 s | `outside.roof.fallAlert.enabled`, `cars`, `checkSec` |
| Loot total on getting away (Devlin's PR #36 playtest, 2026-10-27) | extracting or cashing out shows LOOT: $total and the item count in the top right for 4 s | `hud.lootTotalSec` |

### Phase 2 checklist

Legend as in the Phase 1 checklist. The live plan holds the task lists; this records what was built.

- [x] **M1: countdown, heat and run end** (branch `claude/phase-2-m1-countdown-heat`). `countdown.enabled` is on: at commit the run copies the train's `countdown.baseSec` × `countdown.scale` into `run.countdownSec` (the blank train has a 150 s base until the mail train lands), and `countdownSystem` (`packages/sim/src/rules/heat.ts`, tick system 10, before run end) drains it each tick at `1 + heatDrainFactor × heat/100`; `countdown.startsAt: boarding` holds the clock until the player lands aboard. Heat lives in `RunState` (0 to `heat.maxHeat`) and only `raiseHeat` changes it, emitting `HeatChanged` with the amount actually added and the cause; `raiseHeatFor` adds a `heat.sources` amount for loot, guards and combat to call later. `heat.sources.timeAboardPerSec` (0.33 by default after the M1 playtest, so about +1 heat every 3 s aboard) builds up per tick aboard and is raised a whole point at a time, so each gain is one event. At zero the run ends `expired` in the run end system (a death on the same tick wins), applying `outcomePolicy.expired` (wanted +1) and resetting to `playerSpawn` like a cancel. The grace window (`countdown.graceSec` 3 s, counted in `run.graceTicks`) sits behind `graceApplies`, which returns false until the extraction horse exists (M4). `heat.boardingResistanceAt` (null, off) is read only by `boardingResistanceActive`, a hook for phase 3. `RunStarted` carries the countdown and wanted level; `RunEnded` carries `countdownLeftSec` (kept on cancels and quick retries, U6) and `heat`. `loot.densityScale` is a plain value nothing reads until M2. Presets gained `extends` and `values`, and `?set=path=value` overrides any value (see Selecting a setup); `medium-run` (scale 4, density 4) and `no-time-aboard-heat` (0 per second) build on `alpha-default`. The HUD has a countdown bar (green, amber below 50%, red and blinking below 20%) whose stripes slide at the drain rate beside a `×1.6` style readout, a heat meter in three bands, a notice per heat gain, and a pulsing red screen edge after an alarm. An `AudioBus` (`packages/client/src/audio.ts`) synthesizes a countdown tick per countdown second (so it speeds up with heat) that doubles below 20%, a heat blip, the alarm sting and an expiry tone; U mutes (M is the minimap). With no loot or guards yet, H raises heat by `playtest.debugHeatStep` (cause `debug`) and Shift+H raises an alarm's worth, as the `debugHeat` command, so it replays. The Playtests page records expired runs, time left and heat at end; the bots press the debug heat keys and check heat and the countdown stay in range; the golden run raises heat once
- [x] **M2: mail train and loot** (branch `claude/phase-2-m2-mail-train-loot`, PR #17). The Tiled car pipeline: `tools build-cars` (`packages/tools/src/cars/`) runs every check under Car Tiled workflow and writes `base/car-templates.json`, `tools sync-car-tileset` writes `cars-src/cars.tsj` and `cars.png` from `cell-types.json` with stable tile ids, and `npm run cars`, `cars:watch` and `cars:check` wrap them. Six layouts are generated to edit (see As built under Cell types and car templates). `cell-types.json`, `items.json` and `loot-tables.json` are config catalogs, merged before variants, hashed with the config and checked for references. `trains.mail-express` is the default train (engine, 3 mail cars picked per run, caboose, 9 tiles/s, 150 s countdown base, `mail-small-items` at density 0.6); `trains.blank` is the decoy. `packages/sim/src/world/generate.ts` picks layouts (`pickTrainCars`) and fills loot at commit from the `gen` stream (`generateLoot`); free trains re-pick their layouts at each run end. `trainPoint` joins the cars end to end. `packages/sim/src/world/loot.ts` is the search, carry and drop system, after walking and before run end. `interact` is a press and release pair: `held: true` on press commits when idle and searches aboard, `held: false` on release cancels. Walking slows by `carry` weight and to `verbs.search.walkSpeedScale` while searching. The `drop` command puts an item on the floor of the player's cell, where it can be searched again. Variant groups `lootCarry` (`limit-and-slowdown`, `unlimited`) and `trainMix` (`map`, `all-mail`, `mixed`, `mostly-blank`; the map's own `trains` list, else `trainMix.trainCount` slots along the route). Train names on the arrows are hidden by default (`hud.showTrainNames: false`, Devlin 2026-10-14); `?trainNames=on` or `off` overrides. Presets `long-train`, `slow-search`, `no-carry-limit`, `doors-both-sides` and `map-trains`. The iso view draws the open car's walls, props, windows and loot (`packages/client/src/iso/interior.ts`) and the doors on every car's outside. The HUD shows carried value, weight, items and speed. The `?car=` scene is in. The golden run walks to and searches a loot item; the bots loot and check carry and loot invariants. Each pickup calls `raiseHeatFor(ctx, 'lootTaken')`, and generation scales density by `loot.densityScale`, both from M1; mail-express also has its `countdown.baseSec` of 150 s. Each Playtests page run record keeps `lootValue` and `lootItems`, the loot carried at run end (picked up minus dropped), shown as a Loot column, an Avg loot per setup, and in the CSV and GitHub summary (Devlin, 2026-10-14). After the M2 playtest (Devlin, 2026-10-14): items may set their own `searchTimeSec` (letters 0.8 s, large prizes 2.2 s) and `verbs.search.timeScale` scales all (slow-search 2.5); `verbs.search.hiddenLoot` is on; I opens an inventory panel where 1-9 drop that item (`drop` with its slot); the caboose has loot slots; the engine has a cab behind the boiler you can walk into through its rear end door (`tools validate` checks it joins the next car); `trains.<id>.maxSideDoorCars` caps the cars with side doors after `requireSideDoors` (long-train: 2, with `loot.densityScale` 0.7); blank cars are a slightly greyer brown than mail cars; the carry stats sit under the health bar. Then (Devlin, 2026-10-14): searching a hidden stash takes `verbs.search.hiddenSearchTimeSec` (1.8 s) and reveals its item (`LootRevealed`) instead of taking it, so it is searched again to take; `trainMix` defaults to `mixed` (preset `map-trains` for the map's own trains); `long-train` no longer scales the countdown; the engine's front is solid wall, with only the cab walkable. The HUD's phase sits at the top of the countdown panel (always shown, the countdown and heat appear under it during a run), health is a heart and a bar, health and carry drop below the panel on screens under 1000 px, and the inventory (I) is a strip along the bottom above the prompt.
- [x] **M3: light guards and the horse boost** (branch `claude/phase-2-m3-guards-boost`, PR #28, v0.2.3). `packages/sim/src/world/guards.ts`: `guardCount` is the train's `guards.base` plus `guards.perCar` per car with guard spawns (rounded; 0.67 on the mail express, so 2 guards on 3 cars, after Devlin's playtest on 2026-10-17) plus `wantedGuardBonus` (0 until M5); `generateGuards` picks that many of the train's `guardSpawns` from the `gen` stream after the loot, at commit and on a train switch (which now regenerates loot too). Guards live in `run.guards` in car-frame coordinates; perception and pathing work in train coordinates (`trainGrid`: the cars laid end to end). Sight is a range plus a cone test against `ai.sight.coneCos` (derived from `coneHalfAngleDeg` at config resolve, so no trig in the sim), with the line sampled every 0.2 tiles against `blocksSight` cells. Hearing is `ai.noise.walkRadiusTiles` or `runRadiusTiles` (a move axis above 0.75 counts as running) times the player's cell `noise`. `guardSystem` runs after walking: unaware turns suspicious on sight or noise, and suspicious turns alert after `ai.alertAfterSec` in view. Calm-downs come after `calmSec` and `alertCalmSec`. The first sighting of an episode emits `PlayerSpotted` and `playerSpotted` heat; going alert raises `alarmRaised` heat, both through `raiseHeatFor`. Unaware guards ping-pong along their layout's patrol (a loop when its ends are adjacent) with `patrolPauseSec` stops, or stand watch at their post; aware guards turn toward the last place they saw or heard you. Guards and the player keep 0.6 tiles apart. `guardCatch` variant: `thrown-off` (the default after Devlin's playtest on 2026-10-17) or `heat-only`. In thrown-off an alert guard chases at `chaseSpeedTilesPerSec` (4-connected BFS) and within `catchRangeTiles` `throwOff` puts the player on the horse 1.5 tiles off the car's side at the failure speed, stunned, with failure damage (cause `thrownOff`) (`ThrownOff`), and loses `ai.thrownOffLootShare` of their carried items, rounded up, picked at random from the `ai` stream (`LootLost`; Devlin, M3 playtest 2026-10-18). Horse boost: `boost` command (C), `horse.boost` 1.5 s at ×1.4 top speed, 6 s cooldown, only for a ridden horse that is not stunned; after it the horse reins back in at the brake rate. `handlingModel` variant: `arcade-boost` (default) or `arcade` (boost off). Presets `heat-only` and `no-boost`. Views draw guards (amber ● suspicious, red ! alert); sight cones coloured by state are drawn faint by default so you can read where guards look, full with the debug overlay (`` ` ``) or `?cones=on`, and hidden with `?cones=off`; aboard, a ring on the floor shows how far your footsteps carry (`?noiseRing=off` hides it); a guard that hears you shows an ear badge over its head; the HUD shows spotted, alarm and thrown-off (with lost items) notices and a boost meter; boosting kicks up dust behind the horse in the iso view (`?boostDust=` scales its opacity, 0 hides it). Bots sweep both groups and check guards on walkable cells and boost bounds; the bench runs the default preset with thrown-off guards (about 9 µs per tick); the golden run boosts and is spotted until a guard raises the alarm
- [x] **M4: extraction** (branch `claude/phase-2-m4-extraction`). `whistle` (F) works aboard: it draws the arrival delay from the `horse` stream (`extraction.arrivalDelaySec`, 5 to 20 s), moves the run to `extracting` and places the riderless horse (`packages/sim/src/extraction.ts`) behind the train on the side of the car the player stands nearest (G12), on the lane `extraction.laneOffsetTiles` out. It is placed back along the track from the player's car by the distance the delay closes at `horse.maxSpeed` against the train (25 to 100 tiles on the mail train), and at least 4 tiles behind the last car. After a boarding jump the horse stays physical: it runs off outward for `horse.runOffSec` and is then removed (`mode: 'away'`). `run.horse` holds the call state (`away`, `approaching`, `alongside`, `leaving`), so a snapshot resumes mid-extraction. The riderless horse rides through `ride` with an AI intent (steer toward a point plus a throttle to a target speed, never the boost): behind the player's car it follows the lane car by car at full speed, then matches the train with a small lead. When the straight line to the lane crosses blocked, water or deep tiles it follows an A* path over a coarse grid of `extraction.pathCellTiles` cells (`world/path.ts`, replanned twice a second), and `HorseBlocked` (`no path` or `stuck` after `extraction.stuckSec` with no progress) shows on the HUD. Within `extraction.alongsideRangeTiles` of the lane it is `alongside` (`HorseArrived`) for `extraction.paceWindowSec` (10 s), then `leaving`: it drops back for `extraction.dropBackSec` and is removed, and another whistle waits `extraction.rewhistleCooldownSec` (5 s) (`HorseDeparted`). A whistle from the other side while it comes or is alongside sends it there (`HorseSideChanged`), dropping back past the last car and crossing behind it. The mount (`world/mount.ts`): with the horse alongside, the player within `extraction.doorReachTiles` of a side door on its side and the horse within `extraction.mountRangeTiles` of that door, the meter sweeps at `extraction.meter.sweepPeriodSec` with its own zones and Space jumps (`MountAttempt`). Perfect extracts clean; good spills loot by the `mountSpill` variant (`random` one item from the `misc` stream, `heaviest`, or `share`, which loses `extraction.spillShare` of the value; `LootSpilled`); fail costs `boarding.failure.damageFraction` health, a stumble, and the player can try again. A mount ends the run `extracted`, which banks the carried value (`outcomePolicy.extracted`, `RunEnded.cashOut`); the player rides off on the horse, and auto-commit waits until they leave commit range. `graceApplies` is now `escaping`: horse alongside and the player at a door on its side. The client: F whistles, the riderless horse is drawn without its rider, the mount meter shows over the player while the horse is alongside, a side-panel line says the horse is coming, alongside (seconds left), blocked or cooling down, hoofbeats play within 25 tiles, louder as it closes. Presets `spill-heaviest`, `spill-share`. The Playtests page has an Extracted column and each record keeps `cashOut`, whistles and mount attempts. The golden run whistles and the horse rides up; the chaser bot whistles, walks to a door and mounts, and the invariants check the horse is in the world aboard only while called. Merged after M3: a guard that throws you off (`guardCatch: thrown-off`) puts you back on your horse beside the train wherever the horse was and ends the call, guards keep watching while extracting, the riderless horse never boosts, and the train just extracted from uses M3's `commitHold`. Claude's picks (not decided values): drop back 3 s, alongside within 3 tiles, mount reach 4 tiles from the door, door reach 1.5 cells, share spill 30%, path cells 3 tiles, stuck after 3 s, pass through beyond 30 tiles, good-mount stun 1 s. After Devlin's playtest (2026-10-19): a good mount stuns the horse for `extraction.goodMountStunSec` and "LOST LOOT" rises over the rider (`?lostLootText=off`); beyond `extraction.passThroughBeyondTiles` from the player's car the riderless horse ignores rocks and water (no collision, no wading, no path or stuck checks), so it only gets stuck on screen; hoofbeats also play while riding, at 0.3 of the called horse's volume and slower at low speed (`?rideHoofbeats=` scales them, 0 mutes). Seeing the horse come is enough (G11 answered), so the `horseArrivalCue` group, its `visible-timer` variant and the `arrival-timer` preset were removed. While grace holds expiry "OUT OF TIME: jump now!" with the grace left shows just above the mount meter, and in the last 10 s with the horse alongside it says a door gives the extra seconds.
- [x] **Sneaking PR 1: stealth inside and bigger cars** (branch `claude/phase-2-sneaking-crouch-cover-lfbcal`). Cars are 28 × 7 (mail-car-a/b/c, blank-car) with a 16 × 7 engine and 12 × 7 caboose; every car has 7 rows and end doors in rows 2 to 4. The 16 × 6 set stays as `small-*` layouts (car types `small-mail-car` and `small-blank-car`) for the `small-cars` preset. Big Country's west and east services start at 550 and 150 tiles so the longer trains keep apart. `crouch` command (C aboard; the client toggles it, or `?crouch=hold` crouches while C is held): `PlayerRunState.crouched`, cleared on landing and when thrown off; crouched walking is `player.crouch.speedScale` of full speed and makes `ai.noise.crouchRadiusTiles` of noise; `lineOfSight` takes a cover threshold and `canSee` uses `ai.sight.crouchCoverMin` for a crouched player (the grid now carries each cell's `cover`). A chasing guard counts `lostTicks` without sight or sound; at `ai.loseSightTicks` it emits `GuardLostTrack` and searches (`isSearching`): still alert, it walks at patrol speed to the last known spot, sweeps its gaze, and does not catch; seeing or hearing you resets it. Views draw a crouched player low (iso) or smaller (top-down), and a red ? over a searching guard; the HUD prompt says when you are crouched. The golden run creeps crouched before it is spotted; the test bots ride a tile out from the car side whatever its width.
- [x] **Sneaking PR 2: platforms and side ledges** (branch `claude/phase-2-sneaking-platforms-ledges`, PR #35, merged as v0.2.4). `outside` config section. `placeCars` spaces car bodies `carSpacing` (2 × platform + gap, 2 tiles by default) apart, `trainLength` adds the spacing and the last car's rear platform, and the horse collides with each car's platforms as well as its body. `trainGrid` lays the train out with the outside round each car: grid rows add a ledge on each side (`rowOffset`, so the left ledge is car-frame y < 0), each car's stretch (`starts`) is its front platform, body, rear platform and then the coupling gap, which belongs to the car in front; each cell carries a `space` (`Space.Inside`, `Platform`, `Ledge`, `Coupling`, `None`) and a `speedCap`. Outside cells never block sight (the gap is open air, walkable only on the coupling plate), so a guard inside sees a ledge through window cells, and with `outside.seeThroughDoorways` through the doors in a car's outer wall too. A ledge under a tile wide still takes a row of cells; `yMin`/`yMax` per cell narrow where one can stand (`gridWalkable`), while `gridCellOpen` tests a walker's edges (`walkerFits`, which presses a walker on a ledge flat against the wall). Fractional platforms and gaps get whole columns with the outermost cut short (`colX`, `gridCol`), so train x matches the world spacing. The iso view draws guards in a closed car that the player has line of sight to (through doorways, within sight range) over its roof, with their cones. A good landing staggers `boarding.landing.goodStumbleInTiles` in from the door (`stumbleIn` in run.ts). `walkAboard` walks the grid (the car frame's x is kept as it is inside a car), caps speed by the cell, and moves you into the next car's frame when you cross into its stretch; `trainPoint` is gone. Guards cap their speed by the cell too; unaware guards path inside the cars only (`distancesTo` insideOnly), chasing and searching guards follow you out. `ledgeRockSystem` (tick system 5b, after walking) scrapes or knocks off a player on a ledge; a knock-off calls `throwOff(ctx, p, null)`, which emits `FellOff` (cause `rock`), damage and lost loot with cause `fell`, and puts the horse down clear of the rocks. Views draw platforms, ledges (darker when `outside.ledges` is off) and the coupling plate on every car (`packages/client/src/iso/outside.ts`, and the top-down view), and guards out on a platform, the coupling or a ledge show from anywhere; the HUD prompt says when you are on a ledge or a platform, and a notice when a rock knocks you off. The junction branch test uses a two-car mail train, since a three-car one no longer fits its 120-tile shared segment. Two big-window mail layouts, `mail-car-d` and `mail-car-e`, join the pool (preset `big-windows` picks only them); the golden pins the mail train to `mail-car-a`, `b` and `c` so new layouts don't change its story. The golden run was re-recorded.
- [ ] **Sneaking PR 3: train roofs** (branch `claude/phase-2-sneaking-3-roofs`, v0.2.4-sneaking-3). `outside.roof` config. `trainLadders` puts a ladder on each end platform (`Ladder`: foot on the platform at `deckLx`, top `ROOF_STEP_IN` in on the roof); the `climb` command (E aboard at a ladder, `ladderInReach`) takes `climbSec` and moves you between the platform and the roof (`Climbed`). Placements gain `layer: 'roof'` (`Space.Roof`, never stored in a cell; `onRoof`, `roofCarAt`). `packages/sim/src/world/roof.ts` is tick system 5a, after walking aboard and before the trackside rocks: roof walking, the gap jump (`jump` on a roof is `roofJump`: `RoofJumped`, then `RoofLanded` on a roof, the platform, coupling or a ledge, or a fall), and slips from `curvePull` (`RoofSlipped`, `RoofRecovered`). A fall calls `throwOff(ctx, p, null, cause)`, and `FellOff` carries a cause (`rock`, `jump`, `slip`). `PlayerRunState` gains `climb`, `air`, `slip`, `slipCooldownTicks` and `thudTicks`. Guards (`guardSees`, `moveGuard`): inside never sees the roof, a guard outside sees you on the edge on its side, a guard on a roof sees the roofs; roof noise is heard only in the car under you; a guard who heard or saw you up there walks to a ladder and climbs (`GuardState.roof`, `climb`, `GuardClimbing`), and an unaware one climbs back down. Loot, drops and mounting are refused on the roof. The iso view draws ladders, keeps the car closed while you are on its roof or ladder, draws you and roof guards up there with their cones and the footstep ring, peeks at the guards in the car under you (`?roofPeek=off`), and marks where a jump would land (`?jumpCue=off`: green on a roof, amber short, red off the train). The HUD prompt says when you are at a ladder, climbing, on the roof, in the air or slipping; notices say when a guard below heard you and when one is climbing up. Bots climb, jump and slip (the chaser's roofer), and `tools report` counts roof events. The golden run was re-recorded. After Devlin's PR #36 playtest, 2026-10-27: ladders on 2 of 3 cars (`ladderCarShare`; the chaser's roofer only climbs from a car with a front ladder), roof guards see 30 tiles (`guardSightTiles`), slip threshold 0.6, guard cones 55°, thrown off by a guard loses all loot (`thrownOffLootShare` 1, falls `fellLootShare` 0.5) with an ALL LOOT LOST notice, a fall alerts nearby guards (`alertGuardsToFall`), the views lift the jumper (`jump.liftTiles`), and a LOOT total box in the top right on extract or cash out (`hud.lootTotalSec`). Low bridges and signal arms over the roofs are a later idea, for the wiki Ideas page; not built.
- [ ] M5: wanted level, saving and score
- [ ] M6: tests, tuning and the run-length playtest
