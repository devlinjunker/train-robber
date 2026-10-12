import { describe, expect, it } from 'vitest';
import type { MapDef } from '@train-robber/config';
import { createHeightField, LEVEL_TILES } from '../src/iso/height';

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
    expect(f.groundZ(5, 3)).toBeCloseTo(4 * LEVEL_TILES, 1);
  });

  it('slopes down one level to the ground but keeps a cliff edge sharp', () => {
    const f = createHeightField(map);
    // Across the one-level step (x 2 -> 3) the ground falls smoothly.
    const top = f.groundZ(1.5, 3), mid = f.groundZ(3, 3), low = f.groundZ(3.5, 3);
    expect(top).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(0);
    expect(low).toBeLessThan(top);
    // The level-4 block's edge stays at its full height: the gap is drawn as a cliff face.
    const [tl, , , bl] = f.corners(4, 3);
    expect(tl).toBeCloseTo(4 * LEVEL_TILES, 5);
    expect(bl).toBeCloseTo(4 * LEVEL_TILES, 5);
    const [, tr] = f.corners(3, 3);
    expect(tr).toBeLessThan(LEVEL_TILES);
  });
});
