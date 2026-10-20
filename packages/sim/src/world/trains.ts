// Train scheduler: spawns trains, advances them along their routes and keeps the committed
// one. On a loop trains run forever; which ones run comes from the map and the trainMix setting.
// On an open line (map `openLine`) trains run one way: they enter off the start of the line a
// headway apart and are removed once past its end.
import { nextInt } from '../rng';
import type { GameState, PlayerId, SimConfig, TrainState } from '../types';
import { carCatalog, placeCars, trainLength, type CarPose } from './cars';
import { pickTrainCars, trainCarsSeed } from './generate';
import type { MapTrain, WorldMap } from './map';
import { junctionSystem } from './junctions';
import { wrapDistance } from './track';

/** A train's config and route: the route the map placed it on, else the one its type names. */
export function routeOf(map: WorldMap, config: SimConfig, train: Pick<TrainState, 'type' | 'route'>) {
  const def = config.values.trains[train.type];
  if (!def) throw new Error(`unknown train type ${train.type}`);
  const id = train.route ?? def.route;
  const route = map.routes.get(id);
  if (!route) throw new Error(`train ${train.type} runs on route ${id}, which map ${map.id} does not have`);
  return { def, route };
}

/** Add a train of `type` with its engine's front at distance `d`, on `route` or its type's own, with its layouts picked for the next run. */
export function spawnTrain(state: GameState, map: WorldMap, config: SimConfig, type: string, d = 0, route?: string): TrainState {
  const def = config.values.trains[type];
  const own = route === undefined || route === def?.route;
  const { route: r } = routeOf(map, config, { type, route });
  state.trainCount += 1;
  const id = `${type}-${state.trainCount}`;
  const train: TrainState = { id, type, d: r.closed ? wrapDistance(r, d) : d, pinnedBy: null, cars: pickTrainCars(config, type, trainCarsSeed(state, id)), ...(own ? {} : { route }) };
  state.world.trains.push(train);
  return train;
}

/**
 * The trains a map starts with under `trainMix`. `map`: the map's own trains, or one mail train at
 * the start of its route. Otherwise the map's train slots (or `trainCount` slots spread evenly
 * along the mail train's route) with round(slots × blankShare) of them blank, at least one mail
 * train kept, the blank ones picked from the `schedule` stream.
 */
export function initialTrains(state: GameState, map: WorldMap, config: SimConfig): MapTrain[] {
  const mix = config.values.trainMix;
  const mail = config.values.trains[mix.mailTrain]!;
  const line = lineSlots(map, config);
  if (mix.mode === 'map') return line ?? (map.trains ? map.trains.map((t) => ({ ...t })) : [{ type: mix.mailTrain, route: mail.route, d: 0 }]);
  let slots: MapTrain[];
  if (line) slots = line;
  else if (map.trains) slots = map.trains.map((t) => ({ ...t }));
  else {
    const route = map.routes.get(mail.route);
    if (!route) throw new Error(`train ${mix.mailTrain} runs on route ${mail.route}, which map ${map.id} does not have`);
    slots = Array.from({ length: mix.trainCount }, (_, i) => ({ type: mix.mailTrain, route: mail.route, d: (route.length * i) / mix.trainCount }));
  }
  const blanks = Math.min(slots.length - 1, Math.round(slots.length * mix.blankShare));
  const order = slots.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = nextInt(state.rng, 'schedule', i + 1);
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const blank = new Set(order.slice(0, blanks));
  return slots.map((s, i) => ({ ...s, type: blank.has(i) ? mix.blankTrain : mix.mailTrain }));
}

/** On an open line, mail trains a headway apart along the mail route, the first half a headway in; null on a loop. */
function lineSlots(map: WorldMap, config: SimConfig): MapTrain[] | null {
  if (!map.openLine) return null;
  const mix = config.values.trainMix;
  const routeId = config.values.trains[mix.mailTrain]!.route;
  const route = map.routes.get(routeId);
  if (!route) throw new Error(`train ${mix.mailTrain} runs on route ${routeId}, which map ${map.id} does not have`);
  const h = map.openLine.headwayTiles;
  const out: MapTrain[] = [];
  for (let d = h / 2; d < route.length; d += h) out.push({ type: mix.mailTrain, route: routeId, d });
  return out;
}

/** At load: the trains `initialTrains` lists. */
export function spawnInitialTrains(state: GameState, map: WorldMap, config: SimConfig): void {
  for (const t of initialTrains(state, map, config)) spawnTrain(state, map, config, t.type, t.d, t.route);
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

/**
 * Tick system 2: move every train along its route at its configured speed, looping, then let
 * trains that reached a junction pick their branch.
 */
export function advanceTrains(state: GameState, map: WorldMap, config: SimConfig): void {
  const before = map.network ? new Map<string, number>() : null;
  for (const t of state.world.trains) {
    const { def, route } = routeOf(map, config, t);
    before?.set(t.id, t.d);
    // An open line's distance is not clamped: a train runs on past the end until it is removed.
    t.d = route.closed ? wrapDistance(route, t.d + def.speedTilesPerTick) : t.d + def.speedTilesPerTick;
  }
  if (before && map.network) junctionSystem(state, map.routes, map.network, config, before);
  if (map.openLine) lineTraffic(state, map, config);
}

/** Tiles past the end of an open line a train's last car gets before the train is removed. */
export const LINE_EXIT_TILES = 10;

/** True once a train's engine has reached the end of its open route (a committed run ends there). */
export function atLineEnd(map: WorldMap, config: SimConfig, train: TrainState): boolean {
  const { route } = routeOf(map, config, train);
  return !route.closed && train.d >= route.length;
}

/**
 * Open line traffic: a train whose last car is LINE_EXIT_TILES past the end leaves (a pinned one
 * stays until its run lets go of it), and once the train nearest the start of the mail route is
 * `headwayTiles` in, the next one enters a headway behind it, off the map. Its type follows
 * `trainMix`: blank with chance `blankShare` from the `schedule` stream, else mail (always mail
 * with trainMix `map` or `all-mail`).
 */
function lineTraffic(state: GameState, map: WorldMap, config: SimConfig): void {
  const trains = state.world.trains;
  for (let i = trains.length - 1; i >= 0; i--) {
    const t = trains[i]!;
    if (t.pinnedBy !== null) continue;
    const { route } = routeOf(map, config, t);
    if (!route.closed && t.d - trainLengthOf(config, t) > route.length + LINE_EXIT_TILES) trains.splice(i, 1);
  }
  const mix = config.values.trainMix;
  const routeId = config.values.trains[mix.mailTrain]!.route;
  const h = map.openLine!.headwayTiles;
  let first = Infinity;
  for (const t of trains) if ((t.route ?? config.values.trains[t.type]!.route) === routeId) first = Math.min(first, t.d);
  if (first === Infinity) first = h;
  if (first < h) return;
  const blank = mix.mode !== 'map' && mix.mode !== 'all-mail' && mix.blankShare > 0 && nextInt(state.rng, 'schedule', 1000) < mix.blankShare * 1000;
  spawnTrain(state, map, config, blank ? mix.blankTrain : mix.mailTrain, first - h, routeId);
}

/** Every car of every train, placed for the current state, in train then car order. */
export function allCarPoses(state: GameState, map: WorldMap, config: SimConfig): CarPose[] {
  const out: CarPose[] = [];
  const scratch: CarPose[] = [];
  const catalog = carCatalog(config);
  for (const t of state.world.trains) {
    const { route } = routeOf(map, config, t);
    for (const car of placeCars(t.id, t.cars, route, t.d, catalog, scratch)) out.push(car);
  }
  return out;
}

/** One train's cars, placed for the current state; empty when the train is gone. */
export function carPosesOf(state: GameState, map: WorldMap, config: SimConfig, trainId: string): CarPose[] {
  const t = state.world.trains.find((q) => q.id === trainId);
  if (!t) return [];
  const { route } = routeOf(map, config, t);
  return placeCars(t.id, t.cars, route, t.d, carCatalog(config));
}

/** A train's length in tiles. */
export function trainLengthOf(config: SimConfig, train: Pick<TrainState, 'cars'>): number {
  return trainLength(train.cars, carCatalog(config));
}

/** A train's speed along its route in tiles per second. */
export function trainSpeed(config: SimConfig, type: string): number {
  return config.values.trains[type]!.speedTilesPerTick * config.values.sim.tickRateHz;
}
