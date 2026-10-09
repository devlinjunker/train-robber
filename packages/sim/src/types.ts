import type { RngState } from './rng';

export type PlayerId = number;

export type Command =
  | { type: 'move'; x: number; y: number } // quantized axes -127..127
  | { type: 'startRun'; trainId?: number }
  | { type: 'cancelRun' };

export interface InputFrame { player: PlayerId; commands: Command[] }

export type SimEvent =
  | { type: 'RunStarted'; tick: number; player: PlayerId }
  | { type: 'RunCancelled'; tick: number; player: PlayerId };

export interface PersistentState { wantedLevel: number; bank: number; lifetimeEarned: number }
export interface RunState { runNumber: number; startedTick: number }
export interface PlayerState { id: PlayerId; x: number; y: number; vx: number; vy: number }

/**
 * The resolved config values the sim reads. `@train-robber/config`'s ResolvedConfig
 * satisfies this structurally, so the sim does not depend on the config package.
 */
export interface SimConfig {
  hash: string;
  values: {
    sim: { tickRateHz: number };
    player: { speedTilesPerTick: number };
  };
}

export interface GameState {
  tick: number;
  seed: number;
  /** Snapshots store the config hash, not the config; restoring needs the same config. */
  configHash: string;
  /** Runs started so far; run seeds derive from the seed and this count. */
  runCount: number;
  rng: RngState;
  persistent: PersistentState;
  run: RunState | null;
  players: PlayerState[];
}

export interface TickResult { tick: number; events: SimEvent[] }

export interface SimOptions { config: SimConfig; seed: number; playerIds: PlayerId[]; persistent?: PersistentState }
