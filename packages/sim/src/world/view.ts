// Seeing into a car through an opening (issue #60): riding beside the train, you see the guards
// standing in a cone through a door near you. A pure helper the views share, so the player's view
// cone aboard (issue #56) can reuse it. Nothing here changes the sim.
import type { SimConfig } from '../types';
import { carCatalog, carTemplate } from './cars';
import { lineOfSight, toTrain, trainGrid, type TrainGrid } from './guards';

/** A guard to test, in train coordinates (`lx` is train x, `y` the car-frame row). */
export interface ConeGuard { id: number; lx: number; y: number }

/**
 * The guards a viewer at `origin` (train coordinates) sees in a cone along the unit `facing`: within
 * `range` tiles, at a dot product with `facing` of at least `cos` (the cosine of the cone's half
 * angle), and with nothing that blocks sight in between (`lineOfSight`). Returns their ids in order.
 */
export function guardsInCone(g: TrainGrid, origin: { lx: number; y: number }, facing: { x: number; y: number }, cos: number, range: number, guards: readonly ConeGuard[]): number[] {
  const out: number[] = [];
  for (const q of guards) {
    const dx = q.lx - origin.lx, dy = q.y - origin.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > range) continue;
    if (d > 1e-6 && (dx * facing.x + dy * facing.y) / d < cos) continue;
    if (lineOfSight(g, origin.lx, origin.y, q.lx, q.y)) out.push(q.id);
  }
  return out;
}

/** An opening in a car's outer wall you can look in through: its doorway cell's middle (car frame) and the way in. */
export interface CarOpening { car: number; id: string; side: 'left' | 'right' | 'front' | 'rear'; x: number; y: number; lx: number; facing: { x: number; y: number } }

/**
 * Every door of a train's cars, side and end, as an opening to look in through: from the middle of
 * the doorway cell, facing into the car (+x is toward the rear, +y toward the right side).
 */
export function trainOpenings(config: SimConfig, cars: readonly string[]): CarOpening[] {
  const catalog = carCatalog(config), g = trainGrid(config, cars, catalog);
  const out: CarOpening[] = [];
  cars.forEach((id, k) => {
    for (const ep of carTemplate(catalog, id).entryPoints) {
      const x = ep.cell[0] + 0.5, y = ep.cell[1] + 0.5;
      const facing = ep.side === 'left' ? { x: 0, y: 1 } : ep.side === 'right' ? { x: 0, y: -1 } : ep.side === 'front' ? { x: 1, y: 0 } : { x: -1, y: 0 };
      out.push({ car: k, id: ep.id, side: ep.side, x, y, lx: toTrain(g, k, x), facing });
    }
  });
  return out;
}
