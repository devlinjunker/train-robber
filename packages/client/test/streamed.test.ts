// G5: a generated line streamed chunk by chunk (tiles.ts) draws the same ground as the whole map:
// the same zones and levels, the same plateaus and the same heights everywhere.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveMapGen } from '@train-robber/config';
import { generateLine } from '@train-robber/mapgen';
import { mapTiles } from '../src/tiles';
import { createHeightField } from '../src/iso/height';

const defaults = JSON.parse(readFileSync(fileURLToPath(new URL('../../content/base/map-gen.json', import.meta.url)), 'utf8'));

describe('a streamed line', () => {
  // c3: a mesa whose filled ground meets the ground right at one level's step (see fillGround in height.ts).
  for (const [seed, theme, lengthTiles, widthTiles] of [['stream-mesas', 'mesas', 700, 200], ['stream-balanced', 'balanced', 700, 200], ['c3', null, 1200, undefined]] as const) {
    it(`reads the same tiles and heights as the whole map (${seed})`, () => {
      const s = resolveMapGen(defaults, { line: widthTiles ? { lengthTiles, widthTiles } : { lengthTiles }, ...(theme ? { mix: { themes: [theme] } } : {}) });
      const whole = generateLine(seed, s);
      const lazy = generateLine(seed, s, { whole: false });
      const wt = mapTiles(whole.map, whole.scenery), st = mapTiles(lazy.map, lazy.scenery, 12);
      expect(wt.streamed).toBe(false);
      expect(st.streamed).toBe(true);
      const wf = createHeightField(whole.map, wt), sf = createHeightField(lazy.map, st);
      expect(sf.raised).toBe(wf.raised);
      const { cols, rows } = whole.map.size;
      let bad = 0, badForest = 0, badPlateau = 0, worst = 0;
      // Plateaus match one to one: same tiles under each.
      const pair = new Map<number, number>();
      // Chunk columns in a scattered order, so chunks are read out of order and some are dropped and built again.
      const across = Math.ceil(cols / 64);
      for (let n = 0; n < across; n++) for (let x = ((n * 7) % across) * 64; x < Math.min(cols, ((n * 7) % across) * 64 + 64); x++) {
        for (let y = 0; y < rows; y++) {
          if (wt.zone(x, y) !== st.zone(x, y) || wt.level(x, y) !== st.level(x, y)) bad++;
          if (wt.forest(x, y) !== st.forest(x, y)) badForest++;
          const a = wf.plateauOf(x, y), b = sf.plateauOf(x, y);
          if ((a < 0) !== (b < 0)) badPlateau++;
          else if (a >= 0) {
            const was = pair.get(a);
            if (was === undefined) pair.set(a, b); else if (was !== b) badPlateau++;
          }
          const wc = wf.corners(x, y), sc = sf.corners(x, y);
          for (let k = 0; k < 4; k++) worst = Math.max(worst, Math.abs(wc[k]! - sc[k]!));
          worst = Math.max(worst, Math.abs(wf.surfaceZ(x + 0.3, y + 0.6) - sf.surfaceZ(x + 0.3, y + 0.6)));
        }
      }
      expect(bad).toBe(0);
      expect(badForest).toBe(0);
      expect(badPlateau).toBe(0);
      expect(worst).toBeLessThan(1e-4);
      if (theme !== 'balanced') expect(pair.size).toBeGreaterThan(0);
      for (const [a, b] of pair) expect(sf.plateau(b).tiles).toEqual(wf.plateau(a).tiles);
      // Chunks were dropped as the cache filled.
      expect(st.stats.held).toBeLessThanOrEqual(12);
      expect(st.stats.built).toBeGreaterThan(Math.ceil(cols / 64) * Math.ceil(rows / 64));
    }, 60_000);
  }
});
