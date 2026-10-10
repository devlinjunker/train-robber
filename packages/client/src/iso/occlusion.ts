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
 * True when the car, `height` tiles tall, is nearer the viewer than the point (x, y) and covers it
 * on screen at any of the heights `zs`. Depth is compared at the car's centre, so a horse beside
 * the near side is never counted as hidden.
 */
export function carHides(car: Footprint, height: number, x: number, y: number, zs: readonly number[]): boolean {
  if (depthOf(x, y) >= depthOf(car.x, car.y)) return false;
  const hull = screenHull(car, height);
  return zs.some((z) => insideConvex(hull, [isoX(x, y), isoY(x, y, z)]));
}

/** The outline a footprint `height` tiles tall covers on screen, in unzoomed iso pixels. */
export function screenHull(car: Footprint, height: number): Pt[] {
  const corners = boxCorners({ x: car.x, y: car.y, ux: car.ux, uy: car.uy, halfLength: car.halfLength, halfWidth: car.halfWidth, z0: 0, z1: height });
  return convexHull(corners.flatMap(([cx, cy]) => [[isoX(cx, cy), isoY(cx, cy, 0)], [isoX(cx, cy), isoY(cx, cy, height)]] as Pt[]));
}

/** True when any of the cars hides the point; see `carHides`. */
export function hiddenByCars(cars: readonly CarPose[], height: number, x: number, y: number, zs: readonly number[]): boolean {
  return cars.some((car) => carHides(car, height, x, y, zs));
}
