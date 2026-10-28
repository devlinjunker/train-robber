import { seedRng } from './rng';
import { hashState } from './hash';
import type { GameState, InputFrame, PersistentState, PlayerId, SimConfig, SimEvent, TickResult } from './types';
import { prepareMap, type SimMap, type WorldMap } from './world/map';
import { advanceTrains, allCarPoses, trainSpeed, spawnInitialTrains } from './world/trains';
import { ride } from './world/riding';
import type { CarPose } from './world/cars';
import { createWorldModel, walkAboard, type WorldModel } from './world/separate';
import { lootSystem } from './world/loot';
import { autoCommitSystem, autoSwitchSystem, boardingSystem, boost, cancelRun, cashOut, crouch, collisionSystem, debugHeat, quickRetry, reject, runEndSystem, startRun, switchTrain, throwOff, ledgeRockSystem, type RunCtx } from './run';
import { alertGuardsToFall, guardSystem } from './world/guards';
import { countdownSystem } from './rules/heat';
import { extractionSystem, horseIntent } from './extraction';
import { climb, roofJump, roofSystem } from './world/roof';

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
    world: { trains: [], horses: opts.playerIds.map((_, i) => ({ id: i + 1, x: spawn.x, y: spawn.y, hx: 0, hy: -1, speed: 0, cruiseTarget: 0, stunTicks: 0, boostTicks: 0, boostCooldownTicks: 0, mode: 'physical' })) },
    players: opts.playerIds.map((id, i) => ({
      id, horseId: i + 1, move: { x: 0, y: 0 }, steer: { x: 0, y: 0 }, interactHeld: false, commitTimer: null, commitHold: null, resumeRuns: [],
      health: opts.config.values.health.max, day: 1, hitCooldownTicks: 0, lastHitDamage: 0,
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
      const whistles = new Set<PlayerId>();
      const drops = new Map<PlayerId, number[]>();
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
            // Pressing E commits while idle; aboard, holding it searches (the loot system reads the
            // held state). A release only ends the hold.
            p.interactHeld = c.held;
            if (!c.held) continue;
            if (!state.run) startRun(ctx, p, undefined, 'interact');
            else if (state.run.phase !== 'aboard' && state.run.phase !== 'extracting') events.push({ type: 'CommandRejected', tick: state.tick, player: p.id, command: 'interact', reason: 'nothing to interact with' });
          } else if (c.type === 'switchTrain') {
            switchTrain(ctx, p, c.trainId);
          } else if (c.type === 'drop') {
            drops.set(p.id, [...(drops.get(p.id) ?? []), c.slot]);
          } else if (c.type === 'cancelRun') {
            cancelRun(ctx, p);
          } else if (c.type === 'quickRetry') {
            quickRetry(ctx, p);
          } else if (c.type === 'jump') {
            // On a roof, Space is the gap jump; anywhere else the boarding or mount jump.
            if (state.run && (state.run.phase === 'aboard' || state.run.phase === 'extracting') && p.placement.layer === 'roof') roofJump(ctx, p, (why) => reject(ctx, p.id, 'jump', why));
            else jumps.add(p.id);
          } else if (c.type === 'climb') {
            climb(ctx, p, (why) => reject(ctx, p.id, 'climb', why));
          } else if (c.type === 'debugHeat') {
            debugHeat(ctx, p, c.source);
          } else if (c.type === 'whistle') {
            whistles.add(p.id);
          } else if (c.type === 'boost') {
            boost(ctx, p);
          } else if (c.type === 'cashOut') {
            cashOut(ctx, p);
          } else if (c.type === 'crouch') {
            crouch(ctx, p, c.on);
          }
        }
      }
      // 2. Train scheduler, then 3. riding against the cars where they now are, and what the crashes cost.
      advanceTrains(state, map, config);
      const speedOf = (id: string) => trainSpeed(config, state.world.trains.find((t) => t.id === id)!.type);
      // A horse whose rider is aboard is riderless, steered by the extraction AI.
      // The horse runs into a car's end platforms as well as its body.
      const platform = config.values.outside.platformDepthTiles;
      const bodies = allCarPoses(state, map, config);
      const solid = platform > 0 ? bodies.map((c) => ({ ...c, halfLength: c.halfLength + platform })) : bodies;
      collisionSystem(ctx, ride(state.players, state.world.horses, map, config, solid, speedOf, horseIntent(ctx)));
      // 3b. The commit prompt's timer and close range commit an idle rider with no key; with
      // `commit.autoSwitch`, a run moves to another train the rider is clearly closer to.
      autoCommitSystem(ctx);
      autoSwitchSystem(ctx);
      // 4. Boarding, 5. movement aboard, 6-7. guards' perception and AI (an alert guard may throw
      // the player off), 8. extraction (whistles, the horse, mounting), 9. searching and drops,
      // 10. heat and countdown, 11. run end.
      // Space aboard is the mount jump: split those off before boarding can land anyone this tick.
      const aboardPhase = state.run?.phase === 'aboard' || state.run?.phase === 'extracting';
      const mountJumps = aboardPhase ? jumps : new Set<PlayerId>();
      boardingSystem(ctx, aboardPhase ? new Set<PlayerId>() : jumps);
      walkAboard(state, config);
      // 5a. Roofs: ladders, roof walking, gap jumps and slips (a bad jump or a slip is a fall).
      const offRoof = roofSystem(ctx);
      if (offRoof) { alertGuardsToFall(ctx, offRoof.p); throwOff(ctx, offRoof.p, null, offRoof.cause); }
      // 5b. Trackside rocks scrape a player on a ledge, or knock them off.
      const fell = ledgeRockSystem(ctx);
      if (fell) throwOff(ctx, fell, null);
      const caught = guardSystem(ctx);
      if (caught) throwOff(ctx, caught.player, caught.guard.id);
      extractionSystem(ctx, whistles, mountJumps);
      lootSystem(ctx, drops);
      countdownSystem(ctx);
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
