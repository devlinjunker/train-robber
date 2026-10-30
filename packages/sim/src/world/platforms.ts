// The end platforms a jump from the horse can land on (issue #60), kept apart from boarding.ts so the
// mount rules can use them too without importing the guards.
import type { BoardingTargetKind, SimConfig } from '../types';
import { carCatalog, carTemplate, entryPointWorld, type CarPose, type Side } from './cars';

/** A place on a car a jump from the horse can land (issue #60). */
export interface BoardingTarget {
  kind: BoardingTargetKind;
  id: string;
  side: Side;
  /** World position: the door, the platform's side edge or the ladder, on the car's outside. */
  x: number;
  y: number;
  /** Where a landing there puts you, in the car's frame. */
  land: { x: number; y: number };
}

/** How far out from the end wall a platform landing stands: as a ladder's foot, clear of the wall for a walker. */
function platformStand(depth: number): number {
  return Math.max(depth / 2, Math.min(depth - 0.01, 0.35));
}

/**
 * A placed car's platform targets under `boarding.targets.platforms`: `caboose` only the rear of a
 * caboose that is the train's last car (Devlin PR #65), `train-end` the last car's rear whatever it
 * is, `all` every end but the engine's front. One on each side, at the platform's side edge.
 */
export function carPlatformTargets(config: SimConfig, car: CarPose, trainCars: readonly string[]): BoardingTarget[] {
  const t = config.values.boarding.targets, P = config.values.outside.platformDepthTiles;
  const out: BoardingTarget[] = [];
  if (t.platforms === 'none' || P <= 0) return out;
  const tmpl = carTemplate(carCatalog(config), car.template);
  const cols = tmpl.size.cols, rows = tmpl.size.rows, hl = car.halfLength;
  const add = (id: string, side: Side, along: number, land: { x: number; y: number }) => {
    const w = entryPointWorld(car, { side, along });
    out.push({ kind: 'platform', id, side, x: w.x, y: w.y, land });
  };
  const d = platformStand(P), last = car.index === trainCars.length - 1 && (t.platforms !== 'caboose' || tmpl.carType === 'caboose');
  for (const side of ['left', 'right'] as const) {
    const y = side === 'left' ? 0.5 : rows - 0.5;
    if (t.platforms === 'all' && car.index > 0) add('platform-front', side, hl + d, { x: -d, y });
    if (t.platforms === 'all' || last) add('platform-rear', side, hl - cols - d, { x: cols + d, y });
  }
  return out;
}
