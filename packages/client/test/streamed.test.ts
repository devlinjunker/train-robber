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

  it('made ready ahead of the view in small steps reads the same tiles and heights', () => {
    const s = resolveMapGen(defaults, { line: { lengthTiles: 700, widthTiles: 200 }, mix: { themes: ['mesas'] } });
    const plain = generateLine('stream-mesas', s, { whole: false }), ahead = generateLine('stream-mesas', s, { whole: false });
    const pt = mapTiles(plain.map, plain.scenery), at = mapTiles(ahead.map, ahead.scenery);
    const pf = createHeightField(plain.map, pt), af = createHeightField(ahead.map, at);
    const { cols, rows } = plain.map.size;
    // A whole map decoded at once has nothing to make ready.
    expect(mapTiles(generateLine('stream-mesas', s).map, null).prefetch({ x0: 0, y0: 0, x1: 64, y1: 64 }, () => false)).toBe(true);
    let calls = 0, worst = 0, bad = 0;
    for (let x0 = 0; x0 < cols; x0 += 96) {
      const box = { x0, y0: 0, x1: Math.min(cols, x0 + 96), y1: rows };
      // A few steps a call, as a frame's budget allows, until both say they are ready.
      for (;;) {
        let left = 3;
        const more = () => left-- > 0;
        calls++;
        if (at.prefetch({ x0: box.x0 - 64, y0: box.y0, x1: box.x1 + 64, y1: box.y1 }, more) && af.prefetch(box, more)) break;
        if (calls > 100_000) throw new Error('prefetch never finished');
      }
      // Ready: reading the box builds no more chunks.
      const built = at.stats.built;
      for (let y = 0; y < rows; y += 3) {
        for (let x = box.x0; x < box.x1; x += 3) {
          if (at.zone(x, y) !== pt.zone(x, y) || at.level(x, y) !== pt.level(x, y) || af.plateauOf(x, y) < 0 !== pf.plateauOf(x, y) < 0) bad++;
          const a = af.corners(x, y), b = pf.corners(x, y);
          for (let k = 0; k < 4; k++) worst = Math.max(worst, Math.abs(a[k]! - b[k]!));
        }
      }
      expect(at.stats.built).toBe(built);
    }
    expect(calls).toBeGreaterThan(50);
    expect(bad).toBe(0);
    expect(worst).toBe(0);
  }, 60_000);
});
