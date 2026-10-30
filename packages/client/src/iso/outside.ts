// The outside of a car in the isometric view (sneaking PR 2): an end platform at each end, a
// ledge along each long side, and the coupling plate across the gap to the next car. They lie
// on the ground under the car, so the near ledge and the platforms show and a closed car hides
// the far ledge, as it would.
import type { Graphics } from 'pixi.js';
import { carToWorld, type CarPose, type SimConfig } from '@train-robber/sim';
import { drawBox, isoPoly, shade } from './draw';

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

export const LADDER_COLOUR = 0x3a3a40;
/** Rails poke this far above the roof, so a ladder reads from the roof too. */
const LADDER_TOP = 0.45;

/**
 * A ladder up a car's end wall (sneaking PR 3), at car-frame row `row` across the car: two rails just
 * outside the wall from the platform to above the roof, `height` tiles up, with rungs between.
 */
export function drawLadder(g: Graphics, car: CarPose, end: 'front' | 'rear', row: number, height: number): void {
  const cols = car.halfLength * 2;
  const x = end === 'front' ? -0.06 : cols + 0.06, y = Math.min(row, car.halfWidth * 2 - 1) + 0.5;
  const box = (dy: number, halfWidth: number, z0: number, z1: number) => {
    const c = carToWorld(car, x, y + dy);
    drawBox(g, { x: c.x, y: c.y, ux: car.ux, uy: car.uy, halfLength: 0.04, halfWidth, z0, z1 }, LADDER_COLOUR);
  };
  for (let z = 0.4; z < height + 0.2; z += 0.55) box(0, 0.24, z, z + 0.07);
  box(-0.24, 0.04, 0, height + LADDER_TOP);
  box(0.24, 0.04, 0, height + LADDER_TOP);
}

/**
 * A ladder up a car's long side (issue #60), at car-frame x `x`: rails just outside the `side` wall
 * from near the ground to above the roof, `height` tiles up, with rungs between. Boarded from the horse.
 */
export function drawSideLadder(g: Graphics, car: CarPose, side: 'left' | 'right', x: number, height: number): void {
  const rows = car.halfWidth * 2;
  const y = side === 'left' ? -0.06 : rows + 0.06;
  const box = (dx: number, halfLength: number, z0: number, z1: number) => {
    const c = carToWorld(car, x + dx, y);
    drawBox(g, { x: c.x, y: c.y, ux: car.ux, uy: car.uy, halfLength, halfWidth: 0.04, z0, z1 }, LADDER_COLOUR);
  };
  for (let z = 0.4; z < height + 0.2; z += 0.55) box(0, 0.24, z, z + 0.07);
  box(-0.24, 0.04, 0.2, height + LADDER_TOP);
  box(0.24, 0.04, 0.2, height + LADDER_TOP);
}
