// How hard a curve throws you sideways on a car's roof (sneaking PR 3): used by player and guard slips.
import type { GameState, SimConfig } from '../types';
import { carCatalog, carSpacing, carTemplate } from './cars';
import type { WorldMap } from './map';
import { trackAt } from './track';
import { routeOf, trainSpeed } from './trains';

/**
 * The pull of the curve on car `car` of a train, in tiles/s² across the car frame: + pushes toward
 * the right side (+y), - toward the left. It is the train's speed squared times the curvature of the
 * track under the car, from the turn between the tangents at the car's front and rear (so no trig).
 */
export function curvePull(state: GameState, map: WorldMap, config: SimConfig, trainId: string, car: number): number {
  const t = state.world.trains.find((q) => q.id === trainId);
  if (!t) return 0;
  const { route } = routeOf(map, config, t);
  const catalog = carCatalog(config), spacing = carSpacing(config);
  let off = 0;
  for (let i = 0; i < car; i++) off += carTemplate(catalog, t.cars[i]!).size.cols + spacing;
  const len = carTemplate(catalog, t.cars[car]!).size.cols;
  const a = trackAt(route, t.d - off), b = trackAt(route, t.d - off - len);
  // Turning right (the front tangent clockwise of the rear one on screen) throws you to the left.
  const cross = b.tx * a.ty - b.ty * a.tx;
  const v = trainSpeed(config, t.type);
  return len > 0 ? -(v * v * cross) / len : 0;
}
