import { describe, expect, it } from 'vitest';
import type { CarPose } from '@train-robber/sim';
import { hiddenByCars } from '../src/iso/occlusion';

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
});
