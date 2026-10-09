// Train scheduler: spawns trains, advances them along their routes and keeps the
// committed one. Phase 1 runs one blank train that loops forever.
import type { GameState, PlayerId, SimConfig, TrainState } from '../types';
import { expandCars, placeCars, type CarPose } from './cars';
import type { WorldMap } from './map';
import { wrapDistance } from './track';

/** The train type spawned at load in phase 1. */
export const PHASE1_TRAIN = 'blank';

function routeOf(map: WorldMap, config: SimConfig, type: string) {
  const def = config.values.trains[type];
  if (!def) throw new Error(`unknown train type ${type}`);
  const route = map.routes.get(def.route);
  if (!route) throw new Error(`train ${type} runs on route ${def.route}, which map ${map.id} does not have`);
  return { def, route };
}

/** Add a train of `type` with its engine's front at distance `d`. */
export function spawnTrain(state: GameState, map: WorldMap, config: SimConfig, type: string, d = 0): TrainState {
  const { route } = routeOf(map, config, type);
  state.trainCount += 1;
  const train: TrainState = { id: `${type}-${state.trainCount}`, type, d: wrapDistance(route, d), pinnedBy: null };
  state.world.trains.push(train);
  return train;
}

/** At load: the one blank train, its engine at the start of its route. */
export function spawnInitialTrains(state: GameState, map: WorldMap, config: SimConfig): void {
  spawnTrain(state, map, config, PHASE1_TRAIN, 0);
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
    const { def, route } = routeOf(map, config, t.type);
    t.d = wrapDistance(route, t.d + def.speedTilesPerTick);
  }
}

/** Every car of every train, placed for the current state, in train then car order. */
export function allCarPoses(state: GameState, map: WorldMap, config: SimConfig): CarPose[] {
  const out: CarPose[] = [];
  const scratch: CarPose[] = [];
  for (const t of state.world.trains) {
    const { def, route } = routeOf(map, config, t.type);
    for (const car of placeCars(t.id, expandCars(def.cars), route, t.d, scratch)) out.push(car);
  }
  return out;
}
