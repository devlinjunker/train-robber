import type { RngState } from './rng';

export type PlayerId = number;

export type Command =
  /**
   * Quantized axes -127..127 in screen sense: x right, y down, so W sends y = -127.
   * Throttle is -y (W accelerates, S brakes). x steers relative to the horse's heading
   * under the heading-relative steering variant and is ignored under screen-relative.
   */
  | { type: 'move'; x: number; y: number }
  /**
   * Screen-relative steering: the world-space direction the horse should turn to face,
   * quantized like `move`. The client maps screen keys to world space, so the sim never
   * sees the screen. 0, 0 keeps the current heading. Ignored under heading-relative steering.
   */
  | { type: 'steer'; x: number; y: number }
  /**
   * E: commit to the train in range when idle (as `startRun` with no id). Aboard, E is held to
   * search a loot slot: the client sends `held: true` on press and `held: false` on release.
   */
  | { type: 'interact'; held: boolean }
  /** Drop carried item `slot` (0 is the first picked up) onto the floor, to swap it for another. */
  | { type: 'drop'; slot: number }
  /** Space: the boarding jump, sampling the meter on this tick. */
  | { type: 'jump' }
  /** Commit to a train; without an id, the nearest one that can be committed to. */
  | { type: 'startRun'; trainId?: string }
  /**
   * Tab: move the commitment to another free train during `approach` (or a failed jump's stun),
   * keeping the run, its timer and health. Without an id, the nearest one `switchTarget` names.
   */
  | { type: 'switchTrain'; trainId?: string }
  /** Esc: end the run in any phase but `ended` and reset to playerSpawn. */
  | { type: 'cancelRun' }
  /** R, while `playtest.quickRetry` is on: end the run and wait on the horse behind the train. */
  | { type: 'quickRetry' }
  /**
   * Playtest only, while `playtest.debugHeatStep` is above 0, so heat can be tried before loot and
   * guards exist. H raises heat by that step (cause `debug`); with `source` (Shift+H sends
   * `alarmRaised`) it raises what that source would, with its cause, as if the event happened.
   */
  | { type: 'debugHeat'; source?: HeatSource };

export interface InputFrame { player: PlayerId; commands: Command[] }

/** `idle` means no run; the others are `RunState.phase`. */
export type RunPhase = 'idle' | 'approach' | 'boarding' | 'aboard' | 'ended';
export type RunOutcome = 'died' | 'cancelled' | 'expired';
/**
 * What raised heat: an event-based source from `heat.sources`, time spent aboard
 * (`heat.sources.timeAboardPerSec`), or the playtest debug key.
 */
export type HeatCause = 'shotFired' | 'alarmRaised' | 'playerSpotted' | 'actorKilled' | 'lootTaken' | 'timeAboard' | 'debug';
/** Event-based heat sources in `heat.sources` (time aboard is per second instead). */
export type HeatSource = Exclude<HeatCause, 'timeAboard' | 'debug'>;
export type BoardingResult = 'perfect' | 'good' | 'fail';
/** What a horse ran into: a train car, or blocked ground (water and the map edge never hurt). */
export type CollisionTarget = 'train' | 'obstacle';
/** Why a `jump` was refused. Out of range is the boarding rule; a speed mismatch only speeds up the meter. */
export type JumpRejection = 'too far' | 'no run' | 'stunned' | 'aboard';
export type CommitRejection = 'run active' | 'no such train' | 'train taken' | 'out of range' | 'no train in range';
/** Why a `switchTrain` was refused; `aboard` also covers a run that has ended. */
export type SwitchRejection = 'no run' | 'aboard' | 'already committed' | 'no such train' | 'train taken' | 'out of range' | 'no train in range';
export type RejectReason = JumpRejection | CommitRejection | SwitchRejection | 'disabled' | 'nothing to interact with' | 'nothing to drop' | 'not aboard';
/** Why a finished search did not take its item: either carry cap would break. */
export type LootRefusal = 'too heavy' | 'too many items';

export type SimEvent =
  /** `countdownSec` is the run's whole countdown (null with `countdown.enabled` off). */
  | { type: 'RunStarted'; tick: number; player: PlayerId; runNumber: number; trainId: string; countdownSec: number | null; wantedLevel: number }
  | { type: 'RunPhaseChanged'; tick: number; player: PlayerId; from: RunPhase; to: RunPhase }
  /** The run's committed train changed; the run itself, its start tick and health carry on. */
  | { type: 'TrainSwitched'; tick: number; player: PlayerId; from: string; to: string }
  | { type: 'CommandRejected'; tick: number; player: PlayerId; command: Command['type']; reason: RejectReason }
  /** `meter` is the sampled position, 0 to 1. */
  | { type: 'BoardingAttempt'; tick: number; player: PlayerId; result: BoardingResult; attempt: number; meter: number }
  | { type: 'DamageDealt'; tick: number; target: PlayerId; amount: number; health: number; cause: 'boarding' }
  /** Running into or scraping a train, or running into blocked ground; `impact` is the speed the horse lost, tiles/s. */
  | { type: 'DamageDealt'; tick: number; target: PlayerId; amount: number; health: number; cause: 'collision'; against: CollisionTarget; kind: 'crash' | 'scrape'; impact: number }
  /** Every heat gain, after clamping to `heat.maxHeat`: `heat` is the new value, `delta` what was actually added. */
  | { type: 'HeatChanged'; tick: number; heat: number; delta: number; cause: HeatCause }
  /**
   * `retry` marks a quick retry, which ends the run as a cancel. `countdownLeftSec` is the time
   * left on the clock (kept for cancels too, so cancelling to dodge expiry is measurable, U6;
   * null with the countdown off) and `heat` the heat at the end.
   */
  | { type: 'RunEnded'; tick: number; player: PlayerId; outcome: RunOutcome; durationTicks: number; boardingAttempts: number; retry: boolean; countdownLeftSec: number | null; heat: number }
  | { type: 'PersistentChanged'; tick: number; before: PersistentState; after: PersistentState }
  /** A search finished and the item was taken. `car` is the car index in the train, `loot` the loot id. */
  | { type: 'LootPickedUp'; tick: number; player: PlayerId; item: string; value: number; weight: number; car: number; loot: number }
  /** A search finished but taking the item would break a carry cap, so it stays. */
  | { type: 'LootRefused'; tick: number; player: PlayerId; item: string; reason: LootRefusal; loot: number }
  | { type: 'LootRevealed'; tick: number; player: PlayerId; item: string; car: number; loot: number }
  | { type: 'LootDropped'; tick: number; player: PlayerId; item: string; value: number; weight: number; car: number; loot: number }
  /** Releasing E or moving off the slot loses the search's progress (`progress` 0 to 1). */
  | { type: 'SearchCancelled'; tick: number; player: PlayerId; loot: number; reason: 'released' | 'moved away'; progress: number };

export interface PersistentState { wantedLevel: number; bank: number; lifetimeEarned: number }

/** The boarding meter: a marker sweeping back and forth over a track from 0 to 1. */
export interface MeterState {
  /**
   * How far through one back-and-forth the marker is, 0 to 1. It advances by 1 / period each
   * tick in boarding range (slower when speed matched) and is 0 out of range.
   */
  phase: number;
  /** Centre of the good zone (the perfect zone sits in its middle), re-rolled after each jump. */
  zoneCentre: number;
}

export interface PlayerRunState {
  health: number;
  meter: MeterState;
  boardingAttempts: number;
  /** Ticks of good-landing stumble left; walk speed is scaled while above 0. */
  stumbleTicks: number;
  /** Ticks before another collision can hurt, so one crash costs health once. */
  hitCooldownTicks: number;
  /** What the last hit cost; inside the cooldown only a harder hit costs more, and only the difference. */
  lastHitDamage: number;
  /** Item ids carried, in pickup order; a `drop` slot indexes this. */
  carried: string[];
  /** The search in progress: which loot and how many ticks E has been held on it. */
  search: { loot: number; ticks: number } | null;
  /** Set when a search ends (taken, refused or moved away) while E is still held; cleared on release. */
  searchLatched: boolean;
}

/** A loot item lying in the committed train: placed by run generation, or dropped by a player. */
export interface LootState {
  id: number;
  /** Car index in the train, and the cell centre in that car's frame. */
  car: number;
  x: number;
  y: number;
  item: string;
  /** On a slot tagged hidden and not yet searched: drawn as a plain stash; searching it reveals the item and clears this. */
  hidden: boolean;
  taken: boolean;
}

export interface RunState {
  runNumber: number;
  startedTick: number;
  /** The committed (pinned) train. */
  trainId: string;
  phase: Exclude<RunPhase, 'idle'>;
  /**
   * Seconds left on the clock: the train's `countdown.baseSec` x `countdown.scale` at commit,
   * drained each tick at `1 + heatDrainFactor x heat/100` while `clockRunning` (U1, U2).
   */
  countdownSec: number;
  /** The whole countdown the run started with, for the HUD's bar. */
  countdownTotalSec: number;
  /** False until the clock starts: at commit, or on boarding with `countdown.startsAt: boarding`. */
  clockRunning: boolean;
  /** Ticks expiry has waited in the grace window so far (U3), up to `countdown.graceTicks`. */
  graceTicks: number;
  /** 0 to `heat.maxHeat`; only raiseHeat changes it. */
  heat: number;
  /** Time-aboard heat not yet added: it builds up per tick and is raised a whole point at a time, so each gain is one event. */
  pendingHeat: number;
  /** Integer keys only, so key order is stable. */
  players: Record<PlayerId, PlayerRunState>;
  /** Loot in the committed train, by ascending id. */
  loot: LootState[];
  nextLootId: number;
}

/**
 * Where a player is. `world` while mounted, with x and y following the horse; `car:<trainId>:<index>`
 * aboard, with x along the car's cells (0 at the front) and y across them (0 on the left side).
 */
export interface Placement {
  frame: string;
  x: number;
  y: number;
  layer: 'ground' | 'interior' | 'roof';
}

export interface PlayerState {
  id: PlayerId;
  /** The horse this player rides; every player starts mounted in phase 1. */
  horseId: number;
  /** Latest intents. Commands only arrive when they change, so they persist here. */
  move: { x: number; y: number };
  steer: { x: number; y: number };
  /** E is held (search). */
  interactHeld: boolean;
  placement: Placement;
  /**
   * The commit prompt's timer while idle: the train in commit range and how many ticks the rider
   * has stayed in range of it. Null when no train is in range or a run is active.
   */
  commitTimer: { trainId: string; ticks: number } | null;
}

export interface HorseState {
  id: number;
  x: number;
  y: number;
  /** Unit heading; turned by the per-tick rotation constants, never by angle. */
  hx: number;
  hy: number;
  /** Tiles per second along the heading, 0 to `horse.maxSpeed`. */
  speed: number;
  /** Target speed for the cruise throttle model, tiles per second. */
  cruiseTarget: number;
  /** Ticks of stun left after a failed jump: no steering or throttle, speed held. */
  stunTicks: number;
  /**
   * `physical` rides the map. `away` is the separate world mode's abstract horse while its
   * rider is aboard: not simulated and not drawn (extraction adds the other states in phase 2).
   */
  mode: 'physical' | 'away';
}

export interface TrainState {
  /** Instance id, the `trainId` that `startRun` will name. */
  id: string;
  /** Key into `config.trains`. */
  type: string;
  /** The route it runs on, when the map placed it; otherwise the one its config names. */
  route?: string;
  /** Distance of the engine's front along its route, wrapped. */
  d: number;
  /** Set when a run commits to this train (M3); the scheduler never replaces a pinned train. */
  pinnedBy: PlayerId | null;
  /**
   * Car template ids, engine first. Picked from the train type's layouts by the seed and the next
   * run number, so the train a run commits to has the layouts of that run's seed; re-picked for
   * every free train when a run ends.
   */
  cars: string[];
}

export interface WorldState {
  trains: TrainState[];
  horses: HorseState[];
}

export type Steering = 'screen' | 'heading';
export type ThrottleModel = 'hold' | 'coast' | 'cruise';

/**
 * The resolved config values the sim reads. `@train-robber/config`'s ResolvedConfig
 * satisfies this structurally, so the sim does not depend on the config package.
 */
export interface SimConfig {
  hash: string;
  values: {
    sim: { tickRateHz: number };
    player: { speedTilesPerTick: number };
    world: { mode: 'separate' | 'continuous' };
    /**
     * `auto`: an idle player commits as soon as a train is in range, with no key press.
     * `switchRangeTiles`: how close another train must be to switch the commitment to it with Tab.
     * `autoSwitch`: during a run, riding `autoSwitchMarginTiles` closer to another free train within
     * `rangeTiles` than to the committed one switches to it, with no key press.
     */
    commit: { rangeTiles: number; timerSec?: number | null; closeRangeTiles?: number | null; switchRangeTiles: number; autoSwitch: boolean; autoSwitchMarginTiles: number };
    boarding: {
      rangeTiles: number;
      speedToleranceTilesPerSec: number;
      meter: { sweepPeriodTicks: number; matchedSweepPeriodTicks: number; zoneWidths: readonly [number, number] };
      failure: { stunTicks: number; damageFraction: number; horseSpeedScale: number };
      landing: { stumbleTicks: number; stumbleSpeedScale: number };
    };
    health: { max: number };
    /** Running into a train or blocked ground while on a run. */
    collision: { damageFraction: number; obstacleDamageFraction: number; scrapeDamageFraction: number; minImpactTilesPerSec: number; fullImpactTilesPerSec: number; cooldownTicks: number };
    playtest: { quickRetry: boolean; quickRetryGapTiles: number; debugHeatStep: number };
    countdown: { enabled: boolean; startsAt: 'commit' | 'boarding'; scale: number; graceTicks: number };
    heat: {
      maxHeat: number;
      heatDrainFactor: number;
      sources: { shotFired: number; alarmRaised: number; playerSpotted: number; actorKilled: number; lootTaken: number; timeAboardPerTick: number };
      /** Off when null or absent. */
      boardingResistanceAt?: number | null;
    };
    outcomePolicy: {
      died: { bankRunLoot: boolean; wantedDelta: number; bankLossFraction: number; reset: readonly ('wantedLevel' | 'bank' | 'lifetimeEarned' | 'upgrades')[] };
      cancelled: { bankRunLoot: boolean; wantedDelta: number };
      expired: { bankRunLoot: boolean; wantedDelta: number };
    };
    horse: {
      /** Tiles per second. */
      maxSpeed: number;
      /** Tiles per second squared. */
      accel: number;
      brake: number;
      dragTilesPerSec2: number;
      cruiseTargetRateTilesPerSec2: number;
      slowZoneSpeedScale: number;
      waterSpeedScale: number;
      turnRateCosPerTick: number;
      turnRateSinPerTick: number;
      steering: Steering;
      throttleModel: ThrottleModel;
    };
    trains: Readonly<Record<string, TrainDef>>;
    trainMix: { mode: 'map' | 'all-mail' | 'mixed' | 'mostly-blank'; mailTrain: string; blankTrain: string; trainCount: number; blankShare: number };
    carry: { limitEnabled: boolean; slowdownEnabled: boolean; maxWeight: number; maxItems: number; slowdownFromWeight: number; minSpeedScale: number };
    verbs: { search: { searchTimeTicks: number; hiddenSearchTimeTicks: number; timeScale: number; walkSpeedScale: number; cancelRangeTiles: number; reachTiles: number; hiddenLoot: boolean } };
    /** Scales every train's loot density (a balance knob, like countdown.scale). */
    loot: { densityScale: number };
    cellTypes: readonly CellTypeDef[];
    items: Readonly<Record<string, ItemDef>>;
    lootTables: Readonly<Record<string, LootTableDef>>;
    carTemplates: Readonly<Record<string, CarTemplateDef>>;
  };
}

export interface TrainDef {
  route: string;
  speedTilesPerTick: number;
  engine: string;
  carType: string;
  carCount: number;
  layouts?: readonly string[];
  caboose?: string;
  requireSideDoors: 'both' | 'one' | 'off';
  /** At most this many of the train's cars get side doors (the long-train preset sets 2). */
  maxSideDoorCars?: number;
  /** The run's countdown is baseSec x countdown.scale, copied into the run at commit. */
  countdown: { baseSec: number };
  loot?: { table: string; density: number };
  verbs: readonly string[];
}

export interface CellTypeDef { id: string; blocksMove: boolean; blocksSight: boolean; cover: number; noise?: number; colour: string }
export interface ItemDef { name: string; value: number; weight: number; category: string; slotTags: readonly string[]; searchTimeTicks?: number }
export interface LootTableDef {
  items: readonly { item: string; weight: number }[];
  prizes?: { count: readonly [number, number]; items: readonly { item: string; weight: number }[] };
}
/** A car layout as `tools build-cars` writes it; cells are [col, row], col 0 at the front and row 0 on the left. */
export interface CarTemplateDef {
  carType: string;
  size: { cols: number; rows: number };
  legend: readonly string[];
  cells: readonly (readonly [number, number])[];
  entryPoints: readonly { id: string; side: 'left' | 'right' | 'front' | 'rear'; cell: readonly [number, number] }[];
  lootSlots: readonly { cell: readonly [number, number]; tags: readonly string[] }[];
  guardSpawns: readonly { cell: readonly [number, number]; facing: string; patrol?: string }[];
}

export interface GameState {
  tick: number;
  seed: string;
  /** Snapshots store the config hash, not the config; restoring needs the same config. */
  configHash: string;
  /** Likewise for the map: its id and a hash of what the sim reads from it. */
  mapId: string;
  mapHash: string;
  /** Runs started so far; run seeds derive from the seed and this count. */
  runCount: number;
  /** Trains spawned so far; instance ids derive from it. */
  trainCount: number;
  rng: RngState;
  persistent: PersistentState;
  run: RunState | null;
  world: WorldState;
  players: PlayerState[];
}

export interface TickResult { tick: number; events: SimEvent[] }
