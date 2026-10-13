import { describe, expect, it } from 'vitest';
import type { MapDef } from '@train-robber/config';
import { placeBoulders, ROCK_MAX_HEIGHT } from '../src/iso/rocks';

/** A 10 × 8 map with a blocked rim (the map edge) and a 3 × 2 block of rock at (4, 3). */
const COLS = 10, ROWS = 8;
const blocked = (x: number, y: number) => x === 0 || y === 0 || x === COLS - 1 || y === ROWS - 1 || (x >= 4 && x <= 6 && y >= 3 && y <= 4);
const map = {
  size: { cols: COLS, rows: ROWS },
  zoneLegend: ['open', 'blocked'],
  zones: Array.from({ length: COLS * ROWS }, (_, i) => [1, blocked(i % COLS, Math.floor(i / COLS)) ? 1 : 0]),
} as unknown as MapDef;

describe('boulders', () => {
  it('puts one boulder on each 2 × 2 cell holding rock, and none on the map edge', () => {
    const b = placeBoulders(map);
    // The block (4..6, 3..4) touches cells (4,2), (6,2), (4,4) and (6,4); the rim gets none.
    expect(b).toHaveLength(4);
    for (const r of b) {
      expect(r.x).toBeGreaterThan(4);
      expect(r.x).toBeLessThan(7);
      expect(r.y).toBeGreaterThan(3);
      expect(r.y).toBeLessThan(5);
      expect(r.h).toBeGreaterThan(0.3);
      expect(r.h).toBeLessThanOrEqual(ROCK_MAX_HEIGHT);
    }
  });

  it('places the same boulders every time', () => {
    expect(placeBoulders(map)).toEqual(placeBoulders(map));
  });
});
