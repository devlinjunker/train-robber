// Occlusion in the isometric view: whether a car hides a point, so the view can draw an x-ray
// silhouette of the horse and rider when they ride behind the train (the design's first
// occlusion rule after the roof). Pure maths over the projection, no drawing.
import type { CarPose } from '@train-robber/sim';
import { boxCorners } from './draw';
import { depthOf, isoX, isoY } from '../projection';

type Pt = [number, number];
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
 * True when some car of `height` tiles is nearer the viewer than the point (x, y) and covers it on
 * screen at any of the heights `zs`. Depth is compared at the car's nearest footprint corner to the
 * point's own depth, so a horse beside the near side is never counted as hidden.
 */
export function hiddenByCars(cars: readonly CarPose[], height: number, x: number, y: number, zs: readonly number[]): boolean {
  const d = depthOf(x, y);
  for (const car of cars) {
    const corners = boxCorners({ ...car, z0: 0, z1: height });
    // The point must be behind the car: farther from the viewer than the car's centre line.
    if (d >= depthOf(car.x, car.y)) continue;
    const hull = convexHull(corners.flatMap(([cx, cy]) => [[isoX(cx, cy), isoY(cx, cy, 0)], [isoX(cx, cy), isoY(cx, cy, height)]] as Pt[]));
    if (zs.some((z) => insideConvex(hull, [isoX(x, y), isoY(x, y, z)]))) return true;
  }
  return false;
}
