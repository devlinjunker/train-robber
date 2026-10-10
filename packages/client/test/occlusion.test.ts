import { describe, expect, it } from 'vitest';
import type { CarPose } from '@train-robber/sim';
import { carHides, hiddenByCars, insideConvex, screenHull } from '../src/iso/occlusion';
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
});
