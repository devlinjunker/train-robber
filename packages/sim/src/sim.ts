import { seedRng } from './rng';
import { hashState } from './hash';
import type { GameState, InputFrame, PersistentState, PlayerId, SimConfig, SimEvent, TickResult } from './types';
import { prepareMap, type SimMap, type WorldMap } from './world/map';
import { advanceTrains, allCarPoses, spawnInitialTrains } from './world/trains';
import { ride } from './world/riding';
import type { CarPose } from './world/cars';
import { createWorldModel, walkAboard, type WorldModel } from './world/separate';
import { boardingSystem, cancelRun, quickRetry, runEndSystem, startRun, type RunCtx } from './run';

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
  /** The world model `config.world.mode` selected. */
  readonly world: WorldModel;
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
    world: { trains: [], horses: opts.playerIds.map((_, i) => ({ id: i + 1, x: spawn.x, y: spawn.y, hx: 0, hy: -1, speed: 0, cruiseTarget: 0, stunTicks: 0, mode: 'physical' })) },
    players: opts.playerIds.map((id, i) => ({
      id, horseId: i + 1, move: { x: 0, y: 0 }, steer: { x: 0, y: 0 },
      placement: { frame: 'world', x: spawn.x, y: spawn.y, layer: 'ground' },
    })),
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
  const world = createWorldModel(map, config);
  return {
    step(inputs) {
      const events: SimEvent[] = [];
      const ctx: RunCtx = { state, map, config, world, emit: (ev) => void events.push(ev) };
      const jumps = new Set<PlayerId>();
      // 1. Apply commands: validate and record intents. Jumps are sampled by the boarding system.
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
          } else if (c.type === 'startRun') {
            startRun(ctx, p, c.trainId, 'startRun');
          } else if (c.type === 'interact') {
            // Phase 1: interact only commits. Aboard it will loot, inspect and so on.
            if (state.run) events.push({ type: 'CommandRejected', tick: state.tick, player: p.id, command: 'interact', reason: 'nothing to interact with' });
            else startRun(ctx, p, undefined, 'interact');
          } else if (c.type === 'cancelRun') {
            cancelRun(ctx, p);
          } else if (c.type === 'quickRetry') {
            quickRetry(ctx, p);
          } else if (c.type === 'jump') {
            jumps.add(p.id);
          }
        }
      }
      // 2. Train scheduler, then 3. riding against the cars where they now are.
      advanceTrains(state, map, config);
      ride(state.players, state.world.horses, map, config, allCarPoses(state, map, config));
      // 4. Boarding, 5. movement aboard, 11. run end.
      boardingSystem(ctx, jumps);
      walkAboard(state, world, config);
      runEndSystem(ctx);
      state.tick += 1;
      return { tick: state.tick, events };
    },
    get state() { return state; },
    cars: () => allCarPoses(state, map, config),
    map,
    world,
    snapshot: () => clone(state),
    hash: () => hashState(state),
  };
}
