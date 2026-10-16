import { describe, expect, it } from 'vitest';
import type { MapDef } from '@train-robber/config';
import { createHeightField, LEVEL_TILES } from '../src/iso/height';
import { plateauOutlines } from '../src/iso/mesa';

/** A 6 × 6 map: a level-1 rise (x 0-2) beside a level-4 block (x 4-5). */
const levels = (x: number) => (x <= 2 ? 1 : x >= 4 ? 4 : 0);
const map = {
  size: { cols: 6, rows: 6 },
  elevation: Array.from({ length: 36 }, (_, i) => [1, levels(i % 6)]),
} as unknown as MapDef;

describe('height field', () => {
  it('is flat and off for a map without elevation', () => {
    const f = createHeightField({ size: { cols: 4, rows: 4 } } as MapDef);
    expect(f.raised).toBe(false);
    expect(f.groundZ(2.5, 2.5)).toBe(0);
  });

  it('sits on top of a raised tile', () => {
    const f = createHeightField(map);
    expect(f.raised).toBe(true);
    expect(f.groundZ(0.5, 3)).toBeCloseTo(LEVEL_TILES, 1);
    expect(f.surfaceZ(5, 3)).toBeCloseTo(4 * LEVEL_TILES, 1);
  });

  it('slopes down one level to the ground', () => {
    const f = createHeightField(map);
    // Across the one-level step (x 2 -> 3) the ground falls smoothly.
    const top = f.groundZ(1.5, 3), mid = f.groundZ(3, 3), low = f.groundZ(3.5, 3);
    expect(top).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(0);
    expect(low).toBeLessThan(top);
  });

  it('makes the block behind a cliff a plateau, with the ground running on underneath', () => {
    const f = createHeightField(map);
    expect(f.plateaus).toHaveLength(1);
    expect(f.plateauOf(4, 3)).toBe(0);
    expect(f.plateauOf(3, 3)).toBe(-1);
    expect(f.plateaus[0]!.tiles).toHaveLength(12);
    // Its top is at level 4; the ground under it stays low, filled in from beside it.
    expect(f.surfaceZ(5, 3)).toBeCloseTo(4 * LEVEL_TILES, 5);
    expect(f.groundZ(5, 3)).toBeLessThan(LEVEL_TILES);
    expect(f.surfaceZ(1.5, 3)).toBeCloseTo(f.groundZ(1.5, 3), 5);
  });
});

describe('mesa outline', () => {
  it('rounds the plateau into one loop round its tiles, with cliffs from the ground to its top', () => {
    const f = createHeightField(map);
    const loops = plateauOutlines(6, 6, 0, f.plateaus[0]!, f);
    expect(loops).toHaveLength(1);
    const loop = loops[0]!;
    // Corners are cut: no point sits on a tile corner of the block, and none strays far from it.
    for (const v of loop) {
      expect(v.x).toBeGreaterThan(3.4);
      expect(v.x).toBeLessThan(6.6);
      expect(v.zt).toBeCloseTo(4 * LEVEL_TILES, 5);
      expect(v.zb).toBeLessThan(v.zt);
    }
    // Clockwise on screen, so the outward side of each step (dx, dy) is (dy, -dx).
    const area = loop.reduce((s, a, i) => { const b = loop[(i + 1) % loop.length]!; return s + a.x * b.y - b.x * a.y; }, 0);
    expect(area).toBeGreaterThan(0);
  });
});
