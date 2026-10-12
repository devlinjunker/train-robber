// Train scheduler: spawns trains, advances them along their routes and keeps the
// committed one. Phase 1 trains loop forever: the one blank train, or the ones the map lists.
import type { GameState, PlayerId, SimConfig, TrainState } from '../types';
import { expandCars, placeCars, type CarPose } from './cars';
import type { WorldMap } from './map';
import { wrapDistance } from './track';

/** The train type spawned at load in phase 1 when the map lists no trains. */
export const PHASE1_TRAIN = 'blank';

/** A train's config and route: the route the map placed it on, else the one its type names. */
export function routeOf(map: WorldMap, config: SimConfig, train: Pick<TrainState, 'type' | 'route'>) {
  const def = config.values.trains[train.type];
  if (!def) throw new Error(`unknown train type ${train.type}`);
  const id = train.route ?? def.route;
  const route = map.routes.get(id);
  if (!route) throw new Error(`train ${train.type} runs on route ${id}, which map ${map.id} does not have`);
  return { def, route };
}

/** Add a train of `type` with its engine's front at distance `d`, on `route` or its type's own. */
export function spawnTrain(state: GameState, map: WorldMap, config: SimConfig, type: string, d = 0, route?: string): TrainState {
  const { route: r } = routeOf(map, config, { type, route });
  state.trainCount += 1;
  const train: TrainState = { id: `${type}-${state.trainCount}`, type, ...(route ? { route } : {}), d: wrapDistance(r, d), pinnedBy: null };
  state.world.trains.push(train);
  return train;
}

/** At load: the map's trains, or else the one blank train with its engine at the start of its route. */
export function spawnInitialTrains(state: GameState, map: WorldMap, config: SimConfig): void {
  if (!map.trains) { spawnTrain(state, map, config, PHASE1_TRAIN, 0); return; }
  for (const t of map.trains) spawnTrain(state, map, config, t.type, t.d, t.route);
}

/**
 * Hook for M3: a run that commits to a train pins it, so a later scheduler that retires
 * or replaces trains leaves it alone. Returns false when the train is missing or taken.
 */
export function pinTrain(state: GameState, trainId: string, player: PlayerId): boolean {
  const t = state.world.trains.find((q) => q.id === trainId);
  if (!t || (t.pinnedBy !== null && t.pinnedBy !== player)) return false;
  t.pinnedBy = player;
  return true;
}

export function unpinTrain(state: GameState, trainId: string): void {
  const t = state.world.trains.find((q) => q.id === trainId);
  if (t) t.pinnedBy = null;
}

/** Tick system 2: move every train along its route at its configured speed, looping. */
export function advanceTrains(state: GameState, map: WorldMap, config: SimConfig): void {
  for (const t of state.world.trains) {
    const { def, route } = routeOf(map, config, t);
    t.d = wrapDistance(route, t.d + def.speedTilesPerTick);
  }
}

/** Every car of every train, placed for the current state, in train then car order. */
export function allCarPoses(state: GameState, map: WorldMap, config: SimConfig): CarPose[] {
  const out: CarPose[] = [];
  const scratch: CarPose[] = [];
  for (const t of state.world.trains) {
    const { def, route } = routeOf(map, config, t);
    for (const car of placeCars(t.id, expandCars(def.cars), route, t.d, scratch)) out.push(car);
  }
  return out;
}

/** One train's cars, placed for the current state; empty when the train is gone. */
export function carPosesOf(state: GameState, map: WorldMap, config: SimConfig, trainId: string): CarPose[] {
  const t = state.world.trains.find((q) => q.id === trainId);
  if (!t) return [];
  const { def, route } = routeOf(map, config, t);
  return placeCars(t.id, expandCars(def.cars), route, t.d);
}

/** A train's speed along its route in tiles per second. */
export function trainSpeed(config: SimConfig, type: string): number {
  return config.values.trains[type]!.speedTilesPerTick * config.values.sim.tickRateHz;
}
