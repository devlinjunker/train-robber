import { describe, expect, it } from 'vitest';
import type { MapDef } from '@train-robber/config';
import { placeBoulders, ROCK_MAX_HEIGHT } from '../src/iso/rocks';

/** A 6 × 4 map, open but for a 3 × 2 block of blocked tiles at (1, 1). */
const map = {
  size: { cols: 6, rows: 4 },
  zoneLegend: ['open', 'blocked'],
  zones: [[7, 0], [3, 1], [3, 0], [3, 1], [8, 0]],
} as unknown as MapDef;

describe('boulders', () => {
  it('puts one boulder on each 2 × 2 cell holding blocked tiles, near those tiles', () => {
    const b = placeBoulders(map);
    // Blocked tiles (1..3, 1..2) touch cells (0,0), (2,0), (0,2) and (2,2).
    expect(b).toHaveLength(4);
    for (const r of b) {
      expect(r.x).toBeGreaterThan(1);
      expect(r.x).toBeLessThan(4);
      expect(r.y).toBeGreaterThan(1);
      expect(r.y).toBeLessThan(3);
      expect(r.h).toBeGreaterThan(0.3);
      expect(r.h).toBeLessThanOrEqual(ROCK_MAX_HEIGHT);
    }
  });

  it('places the same boulders every time', () => {
    expect(placeBoulders(map)).toEqual(placeBoulders(map));
  });
});
