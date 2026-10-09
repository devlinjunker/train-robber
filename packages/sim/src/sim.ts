import { seedRng, runSeed } from './rng';
import { hashState } from './hash';
import type { GameState, InputFrame, SimConfig, SimEvent, SimOptions, TickResult } from './types';

export interface Sim {
  step(inputs: InputFrame[]): TickResult;
  snapshot(): GameState;
  hash(): string;
}

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

export function createSim(opts: SimOptions): Sim {
  return wrap({
    tick: 0,
    seed: opts.seed,
    configHash: opts.config.hash,
    runCount: 0,
    rng: seedRng(opts.seed),
    persistent: opts.persistent ? clone(opts.persistent) : { wantedLevel: 0, bank: 0, lifetimeEarned: 0 },
    run: null,
    players: opts.playerIds.map((id) => ({ id, x: 0, y: 0, vx: 0, vy: 0 })),
  }, opts.config);
}

export function restoreSim(state: GameState, config: SimConfig): Sim {
  if (state.configHash !== config.hash) {
    throw new Error(`snapshot was taken with config ${state.configHash}, got ${config.hash}`);
  }
  return wrap(clone(state), config);
}

function wrap(state: GameState, config: SimConfig): Sim {
  const speed = config.values.player.speedTilesPerTick;
  return {
    step(inputs) {
      const events: SimEvent[] = [];
      for (const frame of inputs) {
        const p = state.players.find((q) => q.id === frame.player);
        if (!p) continue;
        for (const c of frame.commands) {
          if (c.type === 'move') {
            p.vx = Math.max(-127, Math.min(127, c.x | 0)) / 127 * speed;
            p.vy = Math.max(-127, Math.min(127, c.y | 0)) / 127 * speed;
          } else if (c.type === 'startRun' && !state.run) {
            state.runCount += 1;
            state.rng = seedRng(runSeed(state.seed, state.runCount));
            state.run = { runNumber: state.runCount, startedTick: state.tick };
            events.push({ type: 'RunStarted', tick: state.tick, player: frame.player });
          } else if (c.type === 'cancelRun' && state.run) {
            state.run = null;
            events.push({ type: 'RunCancelled', tick: state.tick, player: frame.player });
          }
        }
      }
      for (const p of state.players) { p.x += p.vx; p.y += p.vy; }
      state.tick += 1;
      return { tick: state.tick, events };
    },
    snapshot: () => clone(state),
    hash: () => hashState(state),
  };
}
