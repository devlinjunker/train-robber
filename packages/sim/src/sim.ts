import { seedRng, runSeed } from './rng';
import { hashState } from './hash';
import type { GameState, InputFrame, PersistentState, PlayerId, SimConfig, SimEvent, TickResult } from './types';
import { prepareMap, type SimMap, type WorldMap } from './world/map';
import { advanceTrains, allCarPoses, spawnInitialTrains } from './world/trains';
import { ride } from './world/riding';
import type { CarPose } from './world/cars';

export interface SimOptions {
  config: SimConfig;
  /** The map the run is played on; `@train-robber/config`'s MapDef satisfies SimMap. */
  map: SimMap;
  seed: string;
  playerIds: PlayerId[];
  persistent?: PersistentState;
}

export interface Sim {
  step(inputs: InputFrame[]): TickResult;
  /** Live, read-only view for the renderer and HUD; copy it with snapshot() to keep it. */
  readonly state: Readonly<GameState>;
  /** Every train car's rectangle for the current tick. */
  cars(): CarPose[];
  readonly map: WorldMap;
  snapshot(): GameState;
  hash(): string;
}

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

const quantize = (v: number) => (v < -127 ? -127 : v > 127 ? 127 : v | 0);

export function createSim(opts: SimOptions): Sim {
  const map = prepareMap(opts.map);
  const spawn = map.playerSpawn;
  const state: GameState = {
    tick: 0,
    seed: opts.seed,
    configHash: opts.config.hash,
    mapId: map.id,
    mapHash: map.hash,
    runCount: 0,
    trainCount: 0,
    rng: seedRng(opts.seed),
    persistent: opts.persistent ? clone(opts.persistent) : { wantedLevel: 0, bank: 0, lifetimeEarned: 0 },
    run: null,
    // Every player starts mounted at playerSpawn, stopped, facing up the screen toward the track.
    world: { trains: [], horses: opts.playerIds.map((_, i) => ({ id: i + 1, x: spawn.x, y: spawn.y, hx: 0, hy: -1, speed: 0, cruiseTarget: 0 })) },
    players: opts.playerIds.map((id, i) => ({ id, horseId: i + 1, move: { x: 0, y: 0 }, steer: { x: 0, y: 0 } })),
  };
  spawnInitialTrains(state, map, opts.config);
  return wrap(state, opts.config, map);
}

export function restoreSim(state: GameState, config: SimConfig, simMap: SimMap): Sim {
  if (state.configHash !== config.hash) {
    throw new Error(`snapshot was taken with config ${state.configHash}, got ${config.hash}`);
  }
  const map = prepareMap(simMap);
  if (state.mapHash !== map.hash) {
    throw new Error(`snapshot was taken on map ${state.mapId} (${state.mapHash}), got ${map.id} (${map.hash})`);
  }
  return wrap(clone(state), config, map);
}

function wrap(state: GameState, config: SimConfig, map: WorldMap): Sim {
  return {
    step(inputs) {
      const events: SimEvent[] = [];
      // 1. Apply commands: validate and record intents.
      for (const frame of inputs) {
        const p = state.players.find((q) => q.id === frame.player);
        if (!p) continue;
        for (const c of frame.commands) {
          if (c.type === 'move') {
            p.move.x = quantize(c.x);
            p.move.y = quantize(c.y);
          } else if (c.type === 'steer') {
            p.steer.x = quantize(c.x);
            p.steer.y = quantize(c.y);
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
      // 2. Train scheduler, then 3. riding against the cars where they now are.
      advanceTrains(state, map, config);
      ride(state.players, state.world.horses, map, config, allCarPoses(state, map, config));
      state.tick += 1;
      return { tick: state.tick, events };
    },
    get state() { return state; },
    cars: () => allCarPoses(state, map, config),
    map,
    snapshot: () => clone(state),
    hash: () => hashState(state),
  };
}
