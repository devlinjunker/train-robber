// Stretches of the open line (G10a, mapGen.line.stretches): the line is cut into named stretches,
// each a profile that changes what grows there, ordered by a seeded director.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { decodeZones, resolveMapGen, ZONES, type MapDef } from '@train-robber/config';
import { generateLine } from '@train-robber/mapgen';
import { CONTENT_DIR, readJson } from '../src/content';
import { mapProblems, minRadius } from '../src/maps/checks';

const defaults = readJson(join(CONTENT_DIR, 'base/map-gen.json'));
const settings = resolveMapGen(defaults);
const OPEN = ZONES.indexOf('open'), DEEP = ZONES.indexOf('deep');

/** Share of open tiles in each stretch's columns. */
function openShare(map: MapDef): Map<string, number> {
  const z = decodeZones(map), { cols, rows } = map.size, out = new Map<string, number>();
  for (const st of map.stretches!) {
    let open = 0, n = 0;
    for (let y = 0; y < rows; y++) for (let x = Math.ceil(st.x0); x < Math.floor(st.x1); x++) { n++; if (z[y * cols + x] === OPEN) open++; }
    out.set(st.id, n ? open / n : 1);
  }
  return out;
}

describe('stretches of the open line', () => {
  it('cover the line end to end, in order, named once each, paced by the director', () => {
    const c = settings.line.stretches;
    for (const seed of ['st-1', 'st-2', 'st-3', 'st-4']) {
      const { map } = generateLine(seed, settings);
      const list = map.stretches!;
      expect(list.length, seed).toBeGreaterThan(3);
      expect(list[0]!.d0).toBe(0);
      expect(list[list.length - 1]!.d1).toBeCloseTo(map.routes[0]!.length, 0);
      expect(new Set(list.map((s) => s.name)).size).toBe(list.length);
      expect(list[0]!.pace).toBe(c.firstPace);
      list.forEach((s, k) => {
        expect(s.x0).toBeLessThan(s.x1);
        expect(s.d1 - s.d0).toBeGreaterThan(c.lengthTiles[0] / 2);
        if (k === 0) return;
        const prev = list[k - 1]!;
        expect(s.d0).toBe(prev.d1);
        expect(s.x0).toBe(prev.x1);
        expect(s.profile).not.toBe(prev.profile);
        if (prev.pace === 'big') expect(s.pace).toBe('quiet');
      });
    }
  });

  it('give open flats far more open land than busy or big stretches', () => {
    const by: Record<string, number[]> = {};
    for (const seed of ['st-1', 'st-2', 'st-3']) {
      const { map } = generateLine(seed, settings);
      const share = openShare(map);
      for (const st of map.stretches!) (by[st.pace] ??= []).push(share.get(st.id)!);
    }
    const mean = (a: number[]) => a.reduce((t, v) => t + v, 0) / a.length;
    expect(mean(by.quiet!)).toBeGreaterThan(0.8);
    expect(mean(by.quiet!) - mean(by.busy!)).toBeGreaterThan(0.2);
    expect(mean(by.quiet!) - mean(by.big!)).toBeGreaterThan(0.2);
  });

  it('lay a river beside the track in a river valley, deep but for its fords, and the line still passes the map checks', () => {
    // Every other stretch a river valley, always with a river beside the track.
    const s = resolveMapGen(defaults, { line: { stretches: { firstPace: '', profiles: {
      flats: { weight: 1 }, broken: { weight: 0 }, timber: { weight: 0 }, mesa: { weight: 0 }, river: { weight: 1, riverBeside: 1 },
    } } } });
    const { map, scenery } = generateLine('st-river', s);
    expect(map.stretches!.some((st) => st.profile === 'river')).toBe(true);
    expect(mapProblems(map, scenery, minRadius(map))).toEqual([]);
    const z = decodeZones(map), { cols } = map.size;
    const route = map.routes[0]!;
    // Deep water within the gap band beside the track along most of each river stretch.
    for (const st of map.stretches!.filter((q) => q.profile === 'river')) {
      let samples = 0, wet = 0;
      for (let i = 0; i < route.samples.x.length; i += 10) {
        const d = i * route.spacing;
        if (d < st.d0 + 60 || d > st.d1 - 60) continue;
        const x = route.samples.x[i]!, y = route.samples.y[i]!, tx = route.samples.tx[i]!, ty = route.samples.ty[i]!;
        if (x < 1 || x >= cols - 1) continue;
        samples++;
        let found = false;
        for (const side of [-1, 1]) {
          for (let g = 14; g <= 36 && !found; g += 0.5) {
            const qx = Math.floor(x - ty * g * side), qy = Math.floor(y + tx * g * side);
            if (qx >= 0 && qy >= 0 && qx < cols && qy < map.size.rows && z[qy * cols + qx] === DEEP) found = true;
          }
        }
        if (found) wet++;
      }
      if (samples) expect(wet / samples, st.name).toBeGreaterThan(0.6);
    }
  }, 60_000);

  it('turned off, the line has none and picks one theme as before', () => {
    const { map } = generateLine('st-1', resolveMapGen(defaults, { line: { stretches: { enabled: false } } }));
    expect(map.stretches).toBeUndefined();
    expect(map.source.file).not.toContain('stretches');
  });

  it('mirror with a west line: same names in the same order along the track, x ranges flipped', () => {
    const east = generateLine('st-west', settings).map, west = generateLine('st-west', resolveMapGen(defaults, { line: { direction: 'west' } })).map;
    const cols = east.size.cols;
    expect(west.stretches!.map((s) => s.name)).toEqual(east.stretches!.map((s) => s.name));
    west.stretches!.forEach((s, k) => {
      const e = east.stretches![k]!;
      expect(s.x0).toBeCloseTo(cols - e.x1, 3);
      expect(s.x1).toBeCloseTo(cols - e.x0, 3);
    });
    for (const map of [east, west]) for (const st of map.stretches!) expect(leftOfTravel(map, st.sign), `${st.name} sign`).toBeGreaterThan(4);
  });
});

/** How far a point is to the left of travel (positive) from the nearest track sample. */
function leftOfTravel(map: MapDef, q: { x: number; y: number }): number {
  const r = map.routes[0]!, sm = r.samples;
  let best = 0, bd = Infinity;
  for (let i = 0; i < sm.x.length; i++) { const d = (sm.x[i]! - q.x) ** 2 + (sm.y[i]! - q.y) ** 2; if (d < bd) { bd = d; best = i; } }
  // y runs down the map, so the left of travel (tx, ty) is (ty, -tx).
  return (q.x - sm.x[best]!) * sm.ty[best]! - (q.y - sm.y[best]!) * sm.tx[best]!;
}
