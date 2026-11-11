// Canyon rims (G10b): a canyon cut on the open line shuts the lanes beside the cars, and a trail
// runs along the top of one wall. From the trail a committed rider can drop straight onto the roof
// of a car passing below (Space, `boarding.rimDrop`), with no meter.
import type { GameState, HorseState, SimConfig } from '../types';
import { distanceToBox } from './collide';
import { onRoof, trainGrid } from './guards';
import type { WorldMap } from './map';
import { trainCars, WALKER_RADIUS } from './separate';
import { carPosesOf, routeOf } from './trains';

/** Where a rim drop lands: car `car` of the train, at (x, y) on its roof in the car's frame. */
export interface RimDrop { car: number; x: number; y: number }

/** True when (x, y) is on a rim trail along `routeId` (the trail itself, a tile either way). */
export function onRim(map: WorldMap, routeId: string, x: number, y: number): boolean {
  const route = map.routes.get(routeId);
  if (!route) return false;
  const sm = route.samples;
  for (const r of map.rims) {
    if (r.route !== routeId) continue;
    const i0 = Math.max(0, Math.floor(r.d0 / route.spacing)), i1 = Math.min(sm.x.length - 1, Math.ceil(r.d1 / route.spacing));
    let best = -1, bd = Infinity;
    for (let i = i0; i <= i1; i++) {
      const dx = x - sm.x[i]!, dy = y - sm.y[i]!, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    if (best < 0 || bd > (r.outer + 2) * (r.outer + 2)) continue;
    // Across the track from the nearest sample: positive on side 1 (tangent x offset >= 0).
    const off = sm.tx[best]! * (y - sm.y[best]!) - sm.ty[best]! * (x - sm.x[best]!);
    if ((off >= 0 ? 1 : -1) === r.side && Math.abs(off) >= r.inner - 1 && Math.abs(off) <= r.outer + 1) return true;
  }
  return false;
}

/**
 * Whether the horse could drop onto a roof of train `trainId` now: it is on a rim along the train's
 * route and a car with a roof is within `boarding.rimDrop.reachTiles`. Lands on the roof straight
 * across from the rider, held inside its edges; null when it cannot.
 */
export function rimDropCheck(state: GameState, map: WorldMap, config: SimConfig, trainId: string, h: HorseState): RimDrop | null {
  const c = config.values.boarding.rimDrop;
  if (!c.enabled || !config.values.outside.roof.enabled || !map.rims.length || h.mode !== 'physical') return null;
  const train = state.world.trains.find((t) => t.id === trainId);
  if (!train || !onRim(map, routeOf(map, config, train).route.id, h.x, h.y)) return null;
  const g = trainGrid(config, trainCars(state, trainId));
  let out: RimDrop | null = null, bestD = c.reachTiles;
  for (const car of carPosesOf(state, map, config, trainId)) {
    const d = distanceToBox(h.x, h.y, car);
    if (d > bestD) continue;
    const dx = h.x - car.x, dy = h.y - car.y;
    const along = dx * car.ux + dy * car.uy, left = dx * car.uy - dy * car.ux;
    const cols = g.carCols[car.index]!, rows = g.carRows[car.index]!;
    const x = Math.max(WALKER_RADIUS, Math.min(cols - WALKER_RADIUS, car.halfLength - along));
    const y = Math.max(WALKER_RADIUS, Math.min(rows - WALKER_RADIUS, car.halfWidth - left));
    if (!onRoof(g, car.index, x, y)) continue;
    bestD = d;
    out = { car: car.index, x, y };
  }
  return out;
}
