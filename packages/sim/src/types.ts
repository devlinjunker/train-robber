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
  | { type: 'startRun'; trainId?: string }
  | { type: 'cancelRun' };

export interface InputFrame { player: PlayerId; commands: Command[] }

export type SimEvent =
  | { type: 'RunStarted'; tick: number; player: PlayerId }
  | { type: 'RunCancelled'; tick: number; player: PlayerId };

export interface PersistentState { wantedLevel: number; bank: number; lifetimeEarned: number }
export interface RunState { runNumber: number; startedTick: number }

export interface PlayerState {
  id: PlayerId;
  /** The horse this player rides; every player starts mounted in phase 1. */
  horseId: number;
  /** Latest intents. Commands only arrive when they change, so they persist here. */
  move: { x: number; y: number };
  steer: { x: number; y: number };
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
