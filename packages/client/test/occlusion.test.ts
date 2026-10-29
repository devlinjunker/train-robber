import { describe, expect, it } from 'vitest';
import type { CarPose } from '@train-robber/sim';
import { carHides, hiddenByCars, insideConvex, nearestOnCar, screenHull, sliceSpans } from '../src/iso/occlusion';
import { isoX, isoY } from '../src/projection';

// A car running along +x; the far side from the viewer is -y (smaller depth x + y).
const car: CarPose = { trainId: 't', index: 1, template: 'blank-car', x: 100, y: 100, ux: 1, uy: 0, halfLength: 6, halfWidth: 1.5 };
const zs = [0.6, 1.6];

describe('occlusion', () => {
  it('hides a horse just behind the far side of a car', () => {
    expect(hiddenByCars([car], 2.4, 100, 97.5, zs)).toBe(true);
  });
  it('never hides a horse beside the near side', () => {
    expect(hiddenByCars([car], 2.4, 100, 102.5, zs)).toBe(false);
  });
  it('does not hide a horse far behind, clear of the car on screen', () => {
    expect(hiddenByCars([car], 2.4, 100, 80, zs)).toBe(false);
    expect(hiddenByCars([], 2.4, 100, 97.5, zs)).toBe(false);
  });
  it('names the car to cut away, not its neighbour along the track', () => {
    const next: CarPose = { ...car, index: 2, x: 114 };
    expect(carHides(car, 2.4, 100, 97.5, zs)).toBe(true);
    expect(carHides(next, 2.4, 100, 97.5, zs)).toBe(false);
  });
  it('outlines the car on screen from its ground corners up to its roof', () => {
    const hull = screenHull(car, 2.4);
    expect(insideConvex(hull, [isoX(100, 100), isoY(100, 100, 1)])).toBe(true);
    expect(insideConvex(hull, [isoX(100, 90), isoY(100, 90, 0)])).toBe(false);
  });

  // A long car on angled track: depth runs along it, so its near end is in front of a horse on the
  // far side by that end even though the car's centre is behind the horse (Devlin, 2026-10-28).
  const long: CarPose = { ...car, halfLength: 14, halfWidth: 3.5 };
  it('hides a horse on the far side by the near end of a long angled car, slice by slice', () => {
    expect(carHides(long, 5, 112, 95, zs)).toBe(false); // judged whole, as before: the bug
    expect(carHides(long, 5, 112, 95, zs, 2)).toBe(true);
    expect(hiddenByCars([long], 5, 112, 95, zs, 2)).toBe(true);
  });
  it('still never hides a horse beside the near side, slice by slice', () => {
    for (const along of [-13, -6, 0, 6, 13]) expect(carHides(long, 5, 100 + along, 104.5, zs, 2)).toBe(false);
  });
  it('slices a car front first, the last slice shorter', () => {
    expect(sliceSpans(14, 2)).toHaveLength(14);
    expect(sliceSpans(3, 2)).toEqual([[1, 3], [-1, 1], [-3, -1]]);
    expect(sliceSpans(2.5, 2)).toEqual([[0.5, 2.5], [-1.5, 0.5], [-2.5, -1.5]]);
  });

  it('measures from the horse to the nearest point on the car side, not a door', () => {
    expect(nearestOnCar(car, 102, 95)).toEqual({ x: 102, y: 98.5, distance: 3.5 });
    expect(nearestOnCar(car, 110, 100).distance).toBeCloseTo(4, 9);
    expect(nearestOnCar(car, 100, 100).distance).toBe(0);
  });
});
