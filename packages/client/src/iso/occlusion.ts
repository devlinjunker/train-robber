// Occlusion in the isometric view: whether a car, or a slice of one, hides a point, so the view can
// cut a shadowed hole in just the part of the train in front of the horse and rider (or the player
// aboard) (Devlin, 2026-10-10). Pure maths over the projection, no drawing.
import type { CarPose } from '@train-robber/sim';
import { boxCorners } from './draw';
import { depthOf, isoX, isoY } from '../projection';

type Pt = [number, number];
/** A car's ground rectangle, or a slice of one. */
export type Footprint = Pick<CarPose, 'x' | 'y' | 'ux' | 'uy' | 'halfLength' | 'halfWidth'>;
const cross = (o: Pt, a: Pt, b: Pt) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

/** Convex hull (monotone chain), counter-clockwise in screen space. */
export function convexHull(points: Pt[]): Pt[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const lower: Pt[] = [], upper: Pt[] = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, q) <= 0) lower.pop(); lower.push(q); }
  for (const q of [...p].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, q) <= 0) upper.pop(); upper.push(q); }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

export function insideConvex(hull: readonly Pt[], q: Pt): boolean {
  if (hull.length < 3) return false;
  for (let i = 0; i < hull.length; i++) if (cross(hull[i]!, hull[(i + 1) % hull.length]!, q) < 0) return false;
  return true;
}

/**
 * The stretches along a car, [from, to] in tiles from its centre toward the front, that it is cut
 * into for drawing: `sliceTiles` long each, front first, the last one shorter when the length
 * doesn't divide. Each slice sorts on its own in the view, so occlusion is judged per slice too.
 */
export function sliceSpans(halfLength: number, sliceTiles: number): [number, number][] {
  const n = Math.max(1, Math.ceil((halfLength * 2) / sliceTiles - 1e-9));
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a1 = halfLength - i * sliceTiles;
    out.push([Math.max(-halfLength, a1 - sliceTiles), a1]);
  }
  return out;
}

/**
 * True when the car, `height` tiles tall, has a slice nearer the viewer than the point (x, y) that
 * covers it on screen at any of the heights `zs`. Depth is compared slice by slice, as the view
 * sorts them: on angled track one end of a long car can be in front of a horse that is behind its
 * middle (riding along the far side near an end). A horse beside the near side is never counted
 * as hidden. `sliceTiles` 0 judges the car whole.
 */
export function carHides(car: Footprint, height: number, x: number, y: number, zs: readonly number[], sliceTiles = 0): boolean {
  const d = depthOf(x, y);
  const spans: [number, number][] = sliceTiles > 0 ? sliceSpans(car.halfLength, sliceTiles) : [[-car.halfLength, car.halfLength]];
  for (const [a0, a1] of spans) {
    const mid = (a0 + a1) / 2;
    const slice = { x: car.x + car.ux * mid, y: car.y + car.uy * mid, ux: car.ux, uy: car.uy, halfLength: (a1 - a0) / 2, halfWidth: car.halfWidth };
    if (d >= depthOf(slice.x, slice.y)) continue;
    const hull = screenHull(slice, height);
    if (zs.some((z) => insideConvex(hull, [isoX(x, y), isoY(x, y, z)]))) return true;
  }
  return false;
}

/** The outline a footprint `height` tiles tall covers on screen, in unzoomed iso pixels. */
export function screenHull(car: Footprint, height: number): Pt[] {
  const corners = boxCorners({ x: car.x, y: car.y, ux: car.ux, uy: car.uy, halfLength: car.halfLength, halfWidth: car.halfWidth, z0: 0, z1: height });
  return convexHull(corners.flatMap(([cx, cy]) => [[isoX(cx, cy), isoY(cx, cy, 0)], [isoX(cx, cy), isoY(cx, cy, height)]] as Pt[]));
}

/** True when any of the cars hides the point; see `carHides`. */
export function hiddenByCars(cars: readonly CarPose[], height: number, x: number, y: number, zs: readonly number[], sliceTiles = 0): boolean {
  return cars.some((car) => carHides(car, height, x, y, zs, sliceTiles));
}

/** The point on a car's ground rectangle nearest (x, y), and how far away it is (0 inside). */
export function nearestOnCar(car: Footprint, x: number, y: number): { x: number; y: number; distance: number } {
  const dx = x - car.x, dy = y - car.y;
  const along = Math.max(-car.halfLength, Math.min(car.halfLength, dx * car.ux + dy * car.uy));
  const across = Math.max(-car.halfWidth, Math.min(car.halfWidth, dx * car.uy - dy * car.ux));
  const px = car.x + car.ux * along + car.uy * across, py = car.y + car.uy * along - car.ux * across;
  return { x: px, y: py, distance: Math.hypot(x - px, y - py) };
}
