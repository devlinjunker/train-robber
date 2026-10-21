// The outside of a car in the isometric view (sneaking PR 2): an end platform at each end, a
// ledge along each long side, and the coupling plate across the gap to the next car. They lie
// on the ground under the car, so the near ledge and the platforms show and a closed car hides
// the far ledge, as it would.
import type { Graphics } from 'pixi.js';
import { carToWorld, type CarPose, type SimConfig } from '@train-robber/sim';
import { isoPoly, shade } from './draw';

export type OutsideDims = Pick<SimConfig['values']['outside'], 'ledges' | 'platformDepthTiles' | 'couplingGapTiles' | 'gangwayWidthTiles' | 'ledgeWidthTiles'>;

export const PLATFORM_COLOUR = 0x5e4330, LEDGE_COLOUR = 0x6e5038, COUPLING_COLOUR = 0x2e2e34;
/** Planks sit a little above the ground so they draw over it; the coupling plate a little lower. */
const PLANK_Z = 0.05, PLATE_Z = 0.03;

/** A rectangle in a car's frame (x from the front, y from the left), as iso points at height z. */
function frameRect(car: CarPose, x0: number, x1: number, y0: number, y1: number, z: number): number[] {
  const pts = [carToWorld(car, x0, y0), carToWorld(car, x1, y0), carToWorld(car, x1, y1), carToWorld(car, x0, y1)];
  return isoPoly(pts.map((p) => [p.x, p.y] as const), z);
}

/**
 * Draws a car's platforms and ledges, and with `coupled` the coupling plate behind it, into `g`.
 * Ledges that are switched off (`outside.ledges`) are drawn darker, as a trim you cannot stand on.
 */
export function drawCarOutside(g: Graphics, car: CarPose, dims: OutsideDims, coupled: boolean): void {
  const P = dims.platformDepthTiles, L = dims.ledgeWidthTiles, G = dims.couplingGapTiles;
  const cols = car.halfLength * 2, rows = car.halfWidth * 2;
  const edge = { width: 1, color: 0x2a1c12, alpha: 0.6 };
  if (L > 0) {
    const colour = dims.ledges ? LEDGE_COLOUR : shade(LEDGE_COLOUR, 0.6);
    g.poly(frameRect(car, -P, cols + P, -L, 0, PLANK_Z)).fill(colour).stroke(edge);
    g.poly(frameRect(car, -P, cols + P, rows, rows + L, PLANK_Z)).fill(colour).stroke(edge);
  }
  if (P > 0) {
    g.poly(frameRect(car, -P, 0, 0, rows, PLANK_Z)).fill(PLATFORM_COLOUR).stroke(edge);
    g.poly(frameRect(car, cols, cols + P, 0, rows, PLANK_Z)).fill(PLATFORM_COLOUR).stroke(edge);
    // Planks across each platform.
    for (let k = 1; k < rows; k += 2) {
      for (const [a, b] of [[-P, 0], [cols, cols + P]] as const) {
        const p = carToWorld(car, a, k), q = carToWorld(car, b, k);
        g.poly(isoPoly([[p.x, p.y], [q.x, q.y]], PLANK_Z + 0.005), false).stroke({ width: 1, color: shade(PLATFORM_COLOUR, 0.75), alpha: 0.7 });
      }
    }
  }
  if (coupled && G > 0) {
    const w = Math.min(rows, dims.gangwayWidthTiles);
    // The plate across the gap, and the coupling bar under it.
    g.poly(frameRect(car, cols + P, cols + P + G, rows / 2 - w / 2, rows / 2 + w / 2, PLATE_Z)).fill(shade(COUPLING_COLOUR, 1.3)).stroke(edge);
    g.poly(frameRect(car, cols + P - 0.2, cols + P + G + 0.2, rows / 2 - 0.18, rows / 2 + 0.18, PLATE_Z + 0.01)).fill(COUPLING_COLOUR);
  }
}
