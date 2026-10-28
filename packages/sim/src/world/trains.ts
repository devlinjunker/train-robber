// Train scheduler: spawns trains, advances them along their routes and keeps the committed
// one. On a loop trains run forever; which ones run comes from the map and the trainMix setting.
// On an open line (map `openLine`) trains run one way: they set out from the start of the line
// on the seeded timetable (timetable.ts) and are removed once past its end.
import { nextInt } from '../rng';
import type { GameState, PlayerId, SimConfig, TrainState } from '../types';
import { carCatalog, carSpacing, placeCars, trainLength, type CarPose } from './cars';
import { pickTrainCars, trainCarsSeed } from './generate';
import type { MapTrain, WorldMap } from './map';
import { junctionSystem } from './junctions';
import { lineTrainAt, lineTrainsAtStart, lineTrainsSettingOut, lineTrainType } from './timetable';
import { wrapDistance, type TrackRoute } from './track';

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
  if (map.openLine) return lineSlots(state.seed, map, config);
  if (mix.mode === 'map') return map.trains ? map.trains.map((t) => ({ ...t })) : [{ type: mix.mailTrain, route: mail.route, d: 0 }];
  let slots: MapTrain[];
  if (map.trains) slots = map.trains.map((t) => ({ ...t }));
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

/** The mail route of an open line: every line train runs on it. */
function lineRoute(map: WorldMap, config: SimConfig) {
  const routeId = config.values.trains[config.values.trainMix.mailTrain]!.route;
  const route = map.routes.get(routeId);
  if (!route) throw new Error(`train ${config.values.trainMix.mailTrain} runs on route ${routeId}, which map ${map.id} does not have`);
  return route;
}

/**
 * On an open line, the timetable's trains already on the line at tick 0 (G6): train 0 half a
 * headway in, the others a seeded gap apart ahead of it, each of the type the timetable gives it.
 */
function lineSlots(seed: string, map: WorldMap, config: SimConfig): MapTrain[] {
  const route = lineRoute(map, config);
  return lineTrainsAtStart(map, config, seed, route.length).map((k) => ({ type: lineTrainType(config, seed, k), route: route.id, d: lineTrainAt(map, config, seed, k, 0) }));
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

/** How far inside the map an open line's track must be for the horse to be put beside it. */
const ON_MAP_MARGIN_TILES = 12;

/**
 * The first and last distance along an open route where the track is well inside the map: a quick
 * retry or a whistled horse is put beside the track no further out than these. A closed route is all on the map.
 */
export function onMapRange(map: Pick<WorldMap, 'cols' | 'rows'>, route: TrackRoute): { from: number; to: number } {
  const { x, y, s } = route.samples;
  const inside = (i: number) => x[i]! >= ON_MAP_MARGIN_TILES && y[i]! >= ON_MAP_MARGIN_TILES && x[i]! < map.cols - ON_MAP_MARGIN_TILES && y[i]! < map.rows - ON_MAP_MARGIN_TILES;
  if (route.closed) return { from: -Infinity, to: Infinity };
  let a = 0, b = s.length - 1;
  while (a < b && !inside(a)) a++;
  while (b > a && !inside(b)) b--;
  return { from: s[a]!, to: s[b]! };
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
 * stays until its run lets go of it), and each train the timetable sets out on this tick enters at
 * the start of the mail route, where the timetable puts it (timetable.ts). Types come from the
 * timetable too, so nothing here draws on an rng stream.
 */
function lineTraffic(state: GameState, map: WorldMap, config: SimConfig): void {
  const trains = state.world.trains;
  for (let i = trains.length - 1; i >= 0; i--) {
    const t = trains[i]!;
    if (t.pinnedBy !== null) continue;
    const { route } = routeOf(map, config, t);
    if (!route.closed && t.d - trainLengthOf(config, t) > route.length + LINE_EXIT_TILES) trains.splice(i, 1);
  }
  // Trains have just moved to tick + 1.
  const route = lineRoute(map, config), at = state.tick + 1;
  for (const k of lineTrainsSettingOut(map, config, state.seed, at)) {
    spawnTrain(state, map, config, lineTrainType(config, state.seed, k), lineTrainAt(map, config, state.seed, k, at), route.id);
  }
}

/** Every car of every train, placed for the current state, in train then car order. */
export function allCarPoses(state: GameState, map: WorldMap, config: SimConfig): CarPose[] {
  const out: CarPose[] = [];
  const scratch: CarPose[] = [];
  const catalog = carCatalog(config);
  for (const t of state.world.trains) {
    const { route } = routeOf(map, config, t);
    for (const car of placeCars(t.id, t.cars, route, t.d, catalog, scratch, carSpacing(config))) out.push(car);
  }
  return out;
}

/** One train's cars, placed for the current state; empty when the train is gone. */
export function carPosesOf(state: GameState, map: WorldMap, config: SimConfig, trainId: string): CarPose[] {
  const t = state.world.trains.find((q) => q.id === trainId);
  if (!t) return [];
  const { route } = routeOf(map, config, t);
  return placeCars(t.id, t.cars, route, t.d, carCatalog(config), [], carSpacing(config));
}

/** A train's length in tiles, platforms and couplings included. */
export function trainLengthOf(config: SimConfig, train: Pick<TrainState, 'cars'>): number {
  return trainLength(train.cars, carCatalog(config), carSpacing(config), config.values.outside.platformDepthTiles);
}

/** A train's speed along its route in tiles per second. */
export function trainSpeed(config: SimConfig, type: string): number {
  return config.values.trains[type]!.speedTilesPerTick * config.values.sim.tickRateHz;
}
