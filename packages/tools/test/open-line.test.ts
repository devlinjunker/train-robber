// The open line (packages/mapgen line.ts, ?map=line): built piece by piece so it can grow forever,
// the same on every machine, and a whole run plays on it start to finish. The 200 seeds of map
// checks run in line-seeds-*.test.ts.
import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { resolveMapGen } from '@train-robber/config';
import { generateLine, generateLineTrack, growLine, LINE_MAP_ID } from '@train-robber/mapgen';
import { CONTENT_DIR, readJson } from '../src/content';
import { mapProblems, minRadius } from '../src/maps/checks';
import { lineRunProblems, lineTrafficProblems } from '../src/maps/simChecks';

const defaults = readJson(join(CONTENT_DIR, 'base/map-gen.json'));
const settings = resolveMapGen(defaults);
const sha = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);

describe('the open line grows piece by piece', () => {
  it('always heads east within maxHeadingDeg, so it never crosses itself', () => {
    const maxH = (settings.line.maxHeadingDeg * Math.PI) / 180;
    for (let k = 0; k < 20; k++) {
      let prev: { x: number; y: number } | null = null, n = 0;
      for (const piece of growLine(`grow-${k}`, settings.line, settings.line.widthTiles)) {
        for (const p of piece.points) {
          if (prev) {
            expect(p.x).toBeGreaterThan(prev.x);
            expect(Math.abs(Math.atan2(p.y - prev.y, p.x - prev.x))).toBeLessThanOrEqual(maxH + 1e-9);
          }
          prev = p;
        }
        // Far longer than any map: the generator has no end.
        if (++n > 80) break;
      }
    }
  });

  it('a longer line starts with exactly the samples of a shorter one', () => {
    for (const seed of ['prefix-1', 'prefix-2', 'prefix-3']) {
      const short = generateLineTrack(seed, settings.line, 1000, settings.line.widthTiles).route.samples;
      const long = generateLineTrack(seed, settings.line, 3000, settings.line.widthTiles).route.samples;
      const n = short.x.length;
      expect(long.x.length).toBeGreaterThan(n);
      expect(long.x.slice(0, n)).toEqual(short.x);
      expect(long.y.slice(0, n)).toEqual(short.y);
      expect(long.s.slice(0, n)).toEqual(short.s);
      // The last sample of the shorter line copies the tangent before it; every other one matches.
      expect(long.tx.slice(0, n - 1)).toEqual(short.tx.slice(0, n - 1));
    }
  });
});

describe('open line maps', () => {
  it('run across the map from off one end to off the other, with one or two towns in clearings', () => {
    const { map, info } = generateLine('shape-1', settings);
    expect(map.id).toBe(LINE_MAP_ID);
    expect(map.size).toEqual({ cols: settings.line.lengthTiles, rows: settings.line.widthTiles });
    const r = map.routes[0]!;
    expect(r.closed).toBe(false);
    expect(r.samples.x[0]).toBeLessThan(0);
    expect(r.samples.x.at(-1)).toBeGreaterThan(map.size.cols);
    expect(map.openLine?.headwayTiles).toBe(settings.line.trainHeadwayTiles);
    expect(map.towns!.length).toBeGreaterThanOrEqual(1);
    expect(map.towns!.length).toBeLessThanOrEqual(2);
    expect(info.towns).toBe(map.towns!.length);
    for (const t of map.towns!) expect(map.markers[t.id]).toBeTruthy();
  });

  it('pass the map checks with other lengths, widths, curviness, towns and themes', () => {
    const variants: Record<string, unknown>[] = [
      { line: { lengthTiles: 1200 } }, { line: { lengthTiles: 8000 } }, { line: { widthTiles: 300 } },
      { line: { curviness: 0 } }, { line: { maxHeadingDeg: 75 } }, { line: { pieceTiles: [100, 120] } },
      { line: { towns: { count: [2, 2], minGapTiles: 600 } } }, { line: { swingChance: 1 } },
      ...['forest', 'rocks', 'mesas', 'water', 'mud'].map((t) => ({ mix: { themes: [t], busyness: [0.06, 0.06] } })),
    ];
    const bad: string[] = [];
    for (const v of variants) {
      const s = resolveMapGen(defaults, v);
      for (let k = 0; k < 2; k++) {
        const { map, scenery } = generateLine(`lv-${k}`, s);
        for (const p of mapProblems(map, scenery, minRadius(map))) bad.push(`${JSON.stringify(v)} lv-${k}: ${p}`);
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  }, 180_000);

  it('the checks catch a line whose ends are on the map', () => {
    const { map, scenery } = generateLine('line-0', settings);
    const r = map.routes[0]!;
    const cut = 400;
    const short = { ...map, routes: [{ ...r, length: r.samples.s[r.samples.s.length - cut]!, samples: Object.fromEntries(Object.entries(r.samples).map(([k, v]) => [k, v.slice(cut, -cut)])) as typeof r.samples }] };
    expect(mapProblems(short, scenery, minRadius(short)).join('\n')).toMatch(/starts or ends on the map/);
  });

  it('keep trains running one way: they leave past the end, new ones enter, none touch', () => {
    for (let k = 0; k < 3; k++) {
      const { map } = generateLine(`line-${k}`, settings);
      expect(lineTrafficProblems(map, `line-${k}`), `line-${k}`).toEqual([]);
    }
  }, 120_000);

  it('play a whole run start to finish: approach, commit, board, rob, guards, whistle, extract', () => {
    for (let k = 0; k < 6; k++) {
      const { map } = generateLine(`line-${k}`, settings);
      expect(lineRunProblems(map, `line-${k}`), `line-${k}`).toEqual([]);
    }
  }, 180_000);
});

describe('open lines are deterministic', () => {
  it('the same seed and settings give the same line; another seed gives another', () => {
    const a = generateLine('repeat-me', settings), b = generateLine('repeat-me', settings);
    expect(sha(a.map)).toBe(sha(b.map));
    expect(sha(a.scenery)).toBe(sha(b.scenery));
    expect(generateLine('repeat-me-too', settings).map.source.hash).not.toBe(a.map.source.hash);
  });

  it('a pinned seed still gives the pinned line (bump LINE_GENERATOR_VERSION and update these if the generator changes on purpose)', () => {
    const { map, scenery } = generateLine('pinned-line-1', settings);
    expect(sha(map)).toBe(PINNED.map);
    expect(sha(scenery)).toBe(PINNED.scenery);
  });
});

const PINNED = { map: 'd03c568032ad2abe', scenery: '6890c5bf797b9430' };
