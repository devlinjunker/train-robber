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
  /** E: commit to the train in range when idle (as `startRun` with no id); later loot, inspect and so on. */
  | { type: 'interact'; held: boolean }
  /** Space: the boarding jump, sampling the meter on this tick. */
  | { type: 'jump' }
  /** Commit to a train; without an id, the nearest one that can be committed to. */
  | { type: 'startRun'; trainId?: string }
  /** Esc: end the run in any phase but `ended` and reset to playerSpawn. */
  | { type: 'cancelRun' }
  /** R, while `playtest.quickRetry` is on: end the run and wait on the horse behind the train. */
  | { type: 'quickRetry' };

export interface InputFrame { player: PlayerId; commands: Command[] }

/** `idle` means no run; the others are `RunState.phase`. */
export type RunPhase = 'idle' | 'approach' | 'boarding' | 'aboard' | 'ended';
export type RunOutcome = 'died' | 'cancelled';
export type BoardingResult = 'perfect' | 'good' | 'fail';
/** Why a `jump` was refused. The first three are the boarding rule; the HUD shows them. */
export type JumpRejection = 'too far' | 'too fast' | 'too slow' | 'no run' | 'stunned' | 'aboard';
export type CommitRejection = 'run active' | 'no such train' | 'train taken' | 'out of range' | 'no train in range';
export type RejectReason = JumpRejection | CommitRejection | 'disabled' | 'nothing to interact with';

export type SimEvent =
  | { type: 'RunStarted'; tick: number; player: PlayerId; runNumber: number; trainId: string }
  | { type: 'RunPhaseChanged'; tick: number; player: PlayerId; from: RunPhase; to: RunPhase }
  | { type: 'CommandRejected'; tick: number; player: PlayerId; command: Command['type']; reason: RejectReason }
  /** `meter` is the sampled position, 0 to 1. */
  | { type: 'BoardingAttempt'; tick: number; player: PlayerId; result: BoardingResult; attempt: number; meter: number }
  | { type: 'DamageDealt'; tick: number; target: PlayerId; amount: number; health: number; cause: 'boarding' }
  /** `retry` marks a quick retry, which ends the run as a cancel. */
  | { type: 'RunEnded'; tick: number; player: PlayerId; outcome: RunOutcome; durationTicks: number; boardingAttempts: number; retry: boolean }
  | { type: 'RunCancelled'; tick: number; player: PlayerId }
  | { type: 'PersistentChanged'; tick: number; before: PersistentState; after: PersistentState };

export interface PersistentState { wantedLevel: number; bank: number; lifetimeEarned: number }

/** The boarding meter: a marker sweeping back and forth over a track from 0 to 1. */
export interface MeterState {
  /** Ticks the marker has swept since eligibility began; 0 while not eligible. */
  sweep: number;
  /** Centre of the good zone (the perfect zone sits in its middle), re-rolled after each jump. */
  zoneCentre: number;
}

export interface PlayerRunState {
  health: number;
  meter: MeterState;
  boardingAttempts: number;
  /** Ticks of good-landing stumble left; walk speed is scaled while above 0. */
  stumbleTicks: number;
}

export interface RunState {
  runNumber: number;
  startedTick: number;
  /** The committed (pinned) train. */
  trainId: string;
  phase: Exclude<RunPhase, 'idle'>;
  /** Integer keys only, so key order is stable. */
  players: Record<PlayerId, PlayerRunState>;
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
  placement: Placement;
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
  /** Distance of the engine's front along its route, wrapped. */
  d: number;
  /** Set when a run commits to this train (M3); the scheduler never replaces a pinned train. */
  pinnedBy: PlayerId | null;
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
    commit: { rangeTiles: number };
    boarding: {
      rangeTiles: number;
      speedToleranceTilesPerSec: number;
      meter: { sweepPeriodTicks: number; zoneWidths: readonly [number, number] };
      failure: { stunTicks: number; damageFraction: number; horseSpeedScale: number };
      landing: { stumbleTicks: number; stumbleSpeedScale: number };
    };
    health: { max: number };
    playtest: { quickRetry: boolean; quickRetryGapTiles: number };
    outcomePolicy: {
      died: { bankRunLoot: boolean; wantedDelta: number; bankLossFraction: number; reset: readonly ('wantedLevel' | 'bank' | 'lifetimeEarned' | 'upgrades')[] };
      cancelled: { bankRunLoot: boolean; wantedDelta: number };
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
      turnRateCosPerTick: number;
      turnRateSinPerTick: number;
      steering: Steering;
      throttleModel: ThrottleModel;
    };
    trains: Readonly<Record<string, {
      route: string;
      speedTilesPerTick: number;
      cars: readonly { template: string; count?: number }[];
    }>>;
  };
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
